//! The on-disk session library behind `GET /api/sessions`: every transcript, not just the
//! recent ones the live hub loaded.
//!
//! **Why a cache keyed by (path, mtime, size):** listing reads a little of every
//! transcript (hundreds of files). Most never change between calls, so a summary is
//! reused until the file's mtime or size moves. The cache lives behind a
//! `std::sync::Mutex` that is only locked inside `spawn_blocking`, never across `.await`.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use serde::Deserialize;
use sim_core::SessionId;
use sim_protocol::SessionSummary;

/// Bytes read from the start of a transcript (cwd and early titles live here).
const HEAD_BYTES: u64 = 64 * 1024;
/// Bytes read from the end (the latest `ai-title` is usually near the end).
const TAIL_BYTES: u64 = 256 * 1024;
/// Lines of the head searched for `cwd`.
const CWD_LINES: usize = 32;

/// Cache entry: the summary (with `live` unset) valid for this mtime and size.
#[derive(Debug, Clone)]
struct Cached {
    mtime: Option<SystemTime>,
    size: u64,
    summary: SessionSummary,
}

/// Shared, cloneable summary cache.
#[derive(Debug, Clone, Default)]
pub struct SessionCache(Arc<Mutex<HashMap<PathBuf, Cached>>>);

impl SessionCache {
    /// Lists every `<projects_dir>/<project>/<id>.jsonl`, newest first. `live` marks ids
    /// the hub knows. Blocking: call it from `spawn_blocking`.
    #[must_use]
    pub fn list(&self, projects_dir: &Path, live: &HashSet<SessionId>) -> Vec<SessionSummary> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for path in main_transcripts(projects_dir) {
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let (mtime, size) = (meta.modified().ok(), meta.len());
            let hit = self
                .lock()
                .get(&path)
                .filter(|c| c.mtime == mtime && c.size == size)
                .map(|c| c.summary.clone());
            let mut summary = hit.unwrap_or_else(|| {
                let summary = summarize(&path, mtime, size);
                self.lock().insert(
                    path.clone(),
                    Cached {
                        mtime,
                        size,
                        summary: summary.clone(),
                    },
                );
                summary
            });
            summary.live = live.contains(&summary.id);
            seen.insert(path);
            out.push(summary);
        }
        // Forget deleted transcripts so the cache cannot grow without bound.
        self.lock().retain(|p, _| seen.contains(p));
        out.sort_by_key(|s| std::cmp::Reverse(s.modified_ms));
        out
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Cached>> {
        // A panic while holding the lock leaves a still-valid map; keep using it.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// `<project>/<id>.jsonl` files (one level deep; subagent files live deeper).
fn main_transcripts(projects_dir: &Path) -> Vec<PathBuf> {
    read_dir_paths(projects_dir)
        .iter()
        .filter(|p| p.is_dir())
        .flat_map(|project| read_dir_paths(project))
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl") && p.is_file())
        .collect()
}

fn read_dir_paths(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(Result::ok).map(|e| e.path()).collect())
        .unwrap_or_default()
}

/// Builds the summary of one transcript from its head and tail only.
fn summarize(path: &Path, mtime: Option<SystemTime>, size: u64) -> SessionSummary {
    let id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let project = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_owned();
    let (head, tail) = read_head_tail(path, size).unwrap_or_else(|err| {
        tracing::debug!(%err, path = %path.display(), "could not read transcript for summary");
        (Vec::new(), Vec::new())
    });
    let head = String::from_utf8_lossy(&head);
    let tail = String::from_utf8_lossy(&tail);
    let cwd = head
        .lines()
        .take(CWD_LINES)
        .filter(|l| l.contains("\"cwd\""))
        .find_map(|l| serde_json::from_str::<Probe>(l).ok()?.cwd);
    // Last title wins: search backwards, tail (later in the file) before head.
    let title = head
        .lines()
        .chain(tail.lines())
        .rev()
        .filter(|l| l.contains("ai-title"))
        .filter_map(|l| serde_json::from_str::<Probe>(l).ok())
        .filter(|p| p.kind.as_deref() == Some("ai-title"))
        .find_map(|p| p.ai_title);
    let subagents = crate::ingest::subagent_files(path).len();
    SessionSummary {
        id: SessionId::new(id),
        project,
        cwd,
        title,
        modified_ms: mtime
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .and_then(|d| i64::try_from(d.as_millis()).ok())
            .unwrap_or(0),
        size_bytes: size,
        subagents: u32::try_from(subagents).unwrap_or(u32::MAX),
        live: false,
    }
}

/// The fields of a record we look at. Everything else is ignored.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    #[serde(rename = "type")]
    kind: Option<String>,
    cwd: Option<String>,
    ai_title: Option<String>,
}

/// First [`HEAD_BYTES`] and, for larger files, the last [`TAIL_BYTES`] (not overlapping
/// the head). Lines cut at a boundary simply fail to parse and are skipped.
fn read_head_tail(path: &Path, size: u64) -> std::io::Result<(Vec<u8>, Vec<u8>)> {
    let mut file = File::open(path)?;
    let mut head = Vec::new();
    (&mut file).take(HEAD_BYTES).read_to_end(&mut head)?;
    let mut tail = Vec::new();
    if size > HEAD_BYTES {
        let start = size.saturating_sub(TAIL_BYTES).max(HEAD_BYTES);
        file.seek(SeekFrom::Start(start))?;
        file.take(size - start).read_to_end(&mut tail)?;
    }
    Ok((head, tail))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_from_tail_of_large_file_wins() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let mut text = String::from(
            "{\"type\":\"user\",\"cwd\":\"/w\"}\n{\"type\":\"ai-title\",\"aiTitle\":\"first\"}\n",
        );
        let filler = format!("{{\"type\":\"x\",\"pad\":\"{}\"}}\n", "a".repeat(1000));
        for _ in 0..400 {
            text.push_str(&filler);
        }
        text.push_str("{\"type\":\"ai-title\",\"aiTitle\":\"last\"}\n");
        std::fs::write(proj.join("s1.jsonl"), &text).unwrap();

        let list = SessionCache::default().list(dir.path(), &HashSet::new());
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title.as_deref(), Some("last"));
        assert_eq!(list[0].cwd.as_deref(), Some("/w"));
        assert_eq!(list[0].project, "proj");
        assert!(!list[0].live);
    }

    #[test]
    fn cache_refreshes_when_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("p");
        std::fs::create_dir_all(&proj).unwrap();
        let path = proj.join("s.jsonl");
        std::fs::write(&path, "{\"type\":\"ai-title\",\"aiTitle\":\"a\"}\n").unwrap();
        let cache = SessionCache::default();
        let live: HashSet<SessionId> = [SessionId::new("s")].into();
        let first = cache.list(dir.path(), &live);
        assert_eq!(first[0].title.as_deref(), Some("a"));
        assert!(first[0].live);
        std::fs::write(&path, "{\"type\":\"ai-title\",\"aiTitle\":\"bb\"}\n").unwrap();
        assert_eq!(
            cache.list(dir.path(), &live)[0].title.as_deref(),
            Some("bb")
        );
    }
}
