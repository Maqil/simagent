//! Snapshot test: hour buckets and 5-hour blocks built from every
//! `fixtures/sessions/*.jsonl`, merged as the usage report merges sessions.

// Helpers here are not `#[test]` fns, so `allow-unwrap-in-tests` does not cover them.
#![allow(clippy::unwrap_used)]

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use sim_core::usage::{HourBuckets, five_hour_blocks};
use sim_core::{AgentId, EventKind, SessionId, TranscriptParser};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/sessions")
}

#[test]
fn snapshot_fixture_usage_buckets_and_blocks() {
    let mut paths: Vec<PathBuf> = fs::read_dir(fixtures_dir())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    paths.sort();
    let mut all = HourBuckets::new();
    let mut out = String::from("## buckets per fixture\n");
    for path in paths {
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let mut parser = TranscriptParser::new(SessionId::new(name.as_str()), AgentId::main());
        let mut buckets = HourBuckets::new();
        for line in fs::read_to_string(&path).unwrap().lines() {
            for e in parser.feed_line(line) {
                if let EventKind::UsageReported { model, usage } = &e.kind {
                    buckets.add(e.at, model, false, usage);
                }
            }
        }
        for (k, t) in buckets.iter() {
            writeln!(
                out,
                "{name}: hour={} {} sub={} req={} in={} out={} cr={} cw={} last={} ${:.6}",
                k.hour_ms,
                k.model,
                k.subagent,
                t.requests,
                t.usage.input,
                t.usage.output,
                t.usage.cache_read,
                t.usage.cache_write,
                t.last_ms,
                t.cost.total()
            )
            .unwrap();
        }
        all.merge(&buckets);
    }
    let now = all.iter().map(|(_, t)| t.last_ms).max().unwrap_or(0);
    writeln!(out, "\n## blocks (now = last response)").unwrap();
    for b in five_hour_blocks(all.iter().map(|(k, t)| (k.hour_ms, t)), now) {
        writeln!(
            out,
            "start={} end={} active={} req={} tokens={} last={} ${:.6}",
            b.start_ms,
            b.end_ms,
            b.active,
            b.totals.requests,
            b.totals.usage.total_tokens(),
            b.totals.last_ms,
            b.totals.cost.total()
        )
        .unwrap();
    }
    insta::assert_snapshot!("usage_fixtures", out);
}
