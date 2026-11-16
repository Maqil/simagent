//! The data behind `GET /api/usage`: token and cost totals over every transcript on disk.
//!
//! **Why incremental:** a real `~/.claude/projects` holds hundreds of transcripts, some of
//! them hundreds of MB. Transcripts are append-only, so per file we remember the byte
//! offset read so far, the file's [`TranscriptParser`] (it holds the message-id dedupe
//! set, so a response streamed across an old and a new chunk is still counted once) and
//! its hour buckets. A call then reads only bytes appended since the last call; an
//! unchanged file costs one `metadata` call. A file that shrank or whose mtime went
//! backwards was rewritten, so it is parsed again from the start.
//!
//! **Why a cheap prefilter:** only assistant records with a `usage` object produce
//! [`EventKind::UsageReported`], and those carry their model on the same record. Lines
//! without the bytes `"usage"` (user prompts, tool results, titles...) are skipped before
//! JSON parsing, which is most of the cost of a cold scan.
//!
//! The cache is a `std::sync::Mutex` locked only inside `spawn_blocking`, never across
//! `.await`. It is held for a whole refresh so two concurrent reports wait for each other
//! instead of both parsing the same new bytes.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use sim_core::usage::{HourBuckets, five_hour_blocks};
use sim_core::{AgentId, EventKind, SessionId, TimestampMs, TranscriptParser};
use sim_protocol::{SessionSummary, SessionUsage, UsageBlock, UsageBucket, UsageReport};

/// Read buffer per file: large sequential reads, one allocation per refresh.
const READ_BUF: usize = 256 * 1024;
/// One day in milliseconds.
const DAY_MS: i64 = 24 * sim_core::usage::HOUR_MS;
/// The bytes every usage-bearing record contains (the key of `message.usage`).
const USAGE_NEEDLE: &str = "\"usage\"";

/// What we remember about one transcript file between calls.
#[derive(Debug)]
struct FileUsage {
    /// Main session the file belongs to (a subagent file belongs to its parent).
    session: SessionId,
    /// Project directory name, used if the session listing lacks this id.
    project: String,
    /// True for `subagents/agent-*.jsonl`.
    subagent: bool,
    /// Agent the parser stamps on events (kept to rebuild the parser on a rewrite).
    agent: AgentId,
    /// Size and mtime when last read completely up to `offset`'s last full line.
    size: u64,
    mtime: Option<SystemTime>,
    /// Bytes consumed: always just past a newline, so a partial last line is reread.
    offset: u64,
    /// Kept across calls for its usage dedupe set.
    parser: TranscriptParser,
    /// Usage of everything read so far.
    buckets: HourBuckets,
}

impl FileUsage {
    fn new(session: SessionId, project: String, subagent: bool, agent: AgentId) -> Self {
        Self {
            parser: TranscriptParser::new(session.clone(), agent.clone()),
            session,
            agent,
            project,
            subagent,
            size: 0,
            mtime: None,
            offset: 0,
            buckets: HourBuckets::new(),
        }
    }

    /// Forgets everything read, for a file that was rewritten.
    fn reset(&mut self) {
        self.parser = TranscriptParser::new(self.session.clone(), self.agent.clone());
        self.buckets = HourBuckets::new();
        self.offset = 0;
    }

    /// Brings the file up to date with what is on disk.
    fn refresh(&mut self, path: &Path, buf: &mut Vec<u8>) {
        let Ok(meta) = std::fs::metadata(path) else {
            return;
        };
        let (size, mtime) = (meta.len(), meta.modified().ok());
        if size == self.size && mtime == self.mtime {
            return;
        }
        // Append-only files only grow, with a later mtime. Anything else is a rewrite.
        let rewritten = size < self.size || mtime < self.mtime || size == self.size;
        if rewritten && self.offset > 0 {
            tracing::debug!(path = %path.display(), "transcript rewritten, reparsing");
            self.reset();
        }
        match self.read_new(path, size, buf) {
            Ok(()) => {
                self.size = size;
                self.mtime = mtime;
            }
            // Keep the old size so the next call sees growth and resumes from `offset`.
            Err(err) => tracing::warn!(%err, path = %path.display(), "could not read transcript"),
        }
    }

