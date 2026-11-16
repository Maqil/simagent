//! Transcript discovery and tailing.
//!
//! Claude Code appends one JSON record per line to
//! `<projects>/<project>/<session>.jsonl`, and each subagent writes
//! `<projects>/<project>/<session>/subagents/agent-<id>.jsonl` with a sibling
//! `agent-<id>.meta.json`. The [`Tailer`] remembers a byte offset per file, reads only
//! new bytes, and feeds complete lines to one [`TranscriptParser`] per file.
//!
//! **Why a blocking thread instead of async fs:** all work here is small synchronous file
//! reads plus a `notify` callback (which is itself a plain thread). Running the loop on
//! `spawn_blocking` keeps the code straightforward and never stalls the async runtime.
//! `notify` gives low latency; a 2 s poll catches anything it misses (network drives,
//! dropped events, editors that replace files).

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc as std_mpsc;
use std::time::{Duration, SystemTime};

use notify::{RecursiveMode, Watcher};
use serde::Deserialize;
use sim_core::{
    AgentId, Event, EventKind, SessionId, Source, TimestampMs, ToolUseId, TranscriptParser,
};

use crate::hub::HubHandle;

/// How often the poll fallback runs.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Largest chunk read from one file in one step, so a huge transcript is streamed in
/// pieces instead of loaded at once.
const MAX_READ: u64 = 8 * 1024 * 1024;

/// What a transcript path is, derived from where it sits under the projects dir.
#[derive(Debug, Clone, PartialEq, Eq)]
enum FileKind {
    /// `<project>/<session>.jsonl`.
    Main { session: SessionId },
    /// `<project>/<session>/subagents/agent-<id>.jsonl`.
    Subagent {
        session: SessionId,
        agent: AgentId,
        meta: PathBuf,
    },
}

/// The subset of `agent-<id>.meta.json` we use. Unknown fields are ignored.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubagentMeta {
    agent_type: Option<String>,
    description: Option<String>,
    tool_use_id: Option<String>,
    #[serde(default)]
    finished: bool,
}

/// Extra state kept for subagent files.
#[derive(Debug)]
struct SubState {
    meta: PathBuf,
    meta_mtime: Option<SystemTime>,
    finished_sent: bool,
}

/// Per-file tail state.
#[derive(Debug)]
struct TailedFile {
    session: SessionId,
    agent: AgentId,
    offset: u64,
    /// Bytes after the last `\n`, waiting for the rest of the line.
    partial: Vec<u8>,
    parser: TranscriptParser,
    sub: Option<SubState>,
}

/// Owns the tail state of every tracked transcript. All methods return the events they
/// produced, so the logic is testable without a hub or a runtime.
#[derive(Debug)]
pub struct Tailer {
    projects_dir: PathBuf,
    /// How many of the most recent sessions [`Tailer::initial_scan`] loads.
    startup_sessions: usize,
    /// Files modified after this are active sessions and are picked up by [`Tailer::scan`].
    started: SystemTime,
    files: HashMap<PathBuf, TailedFile>,
}

impl Tailer {
    /// Creates a tailer for `projects_dir`. At startup it loads the `startup_sessions` most
    /// recently modified sessions; after that, any session that changes is picked up.
    #[must_use]
    pub fn new(projects_dir: PathBuf, startup_sessions: usize) -> Self {
        Self {
            projects_dir,
            startup_sessions,
            started: SystemTime::now(),
            files: HashMap::new(),
        }
    }

    /// Loads the `startup_sessions` most recently modified sessions (main transcript plus
    /// its subagents). Older sessions load on demand ([`IngestHandle::open`]) or when they
    /// change.
    pub fn initial_scan(&mut self) -> Vec<Event> {
        let mut mains: Vec<(SystemTime, PathBuf)> = self
            .list_transcripts()
            .into_iter()
            .filter(|p| matches!(self.classify(p), Some(FileKind::Main { .. })))
            .filter_map(|p| Some((modified(&p)?, p)))
            .collect();
        // Newest first; ties broken by path so the choice is deterministic.
        mains.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        let mut events = Vec::new();
        for (_, main) in mains.into_iter().take(self.startup_sessions) {
            events.extend(self.open_paths(&main));
        }
        events
    }

    /// Starts tracking one session: its main transcript first, then every subagent.
    fn open_paths(&mut self, main: &Path) -> Vec<Event> {
        let mut events = self.poke(main);
        for sub in subagent_files(main) {
            events.extend(self.poke(&sub));
        }
        events
    }

