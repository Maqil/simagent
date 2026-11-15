//! `simagent replay <file>`: parse a transcript offline and print its event timeline.
//!
//! Useful to check what sim-core makes of a real session without running the server.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use anyhow::Context;
use sim_core::{AgentId, Event, SessionId, SessionState, TranscriptParser};

/// Parses `file` and writes one line per event, then a short state summary, to stdout.
///
/// # Errors
/// When the file cannot be opened or stdout cannot be written.
pub fn run(file: &Path) -> anyhow::Result<()> {
    let session = SessionId::new(
        file.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("replay"),
    );
    let reader = BufReader::new(
        std::fs::File::open(file).with_context(|| format!("opening {}", file.display()))?,
    );
    let mut parser = TranscriptParser::new(session.clone(), AgentId::main());
    let mut state: Option<SessionState> = None;
    let mut out = std::io::stdout().lock();
    for (n, line) in reader.lines().enumerate() {
        let line = match line {
            Ok(line) => line,
            Err(err) => {
                tracing::warn!(%err, line = n + 1, "skipping unreadable line");
                continue;
            }
        };
        for event in parser.feed_line(&line) {
            let state = state.get_or_insert_with(|| SessionState::new(session.clone(), event.at));
            state.apply(&event);
            writeln!(out, "{}", format_event(&event))?;
        }
    }
    match state {
        Some(s) => writeln!(
            out,
            "-- {} events, {} agents, cost ${:.4}",
            s.event_count,
            s.agents.len(),
            s.cost_usd
        )?,
        None => writeln!(out, "-- no events")?,
    }
    Ok(())
}

fn format_event(event: &Event) -> String {
    let when = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(event.at) * 1_000_000)
        .ok()
        .and_then(|t| {
            t.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_else(|| event.at.to_string());
    // The serialized kind carries the `type` tag plus fields; compact enough for a timeline.
    let kind = serde_json::to_value(&event.kind)
        .map(|v| truncate(&v.to_string(), 200))
        .unwrap_or_default();
    format!("{when} [{}] {kind}", event.agent)
}

fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((idx, _)) => format!("{}…", &s[..idx]),
        None => s.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_respects_char_boundaries() {
        assert_eq!(truncate("héllo", 2), "hé…");
        assert_eq!(truncate("hi", 5), "hi");
    }
}