    /// Feeds complete lines in `offset..size` to the parser.
    fn read_new(&mut self, path: &Path, size: u64, line: &mut Vec<u8>) -> std::io::Result<()> {
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(self.offset))?;
        // `take` stops at the size we saw, so bytes appended mid-read wait for next call.
        let limit = size.saturating_sub(self.offset);
        let mut reader = BufReader::with_capacity(READ_BUF, file.take(limit));
        loop {
            line.clear();
            let n = reader.read_until(b'\n', line)?;
            // No trailing newline: the writer is mid-line. Leave it for the next call.
            if n == 0 || line.last() != Some(&b'\n') {
                return Ok(());
            }
            self.offset += n as u64;
            self.feed(line);
        }
    }

    fn feed(&mut self, line: &[u8]) {
        let Ok(text) = std::str::from_utf8(line) else {
            tracing::debug!(session = %self.session, "skipping non-UTF-8 transcript line");
            return;
        };
        if !text.contains(USAGE_NEEDLE) {
            return;
        }
        for event in self.parser.feed_line(text) {
            if let EventKind::UsageReported { model, usage } = &event.kind {
                if event.at <= 0 {
                    tracing::debug!(session = %self.session, "skipping usage without a timestamp");
                    continue;
                }
                self.buckets.add(event.at, model, self.subagent, usage);
            }
        }
    }
}

/// Shared, cloneable cache of per-file usage, keyed by transcript path.
#[derive(Debug, Clone, Default)]
pub struct UsageCache(Arc<Mutex<HashMap<PathBuf, FileUsage>>>);