    /// Number of files currently tracked.
    #[must_use]
    pub fn tracked(&self) -> usize {
        self.files.len()
    }

    /// Lists candidate transcripts, starts tracking ones that changed since startup and
    /// reads new bytes from every tracked file. The poll fallback for missed notifications.
    pub fn scan(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        for path in self.list_transcripts() {
            if self.files.contains_key(&path) || self.changed_since_start(&path) {
                events.extend(self.poke(&path));
            }
        }
        // Re-check subagent metas (for `finished: true`) even when the jsonl didn't grow.
        let subs: Vec<PathBuf> = self
            .files
            .iter()
            .filter(|(_, f)| f.sub.as_ref().is_some_and(|s| !s.finished_sent))
            .map(|(p, _)| p.clone())
            .collect();
        for path in subs {
            events.extend(self.check_meta(&path));
        }
        events
    }

    /// Handles a change notification for `path` (a transcript or a subagent meta file).
    /// A transcript that is not tracked yet starts being tracked: it just changed, so it is
    /// active, whether or not it was loaded at startup.
    pub fn poke(&mut self, path: &Path) -> Vec<Event> {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if let Some(stem) = name.strip_suffix(".meta.json") {
            let jsonl = path.with_file_name(format!("{stem}.jsonl"));
            return self.check_meta(&jsonl);
        }
        if !Path::new(name)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
        {
            return Vec::new();
        }
        let mut events = Vec::new();
        if !self.files.contains_key(path) {
            let Some(kind) = self.classify(path) else {
                return events;
            };
            events.extend(self.start_tracking(path, kind));
        }
        events.extend(self.read_new(path));
        events.extend(self.check_meta(path));
        events
    }

    fn start_tracking(&mut self, path: &Path, kind: FileKind) -> Vec<Event> {
        let (session, agent, sub) = match kind {
            FileKind::Main { session } => (session, AgentId::main(), None),
            FileKind::Subagent {
                session,
                agent,
                meta,
            } => (
                session,
                agent,
                Some(SubState {
                    meta,
                    meta_mtime: None,
                    finished_sent: false,
                }),
            ),
        };
        tracing::debug!(path = %path.display(), session = %session, agent = %agent, "tracking transcript");
        let mut events = Vec::new();
        if let Some(sub) = &sub {
            // Announce the child before any of its own events so the state machine knows
            // its parent. Time: the first record's timestamp, so the spawn sorts just before
            // the child's events (the file mtime is when it *last* changed).
            let meta = read_meta(&sub.meta).unwrap_or_default();
            events.push(Event {
                session: session.clone(),
                agent: AgentId::main(),
                at: first_record_ms(path)
                    .or_else(|| mtime_ms(path))
                    .unwrap_or_else(crate::now_ms),
                source: Source::Transcript,
                kind: EventKind::SubagentSpawned {
                    child: agent.clone(),
                    agent_type: meta.agent_type,
                    description: meta.description,
                    tool_use_id: meta.tool_use_id.map(ToolUseId::new),
                },
            });
        }
        self.files.insert(
            path.to_path_buf(),
            TailedFile {
                parser: TranscriptParser::new(session.clone(), agent.clone()),
                session,
                agent,
                offset: 0,
                partial: Vec::new(),
                sub,
            },
        );
        events
    }

    /// Reads bytes appended since the last offset and parses complete lines.
    fn read_new(&mut self, path: &Path) -> Vec<Event> {
        let Some(file) = self.files.get_mut(path) else {
            return Vec::new();
        };
        let mut events = Vec::new();
        loop {
            match read_chunk(path, file.offset) {
                Ok(ReadOutcome::Truncated) => {
                    tracing::warn!(path = %path.display(), "transcript shrank; re-reading from start");
                    file.offset = 0;
                    file.partial.clear();
                    file.parser = TranscriptParser::new(file.session.clone(), file.agent.clone());
                }
                Ok(ReadOutcome::Bytes(bytes)) => {
                    if bytes.is_empty() {
                        break;
                    }
                    let n = bytes.len() as u64;
                    file.offset += n;
                    events.extend(feed_bytes(&mut file.partial, &mut file.parser, &bytes));
                    if n < MAX_READ {
                        break;
                    }
                }
                Err(err) => {
                    tracing::warn!(%err, path = %path.display(), "could not read transcript");
                    break;
                }
            }
        }
        events
    }

