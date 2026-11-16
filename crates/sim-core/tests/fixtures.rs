//! Snapshot tests: parse every `fixtures/sessions/*.jsonl`, fold it into a `SessionState`,
//! and snapshot a compact timeline plus a final-state summary.

// Helpers here are not `#[test]` fns, so `allow-unwrap-in-tests` does not cover them;
// in a test crate a panic is just a test failure.
#![allow(clippy::unwrap_used)]

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use sim_core::{AgentId, Event, EventKind, SessionId, SessionState, TranscriptParser};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/sessions")
}

fn clip(s: &str, max: usize) -> String {
    let first = s.lines().next().unwrap_or_default();
    let mut out: String = first.chars().take(max).collect();
    if first.chars().count() > max || s.lines().nth(1).is_some() {
        out.push('…');
    }
    out
}

/// One-line summary of an event kind (no full tool inputs or outputs).
fn summarize(kind: &EventKind) -> String {
    match kind {
        EventKind::SessionStarted {
            cwd,
            git_branch,
            version,
        } => {
            format!("session_started cwd={cwd:?} branch={git_branch:?} version={version:?}")
        }
        EventKind::Title { title } => format!("title {title:?}"),
        EventKind::MessageSent {
            from,
            to,
            channel,
            text,
        } => format!("message {from} -> {to} ({channel:?}) {:?}", clip(text, 60)),
        EventKind::UserPrompt { text } => format!("user_prompt {:?}", clip(text, 60)),
        EventKind::AssistantText { text } => format!("assistant_text {:?}", clip(text, 60)),
        EventKind::Thinking { text } => format!("thinking ({} chars)", text.chars().count()),
        EventKind::ModelSeen { model } => format!("model_seen {model}"),
        EventKind::UsageReported { model, usage } => format!(
            "usage {model} in={} out={} (thinking={}) cache_read={} cache_write={} (1h={}) ${:.6}",
            usage.input,
            usage.output,
            usage.thinking,
            usage.cache_read,
            usage.cache_write,
            usage.cache_write_1h,
            sim_core::cost::cost_usd(model, usage)
        ),
        EventKind::ToolStarted {
            tool_use_id,
            name,
            tool_kind,
            summary,
            ..
        } => {
            format!(
                "tool_started {tool_use_id} {name} ({tool_kind:?}) {:?}",
                clip(summary, 60)
            )
        }
        EventKind::ToolFinished {
            tool_use_id,
            is_error,
            output,
            duration_ms,
        } => format!(
            "tool_finished {tool_use_id} error={is_error} duration={duration_ms:?} output={:?}",
            clip(output, 40)
        ),
        EventKind::Compacted {
            trigger,
            pre_tokens,
        } => {
            format!("compacted trigger={trigger:?} pre_tokens={pre_tokens:?}")
        }
        EventKind::TurnEnded { duration_ms } => format!("turn_ended duration={duration_ms:?}"),
        EventKind::Error { message } => format!("error {:?}", clip(message, 60)),
        other => format!("{other:?}"),
    }
}

fn render(events: &[Event], state: &SessionState) -> String {
    let t0 = events.first().map_or(0, |e| e.at);
    let mut out = String::from("## timeline\n");
    for e in events {
        writeln!(
            out,
            "+{:>6}ms {:<5} {}",
            e.at - t0,
            e.agent,
            summarize(&e.kind)
        )
        .unwrap();
    }
    writeln!(out, "\n## state").unwrap();
    writeln!(out, "title: {:?}", state.title).unwrap();
    writeln!(out, "cwd: {:?} branch: {:?}", state.cwd, state.git_branch).unwrap();
    writeln!(
        out,
        "events: {} cost: ${:.2}",
        state.event_count, state.cost_usd
    )
    .unwrap();
    for a in state.agents.values() {
        writeln!(
            out,
            "agent {} status={:?} model={:?} tools={} errors={} active={} context={}/{} cost=${:.2}",
            a.id,
            a.status,
            a.model,
            a.tool_calls,
            a.tool_errors,
            a.active_tools.len(),
            a.context_tokens,
            a.context_window,
            a.cost_usd
        )
        .unwrap();
    }
    out
}

#[test]
fn snapshot_fixture_sessions() {
    let mut paths: Vec<PathBuf> = fs::read_dir(fixtures_dir())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "no fixtures found");
    for path in paths {
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let text = fs::read_to_string(&path).unwrap();
        let session = SessionId::new(name.as_str());
        let mut parser = TranscriptParser::new(session.clone(), AgentId::main());
        let events: Vec<Event> = text.lines().flat_map(|l| parser.feed_line(l)).collect();
        let mut state = SessionState::new(session, events.first().map_or(0, |e| e.at));
        for e in &events {
            state.apply(e);
        }
        insta::assert_snapshot!(name, render(&events, &state));
    }
}

/// Smoke test against a real local transcript; not run in CI (`cargo test -- --ignored`).
#[test]
#[ignore = "needs a local real transcript"]
fn parses_real_transcript_without_panicking() {
    // Point SIMAGENT_REAL_TRANSCRIPT at any local Claude Code `.jsonl` to run this.
    let Some(raw) = std::env::var_os("SIMAGENT_REAL_TRANSCRIPT") else {
        eprintln!("skipping: set SIMAGENT_REAL_TRANSCRIPT to a transcript path");
        return;
    };
    let path = Path::new(&raw).to_path_buf();
    let Ok(text) = fs::read_to_string(&path) else {
        eprintln!("skipping: {} not found", path.display());
        return;
    };
    let session = SessionId::new("real");
    let mut parser = TranscriptParser::new(session.clone(), AgentId::main());
    let mut state = SessionState::new(session, 0);
    let mut count = 0usize;
    for line in text.lines() {
        for e in parser.feed_line(line) {
            state.apply(&e);
            count += 1;
        }
    }
    eprintln!("{count} events, cost ${:.2}", state.cost_usd);
    assert!(count > 0);

    // Message counts by channel across the main file and its subagent files.
    let mut channels: BTreeMap<String, usize> = BTreeMap::new();
    let mut tally = |agent: AgentId, text: &str| {
        let mut p = TranscriptParser::new(SessionId::new("real"), agent);
        for e in text.lines().flat_map(|l| p.feed_line(l)) {
            if let EventKind::MessageSent { channel, .. } = e.kind {
                *channels.entry(format!("{channel:?}")).or_default() += 1;
            }
        }
    };
    tally(AgentId::main(), &text);
    let subagents = path.with_extension("").join("subagents");
    for entry in fs::read_dir(&subagents).into_iter().flatten().flatten() {
        let file = entry.path();
        let Some(id) = file
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix("agent-")?.strip_suffix(".jsonl"))
        else {
            continue;
        };
        tally(AgentId::new(id), &fs::read_to_string(&file).unwrap());
    }
    eprintln!("message_sent by channel: {channels:?}");
}