impl UsageCache {
    /// Builds the usage report for the last `days` days ending at `now_ms`.
    ///
    /// `sessions` (from [`crate::sessions::SessionCache::list`]) supplies titles, cwds
    /// and the live flag, joined by session id. Blocking: call it from `spawn_blocking`.
    #[must_use]
    pub fn report(
        &self,
        projects_dir: &Path,
        sessions: &[SessionSummary],
        now_ms: TimestampMs,
        days: u32,
    ) -> UsageReport {
        let since_ms = now_ms.saturating_sub(i64::from(days).saturating_mul(DAY_MS));
        let meta: HashMap<&SessionId, &SessionSummary> =
            sessions.iter().map(|s| (&s.id, s)).collect();

        let mut map = self.lock();
        refresh_all(&mut map, projects_dir);

        // Merge each session's files (main + subagents), keeping only hours in the window.
        let mut per_session: HashMap<&SessionId, (&str, HourBuckets)> = HashMap::new();
        for file in map.values() {
            let (_, buckets) = per_session
                .entry(&file.session)
                .or_insert_with(|| (file.project.as_str(), HourBuckets::new()));
            buckets.merge(&file.buckets);
        }

        let mut all = HourBuckets::new();
        let mut out: Vec<SessionUsage> = Vec::new();
        for (id, (project, buckets)) in per_session {
            let rows: Vec<UsageBucket> = buckets
                .iter()
                .filter(|(k, _)| k.hour_ms >= since_ms)
                .map(|(k, t)| UsageBucket {
                    hour_ms: k.hour_ms,
                    model: k.model.clone(),
                    subagent: k.subagent,
                    requests: t.requests,
                    usage: t.usage,
                    cost: t.cost,
                })
                .collect();
            if rows.is_empty() {
                continue;
            }
            let last_activity_ms = buckets
                .iter()
                .filter(|(k, _)| k.hour_ms >= since_ms)
                .map(|(_, t)| t.last_ms)
                .max()
                .unwrap_or(0);
            all.merge(&buckets);
            let summary = meta.get(id);
            out.push(SessionUsage {
                id: id.clone(),
                project: summary.map_or_else(|| project.to_owned(), |s| s.project.clone()),
                cwd: summary.and_then(|s| s.cwd.clone()),
                title: summary.and_then(|s| s.title.clone()),
                live: summary.is_some_and(|s| s.live),
                last_activity_ms,
                buckets: rows,
            });
        }
        drop(map);
        out.sort_by(|a, b| {
            b.last_activity_ms
                .cmp(&a.last_activity_ms)
                .then_with(|| a.id.cmp(&b.id))
        });

        let hours = all
            .iter()
            .filter(|(k, _)| k.hour_ms >= since_ms)
            .map(|(k, t)| (k.hour_ms, t));
        let blocks = five_hour_blocks(hours, now_ms)
            .into_iter()
            .map(|b| UsageBlock {
                start_ms: b.start_ms,
                end_ms: b.end_ms,
                last_activity_ms: b.totals.last_ms,
                active: b.active,
                requests: b.totals.requests,
                usage: b.totals.usage,
                cost: b.totals.cost,
            })
            .collect();

        UsageReport {
            generated_ms: now_ms,
            since_ms,
            sessions: out,
            blocks,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, FileUsage>> {
        // A panic while holding the lock leaves a still-valid map; keep using it.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Updates every main and subagent transcript, and forgets files that disappeared.
fn refresh_all(map: &mut HashMap<PathBuf, FileUsage>, projects_dir: &Path) {
    let mut buf = Vec::new();
    let mut seen = HashSet::new();
    for main in crate::sessions::main_transcripts(projects_dir) {
        let Some(id) = main.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let session = SessionId::new(id);
        let project = main
            .parent()
            .and_then(Path::file_name)
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_owned();
        let subs = crate::ingest::subagent_files(&main);
        let files = std::iter::once((main, None)).chain(subs.into_iter().map(|p| {
            let agent = p
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.strip_prefix("agent-"))
                .map(AgentId::new);
            (p, agent)
        }));
        for (path, agent) in files {
            let entry = map.entry(path.clone()).or_insert_with(|| {
                let subagent = agent.is_some();
                let agent = agent.unwrap_or_else(AgentId::main);
                FileUsage::new(session.clone(), project.clone(), subagent, agent)
            });
            entry.refresh(&path, &mut buf);
            seen.insert(path);
        }
    }
    map.retain(|p, _| seen.contains(p));
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use super::*;

    /// 2026-11-14T10:00:00Z.
    const T10: i64 = 1_794_650_400_000;

    fn line(id: &str, minute: u32, input: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"2026-11-14T10:{minute:02}:00.000Z","message":{{"id":"{id}","model":"claude-opus-5-5","content":[],"usage":{{"input_tokens":{input},"output_tokens":{output}}}}}}}"#
        ) + "\n"
    }

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let main = proj.join("s1.jsonl");
        (dir, main)
    }

    fn append(path: &Path, text: &str) {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    fn report(cache: &UsageCache, dir: &Path) -> UsageReport {
        cache.report(dir, &[], T10 + 3_600_000, 30)
    }

    fn requests_and_input(r: &UsageReport) -> (u32, u64) {
        r.sessions
            .iter()
            .flat_map(|s| &s.buckets)
            .fold((0, 0), |(n, i), b| (n + b.requests, i + b.usage.input))
    }

    #[test]
    fn totals_match_usage_lines_and_skip_malformed_and_untimed() {
        let (dir, main) = setup();
        let mut text = line("m1", 0, 10, 1) + &line("m2", 5, 20, 2);
        text.push_str("{\"usage\": not json\n");
        text.push_str(r#"{"type":"user","message":{"content":"hi"}}"#);
        text.push('\n');
        // Same message id streamed twice: counted once.
        text.push_str(&line("m2", 6, 20, 2));
        std::fs::write(&main, text).unwrap();
        // A session whose only response has no timestamp is skipped, not bucketed at 0.
        let untimed = main.with_file_name("s2.jsonl");
        std::fs::write(
            &untimed,
            r#"{"type":"assistant","message":{"id":"x","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":5,"output_tokens":5}}}"#.to_owned() + "\n",
        )
        .unwrap();

        let r = report(&UsageCache::default(), dir.path());
        assert_eq!(r.sessions.len(), 1, "untimed-only session dropped");
        let s = &r.sessions[0];
        assert_eq!(s.id.as_str(), "s1");
        assert_eq!(s.project, "proj");
        assert_eq!(requests_and_input(&r), (2, 30));
        assert_eq!(s.buckets[0].hour_ms, T10);
        assert_eq!(s.last_activity_ms, T10 + 5 * 60_000);
        assert_eq!(r.blocks.len(), 1);
        assert!(r.blocks[0].active);
        assert_eq!(r.blocks[0].requests, 2);
    }

    #[test]
    fn appended_lines_are_read_incrementally_without_double_counting() {
        let (dir, main) = setup();
        std::fs::write(&main, line("m1", 0, 10, 1)).unwrap();
        let cache = UsageCache::default();
        assert_eq!(requests_and_input(&report(&cache, dir.path())), (1, 10));
        let offset_after_first = cache.lock()[&main].offset;

        // A full new line, a repeat of m1 (dedupe state survives) and a partial line.
        let partial = line("m3", 9, 300, 3);
        let (head, tail) = partial.split_at(40);
        append(
            &main,
            &(line("m2", 1, 20, 2) + &line("m1", 2, 10, 1) + head),
        );
        assert_eq!(requests_and_input(&report(&cache, dir.path())), (2, 30));
        let offset = cache.lock()[&main].offset;
        assert!(offset > offset_after_first);
        let full = std::fs::metadata(&main).unwrap().len();
        assert_eq!(offset, full - head.len() as u64, "partial line left unread");

        append(&main, tail);
        assert_eq!(requests_and_input(&report(&cache, dir.path())), (3, 330));
    }

    #[test]
    fn rewritten_smaller_file_is_reparsed() {
        let (dir, main) = setup();
        std::fs::write(&main, line("m1", 0, 10, 1) + &line("m2", 1, 20, 2)).unwrap();
        let cache = UsageCache::default();
        assert_eq!(requests_and_input(&report(&cache, dir.path())), (2, 30));
        std::fs::write(&main, line("m9", 0, 7, 1)).unwrap();
        assert_eq!(requests_and_input(&report(&cache, dir.path())), (1, 7));
    }

    #[test]
    fn subagents_count_toward_their_session_and_deleted_files_are_forgotten() {
        let (dir, main) = setup();
        std::fs::write(&main, line("m1", 0, 10, 1)).unwrap();
        let subs = main.with_extension("").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        let sub = subs.join("agent-abc.jsonl");
        std::fs::write(&sub, line("s1", 3, 100, 1)).unwrap();
        let cache = UsageCache::default();
        let r = report(&cache, dir.path());
        assert_eq!(r.sessions.len(), 1);
        let flags: Vec<(bool, u64)> = r.sessions[0]
            .buckets
            .iter()
            .map(|b| (b.subagent, b.usage.input))
            .collect();
        assert_eq!(flags, vec![(false, 10), (true, 100)]);

        std::fs::remove_file(&sub).unwrap();
        assert_eq!(requests_and_input(&report(&cache, dir.path())), (1, 10));
        assert_eq!(cache.lock().len(), 1);
    }

    #[test]
    fn window_filters_old_hours_and_sorts_sessions_by_activity() {
        let (dir, main) = setup();
        std::fs::write(&main, line("m1", 0, 10, 1)).unwrap();
        std::fs::write(main.with_file_name("s2.jsonl"), line("m1", 30, 10, 1)).unwrap();
        let meta = SessionSummary {
            id: SessionId::new("s2"),
            project: "proj".into(),
            cwd: Some("/w".into()),
            title: Some("Second".into()),
            modified_ms: 0,
            size_bytes: 0,
            subagents: 0,
            live: true,
        };
        let cache = UsageCache::default();
        let r = cache.report(dir.path(), &[meta], T10 + 3_600_000, 1);
        let ids: Vec<&str> = r.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["s2", "s1"]);
        assert_eq!(r.sessions[0].title.as_deref(), Some("Second"));
        assert!(r.sessions[0].live);
        assert!(!r.sessions[1].live);

        // Two days later with a one-day window, nothing is left.
        let later = cache.report(dir.path(), &[], T10 + 2 * DAY_MS, 1);
        assert_eq!(later.sessions, Vec::new());
        assert_eq!(later.blocks, Vec::new());
        assert_eq!(later.since_ms, T10 + DAY_MS);
    }

    /// Times a report over the real `~/.claude/projects` (read-only):
    /// `cargo test -p sim-server --release real_usage -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads the local ~/.claude/projects"]
    fn real_usage_report_timing() {
        let dir = crate::config::default_projects_dir();
        let cache = UsageCache::default();
        let now = crate::now_ms();
        for pass in ["first", "second"] {
            let start = std::time::Instant::now();
            let r = cache.report(&dir, &[], now, 365);
            let buckets: usize = r.sessions.iter().map(|s| s.buckets.len()).sum();
            eprintln!(
                "{pass}: {:?}, files={}, sessions={}, buckets={buckets}, blocks={}",
                start.elapsed(),
                cache.lock().len(),
                r.sessions.len(),
                r.blocks.len()
            );
        }
    }
}