    /// Emits `SubagentFinished` once, when the meta file says `finished: true`.
    fn check_meta(&mut self, jsonl: &Path) -> Vec<Event> {
        let Some(file) = self.files.get_mut(jsonl) else {
            return Vec::new();
        };
        let Some(sub) = file.sub.as_mut() else {
            return Vec::new();
        };
        if sub.finished_sent {
            return Vec::new();
        }
        let mtime = std::fs::metadata(&sub.meta).and_then(|m| m.modified()).ok();
        if mtime.is_none() || mtime == sub.meta_mtime {
            return Vec::new();
        }
        sub.meta_mtime = mtime;
        let Some(meta) = read_meta(&sub.meta) else {
            return Vec::new();
        };
        if !meta.finished {
            return Vec::new();
        }
        sub.finished_sent = true;
        vec![Event {
            session: file.session.clone(),
            agent: AgentId::main(),
            at: mtime.and_then(system_time_ms).unwrap_or_else(crate::now_ms),
            source: Source::Transcript,
            kind: EventKind::SubagentFinished {
                child: file.agent.clone(),
            },
        }]
    }

    fn changed_since_start(&self, path: &Path) -> bool {
        modified(path).is_some_and(|t| t >= self.started)
    }

    /// Classifies a path under the projects dir; `None` for anything we don't tail.
    fn classify(&self, path: &Path) -> Option<FileKind> {
        let rel = path.strip_prefix(&self.projects_dir).ok()?;
        let parts: Vec<&str> = rel.iter().filter_map(|c| c.to_str()).collect();
        match parts.as_slice() {
            [_project, file] => Some(FileKind::Main {
                session: SessionId::new(file.strip_suffix(".jsonl")?),
            }),
            [_project, session, "subagents", file] => {
                let id = file.strip_prefix("agent-")?.strip_suffix(".jsonl")?;
                Some(FileKind::Subagent {
                    session: SessionId::new(*session),
                    agent: AgentId::new(id),
                    meta: path.with_file_name(format!("agent-{id}.meta.json")),
                })
            }
            _ => None,
        }
    }

    /// All `*.jsonl` files at the two known depths. Unreadable dirs are skipped.
    fn list_transcripts(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for project in read_dir_paths(&self.projects_dir) {
            for entry in read_dir_paths(&project) {
                if entry.extension().is_some_and(|e| e == "jsonl") {
                    out.push(entry);
                } else if entry.is_dir() {
                    out.extend(
                        read_dir_paths(&entry.join("subagents"))
                            .into_iter()
                            .filter(|p| p.extension().is_some_and(|e| e == "jsonl")),
                    );
                }
            }
        }
        out
    }
}

/// Splits `bytes` into lines, prepending any partial line from last time and keeping the
/// new trailing partial. Only `\n`-terminated lines are parsed: a half-written record
/// would otherwise be rejected as malformed JSON.
fn feed_bytes(partial: &mut Vec<u8>, parser: &mut TranscriptParser, bytes: &[u8]) -> Vec<Event> {
    partial.extend_from_slice(bytes);
    let Some(last_nl) = partial.iter().rposition(|&b| b == b'\n') else {
        return Vec::new();
    };
    let rest = partial.split_off(last_nl + 1);
    let complete = std::mem::replace(partial, rest);
    complete
        .split(|&b| b == b'\n')
        .map(String::from_utf8_lossy)
        .map(|line| line.trim_end_matches('\r').to_owned())
        .filter(|line| !line.trim().is_empty())
        .flat_map(|line| parser.feed_line(&line))
        .collect()
}

enum ReadOutcome {
    Bytes(Vec<u8>),
    Truncated,
}

fn read_chunk(path: &Path, offset: u64) -> std::io::Result<ReadOutcome> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    if len < offset {
        return Ok(ReadOutcome::Truncated);
    }
    let want = (len - offset).min(MAX_READ);
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::with_capacity(usize::try_from(want).unwrap_or(0));
    f.take(want).read_to_end(&mut buf)?;
    Ok(ReadOutcome::Bytes(buf))
}

fn read_meta(path: &Path) -> Option<SubagentMeta> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(meta) => Some(meta),
        Err(err) => {
            tracing::debug!(%err, path = %path.display(), "unreadable subagent meta");
            None
        }
    }
}

fn read_dir_paths(dir: &Path) -> Vec<PathBuf> {
    match std::fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(Result::ok).map(|e| e.path()).collect(),
        Err(err) => {
            tracing::trace!(%err, dir = %dir.display(), "skipping directory");
            Vec::new()
        }
    }
}

/// Timestamp of the first record in a transcript that has one, reading at most 64 KB.
fn first_record_ms(path: &Path) -> Option<TimestampMs> {
    use std::io::Read as _;
    let mut buf = Vec::with_capacity(64 * 1024);
    std::fs::File::open(path)
        .ok()?
        .take(64 * 1024)
        .read_to_end(&mut buf)
        .ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut parser = TranscriptParser::new(SessionId::new("probe"), AgentId::main());
    text.lines()
        .flat_map(|line| parser.feed_line(line))
        .map(|e| e.at)
        .find(|&at| at > 0)
}

/// When `path` was last modified; `None` if it can't be read.
fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn mtime_ms(path: &Path) -> Option<TimestampMs> {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(system_time_ms)
}

fn system_time_ms(t: SystemTime) -> Option<TimestampMs> {
    let ms = t.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_millis();
    TimestampMs::try_from(ms).ok()
}

/// Most events [`load_session_events`] returns; a pathological session is truncated.
pub const MAX_REPLAY_EVENTS: usize = 200_000;

/// Why [`load_session_events`] could not load a session.
#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    /// The id has characters outside `[A-Za-z0-9-]` (or is empty / too long), so it could
    /// smuggle a path. Rejected before touching the filesystem.
    #[error("invalid session id")]
    InvalidId,
    /// No `<project>/<id>.jsonl` exists under the projects dir.
    #[error("session not found")]
    NotFound,
    /// The main transcript exists but could not be read.
    #[error("reading {path}: {source}")]
    Io {
        /// File being read.
        path: PathBuf,
        /// Underlying error.
        source: std::io::Error,
    },
}

/// Session ids are UUIDs; anything else (dots, slashes) is refused so the id can be
/// joined onto a path safely.
#[must_use]
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Finds `<projects_dir>/<project>/<id>.jsonl`. The id must already be validated.
#[must_use]
pub fn find_transcript(projects_dir: &Path, id: &str) -> Option<PathBuf> {
    let file = format!("{id}.jsonl");
    read_dir_paths(projects_dir)
        .into_iter()
        .map(|project| project.join(&file))
        .find(|p| p.is_file())
}

/// Every subagent transcript of the session whose main transcript is `main`.
#[must_use]
pub fn subagent_files(main: &Path) -> Vec<PathBuf> {
    let dir = main.with_extension("").join("subagents");
    read_dir_paths(&dir)
        .into_iter()
        .filter(|p| {
            p.extension().is_some_and(|e| e == "jsonl")
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("agent-"))
        })
        .collect()
}

/// Loads the full history of one session from disk, independent of the live hub.
///
/// The main transcript and every subagent transcript are parsed from the start. Each
/// subagent contributes `SubagentSpawned` (from its meta file, stamped with its first
/// event's time) before its own events, and `SubagentFinished` at its last event's time
/// when the meta says `finished: true`. All events are then stable-sorted by `at`, so
/// equal timestamps keep that per-file order. At most [`MAX_REPLAY_EVENTS`] are returned.
///
/// Blocking: call it from `spawn_blocking`.
///
/// # Errors
/// [`LoadError::InvalidId`] for an unsafe id, [`LoadError::NotFound`] when no transcript
/// exists, [`LoadError::Io`] when the main transcript cannot be read. Unreadable subagent
/// files are logged and skipped.
pub fn load_session_events(projects_dir: &Path, session_id: &str) -> Result<Vec<Event>, LoadError> {
    if !valid_session_id(session_id) {
        return Err(LoadError::InvalidId);
    }
    let main = find_transcript(projects_dir, session_id).ok_or(LoadError::NotFound)?;
    let session = SessionId::new(session_id);
    let mut events = parse_whole_file(
        &main,
        TranscriptParser::new(session.clone(), AgentId::main()),
    )
    .map_err(|source| LoadError::Io {
        path: main.clone(),
        source,
    })?;
    for path in subagent_files(&main) {
        let Some(id) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix("agent-"))
            .and_then(|n| n.strip_suffix(".jsonl"))
        else {
            continue;
        };
        let agent = AgentId::new(id);
        let sub_events = match parse_whole_file(
            &path,
            TranscriptParser::new(session.clone(), agent.clone()),
        ) {
            Ok(evs) => evs,
            Err(err) => {
                tracing::warn!(%err, path = %path.display(), "skipping unreadable subagent transcript");
                continue;
            }
        };
        let meta =
            read_meta(&path.with_file_name(format!("agent-{id}.meta.json"))).unwrap_or_default();
        let fallback = || mtime_ms(&path).unwrap_or_else(crate::now_ms);
        let first_at = sub_events
            .iter()
            .map(|e| e.at)
            .min()
            .unwrap_or_else(fallback);
        let last_at = sub_events
            .iter()
            .map(|e| e.at)
            .max()
            .unwrap_or_else(fallback);
        events.push(Event {
            session: session.clone(),
            agent: AgentId::main(),
            at: first_at,
            source: Source::Transcript,
            kind: EventKind::SubagentSpawned {
                child: agent.clone(),
                agent_type: meta.agent_type,
                description: meta.description,
                tool_use_id: meta.tool_use_id.map(ToolUseId::new),
            },
        });
        events.extend(sub_events);
        if meta.finished {
            events.push(Event {
                session: session.clone(),
                agent: AgentId::main(),
                at: last_at,
                source: Source::Transcript,
                kind: EventKind::SubagentFinished { child: agent },
            });
        }
    }
    // `sort_by_key` is stable: spawn stays before the child's first event at equal `at`.
    events.sort_by_key(|e| e.at);
    events.truncate(MAX_REPLAY_EVENTS);
    Ok(events)
}

/// Parses a whole transcript in [`MAX_READ`] chunks. A final line without `\n` is
/// parsed too: the file is read as a finished document, not tailed.
fn parse_whole_file(path: &Path, mut parser: TranscriptParser) -> std::io::Result<Vec<Event>> {
    let mut file = File::open(path)?;
    let mut partial = Vec::new();
    let mut events = Vec::new();
    let mut buf = vec![0u8; usize::try_from(MAX_READ).unwrap_or(1 << 20)];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        events.extend(feed_bytes(&mut partial, &mut parser, &buf[..n]));
    }
    if !partial.iter().all(u8::is_ascii_whitespace) {
        partial.push(b'\n');
        events.extend(feed_bytes(&mut partial, &mut parser, &[]));
    }
    Ok(events)
}

/// Starts the ingest loop on a blocking thread: initial scan, then `notify` events plus
/// the poll fallback. Returns immediately.
/// Lets the rest of the server ask the ingest thread to load a session on demand.
///
/// It sends the session's transcript paths down the same channel the file watcher uses,
/// so an opened session goes through [`Tailer::poke`] exactly like a changed file: one
/// code path reads transcripts, on one thread, with no locking.
#[derive(Debug, Clone)]
pub struct IngestHandle {
    projects_dir: PathBuf,
    tx: std_mpsc::Sender<PathBuf>,
}

impl IngestHandle {
    /// Asks the ingest thread to start tailing session `id` (main transcript and
    /// subagents). Its events then reach the browser through the hub like any other.
    ///
    /// Blocking (lists a directory): call it from `spawn_blocking`.
    ///
    /// # Errors
    /// [`LoadError::InvalidId`] for an unsafe id, [`LoadError::NotFound`] when no
    /// transcript exists or the ingest thread has stopped.
    pub fn open(&self, id: &str) -> Result<(), LoadError> {
        if !valid_session_id(id) {
            return Err(LoadError::InvalidId);
        }
        let main = find_transcript(&self.projects_dir, id).ok_or(LoadError::NotFound)?;
        let subs = subagent_files(&main);
        // Main first, so subagents attach to a session that already exists.
        for path in std::iter::once(main).chain(subs) {
            self.tx.send(path).map_err(|_| LoadError::NotFound)?;
        }
        Ok(())
    }
}

/// Starts the ingest thread: loads the `startup_sessions` most recent sessions, then
/// follows file changes. Returns the handle used to open more sessions on demand.
#[must_use]
pub fn spawn(hub: HubHandle, projects_dir: PathBuf, startup_sessions: usize) -> IngestHandle {
    let (tx, rx) = std_mpsc::channel::<PathBuf>();
    let handle = IngestHandle {
        projects_dir: projects_dir.clone(),
        tx: tx.clone(),
    };
    tokio::task::spawn_blocking(move || run(&hub, projects_dir, startup_sessions, tx, &rx));
    handle
}

fn run(
    hub: &HubHandle,
    projects_dir: PathBuf,
    startup_sessions: usize,
    tx: std_mpsc::Sender<PathBuf>,
    rx: &std_mpsc::Receiver<PathBuf>,
) {
    // Keep the watcher alive for the whole loop; dropping it stops notifications.
    let _watcher = start_watcher(&projects_dir, tx);
    let mut tailer = Tailer::new(projects_dir, startup_sessions);

    let initial = tailer.initial_scan();
    tracing::info!(
        files = tailer.tracked(),
        events = initial.len(),
        "initial transcript scan done"
    );
    if hub.ingest_blocking(initial).is_err() {
        return;
    }
    loop {
        let events = match rx.recv_timeout(POLL_INTERVAL) {
            Ok(path) => {
                let mut events = tailer.poke(&path);
                // Drain a burst of notifications in one go.
                while let Ok(path) = rx.try_recv() {
                    events.extend(tailer.poke(&path));
                }
                events
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => tailer.scan(),
            // The watcher is gone (failed to start): keep polling.
            Err(std_mpsc::RecvTimeoutError::Disconnected) => {
                std::thread::sleep(POLL_INTERVAL);
                tailer.scan()
            }
        };
        if hub.ingest_blocking(events).is_err() {
            tracing::debug!("hub stopped; ingest exiting");
            return;
        }
    }
}

fn start_watcher(dir: &Path, tx: std_mpsc::Sender<PathBuf>) -> Option<notify::RecommendedWatcher> {
    let handler = move |res: notify::Result<notify::Event>| match res {
        Ok(event) => {
            for path in event.paths {
                let _ = tx.send(path);
            }
        }
        Err(err) => tracing::debug!(%err, "watch error"),
    };
    let mut watcher = match notify::recommended_watcher(handler) {
        Ok(w) => w,
        Err(err) => {
            tracing::warn!(%err, "file watcher unavailable; polling only");
            return None;
        }
    };
    if let Err(err) = watcher.watch(dir, RecursiveMode::Recursive) {
        tracing::warn!(%err, dir = %dir.display(), "cannot watch projects dir; polling only");
        return None;
    }
    Some(watcher)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn partial_lines_wait_for_newline() {
        let mut parser = TranscriptParser::new(SessionId::new("s"), AgentId::main());
        let mut partial = Vec::new();
        feed_bytes(&mut partial, &mut parser, b"{\"a\":1}\n{\"b\":");
        assert_eq!(partial, b"{\"b\":");
        feed_bytes(&mut partial, &mut parser, b"2}\n");
        assert_eq!(partial.len(), 0);
        feed_bytes(&mut partial, &mut parser, b"no newline yet");
        assert_eq!(partial, b"no newline yet");
    }

    #[test]
    fn tailer_tracks_offsets_and_buffers_partial_lines() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let path = proj.join("sess-1.jsonl");
        let mut f = File::create(&path).unwrap();
        f.write_all(b"{\"type\":\"user\"}\n{\"type\":").unwrap();
        f.flush().unwrap();

        let mut tailer = Tailer::new(dir.path().to_path_buf(), 10);
        tailer.initial_scan();
        assert_eq!(tailer.tracked(), 1);
        let state = &tailer.files[&path];
        assert_eq!(state.session, SessionId::new("sess-1"));
        assert_eq!(state.offset, 24);
        assert_eq!(state.partial, b"{\"type\":");

        f.write_all(b"\"assistant\"}\n").unwrap();
        f.flush().unwrap();
        tailer.poke(&path);
        let state = &tailer.files[&path];
        assert_eq!(state.offset, 37);
        assert_eq!(state.partial.len(), 0);
    }

    /// Writes `<proj>/<id>.jsonl` with its mtime `age_s` seconds in the past.
    fn session_file(proj: &Path, id: &str, age_s: u64) -> PathBuf {
        let path = proj.join(format!("{id}.jsonl"));
        std::fs::write(&path, b"{}\n").unwrap();
        let file = File::options().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(age_s))
            .unwrap();
        path
    }

    #[test]
    fn startup_loads_only_the_most_recent_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        // s1 is the newest, s5 the oldest.
        let paths: Vec<PathBuf> = (1..=5)
            .map(|i| session_file(&proj, &format!("s{i}"), i * 600))
            .collect();
        // A subagent of the newest session comes along with it.
        let subs = proj.join("s1").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        std::fs::write(subs.join("agent-x.jsonl"), b"").unwrap();

        let mut tailer = Tailer::new(dir.path().to_path_buf(), 3);
        tailer.initial_scan();
        assert_eq!(tailer.tracked(), 4, "3 sessions plus one subagent");
        for (i, p) in paths.iter().enumerate() {
            assert_eq!(tailer.files.contains_key(p), i < 3, "s{}", i + 1);
        }
        // Old, unchanged sessions are not picked up by the poll fallback either.
        tailer.scan();
        assert_eq!(tailer.tracked(), 4);
        // ...but one that changes after startup is.
        std::fs::write(&paths[4], b"{}\n{}\n").unwrap();
        let file = File::options().write(true).open(&paths[4]).unwrap();
        file.set_modified(SystemTime::now() + Duration::from_secs(5))
            .unwrap();
        tailer.scan();
        assert!(tailer.files.contains_key(&paths[4]));
    }

    #[test]
    fn open_sends_main_then_subagents_and_rejects_bad_ids() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let main = session_file(&proj, "old-1", 86_400);
        let subs = proj.join("old-1").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        std::fs::write(subs.join("agent-a.jsonl"), b"").unwrap();

        let (tx, rx) = std_mpsc::channel();
        let handle = IngestHandle {
            projects_dir: dir.path().to_path_buf(),
            tx,
        };
        handle.open("old-1").unwrap();
        let sent: Vec<PathBuf> = rx.try_iter().collect();
        assert_eq!(sent, [main.clone(), subs.join("agent-a.jsonl")]);

        assert!(matches!(handle.open("../etc"), Err(LoadError::InvalidId)));
        assert!(matches!(handle.open("missing"), Err(LoadError::NotFound)));

        // What the ingest thread then does with those paths: an old session loads.
        let mut tailer = Tailer::new(dir.path().to_path_buf(), 0);
        for p in &sent {
            tailer.poke(p);
        }
        assert_eq!(tailer.tracked(), 2);
    }

    #[test]
    fn subagent_spawn_then_finish_once() {
        let dir = tempfile::tempdir().unwrap();
        let subs = dir.path().join("proj").join("sess-9").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        std::fs::write(subs.join("agent-abc.jsonl"), b"").unwrap();
        let meta = subs.join("agent-abc.meta.json");
        std::fs::write(
            &meta,
            br#"{"agentType":"Explore","description":"look","toolUseId":"toolu_1","extra":1}"#,
        )
        .unwrap();

        let mut tailer = Tailer::new(dir.path().to_path_buf(), 10);
        let events = tailer.poke(&subs.join("agent-abc.jsonl"));
        let spawned: Vec<_> = events
            .iter()
            .filter(|e| matches!(e.kind, EventKind::SubagentSpawned { .. }))
            .collect();
        assert_eq!(spawned.len(), 1);
        assert_eq!(spawned[0].session, SessionId::new("sess-9"));
        assert_eq!(spawned[0].agent, AgentId::main());
        assert!(matches!(
            &spawned[0].kind,
            EventKind::SubagentSpawned { child, agent_type: Some(t), tool_use_id: Some(_), .. }
                if child.as_str() == "abc" && t == "Explore"
        ));

        // Rewrite meta as finished; make sure mtime differs.
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&meta, br#"{"agentType":"Explore","finished":true}"#).unwrap();
        let file = File::options().write(true).open(&meta).unwrap();
        file.set_modified(SystemTime::now() + Duration::from_secs(5))
            .unwrap();
        let finished = tailer.poke(&meta);
        assert!(matches!(
            finished.as_slice(),
            [Event {
                kind: EventKind::SubagentFinished { .. },
                ..
            }]
        ));
        assert_eq!(tailer.scan().len(), 0);
    }

    #[test]
    fn unreadable_paths_do_not_panic() {
        let mut tailer = Tailer::new(PathBuf::from("/nonexistent/simagent"), 10);
        assert_eq!(tailer.scan().len(), 0);
        let poked = tailer.poke(Path::new("/nonexistent/simagent/p/x.jsonl"));
        assert_eq!(poked.len(), 0);
    }
}
