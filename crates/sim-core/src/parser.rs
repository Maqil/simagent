//! Tolerant transcript parser: one JSONL line in, zero or more [`Event`]s out.
//!
//! Claude Code writes one JSON object per line. The format is undocumented and grows new
//! record types and fields often, so the parser navigates [`serde_json::Value`] with
//! `.get()` instead of deserializing strict structs: anything unknown is simply ignored.

use std::collections::HashSet;

use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::event::{Event, EventKind, MessageChannel, Source, TimestampMs, ToolKind, Usage};
use crate::ids::{AgentId, SessionId, ToolUseId};

/// Maximum bytes of tool output kept on a [`EventKind::ToolFinished`] event.
const MAX_OUTPUT_BYTES: usize = 4096;
/// Maximum bytes of text kept on a [`EventKind::MessageSent`] event.
const MAX_MESSAGE_BYTES: usize = 8192;
/// Maximum characters in a one-line tool summary.
const MAX_SUMMARY_CHARS: usize = 120;
/// Placeholder model id Claude Code uses for locally generated (non-API) messages.
const SYNTHETIC_MODEL: &str = "<synthetic>";

/// Stateful parser for one transcript file (the main session file or one subagent file).
///
/// State is needed to dedupe usage across streamed assistant chunks that share a message id.
#[derive(Debug)]
pub struct TranscriptParser {
    session: SessionId,
    agent: AgentId,
    /// Timestamp of the last record that had one; reused by records without a timestamp.
    last_at: TimestampMs,
    /// Whether `SessionStarted` was already emitted.
    started: bool,
    /// Last emitted title, to emit `Title` only on change.
    title: Option<String>,
    /// Last emitted model, to emit `ModelSeen` only on change.
    model: Option<String>,
    /// Assistant message ids whose usage was already reported.
    usage_ids: HashSet<String>,
    /// Whether a subagent's first prompt (its dispatch from the parent) was already seen.
    dispatched: bool,
}

impl TranscriptParser {
    /// Creates a parser for `agent` in `session`.
    #[must_use]
    pub fn new(session: SessionId, agent: AgentId) -> Self {
        Self {
            session,
            agent,
            last_at: 0,
            started: false,
            title: None,
            model: None,
            usage_ids: HashSet::new(),
            dispatched: false,
        }
    }

    /// Parses one line. Malformed or unknown lines yield no events (and a `tracing` debug log).
    pub fn feed_line(&mut self, line: &str) -> Vec<Event> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let record: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(err) => {
                tracing::debug!(session = %self.session, %err, "skipping malformed transcript line");
                return Vec::new();
            }
        };
        if !record.is_object() {
            tracing::debug!(session = %self.session, "skipping non-object transcript line");
            return Vec::new();
        }
        if let Some(at) = record
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_timestamp)
        {
            self.last_at = at;
        }

        let mut kinds = Vec::new();
        self.session_started(&record, &mut kinds);
        match str_field(&record, "type") {
            Some("user") => self.user_record(&record, &mut kinds),
            Some("assistant") => self.assistant_record(&record, &mut kinds),
            Some("system") => system_record(&record, &mut kinds),
            Some("ai-title") => self.title_record(&record, &mut kinds),
            other => {
                tracing::debug!(session = %self.session, record_type = ?other, "ignoring transcript record");
            }
        }
        kinds
            .into_iter()
            .map(|kind| Event {
                session: self.session.clone(),
                agent: self.agent.clone(),
                at: self.last_at,
                source: Source::Transcript,
                kind,
            })
            .collect()
    }

    fn session_started(&mut self, record: &Value, out: &mut Vec<EventKind>) {
        if self.started {
            return;
        }
        let Some(cwd) = str_field(record, "cwd") else {
            return;
        };
        self.started = true;
        out.push(EventKind::SessionStarted {
            cwd: Some(cwd.to_owned()),
            git_branch: str_field(record, "gitBranch").map(str::to_owned),
            version: str_field(record, "version").map(str::to_owned),
        });
    }

    fn title_record(&mut self, record: &Value, out: &mut Vec<EventKind>) {
        let Some(title) = str_field(record, "aiTitle") else {
            return;
        };
        if self.title.as_deref() == Some(title) {
            return;
        }
        self.title = Some(title.to_owned());
        out.push(EventKind::Title {
            title: title.to_owned(),
        });
    }

    fn assistant_record(&mut self, record: &Value, out: &mut Vec<EventKind>) {
        let Some(message) = record.get("message") else {
            return;
        };
        let blocks = message.get("content").and_then(Value::as_array);

        if record.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true) {
            let text = blocks.map(|b| join_texts(b, "text")).unwrap_or_default();
            out.push(EventKind::Error { message: text });
            return;
        }

        let model = str_field(message, "model").filter(|m| *m != SYNTHETIC_MODEL);
        if let Some(model) = model
            && self.model.as_deref() != Some(model)
        {
            self.model = Some(model.to_owned());
            out.push(EventKind::ModelSeen {
                model: model.to_owned(),
            });
        }

        for block in blocks.into_iter().flatten() {
            match str_field(block, "type") {
                Some("thinking") => out.push(EventKind::Thinking {
                    text: str_field(block, "thinking").unwrap_or_default().to_owned(),
                }),
                Some("redacted_thinking") => out.push(EventKind::Thinking {
                    text: String::new(),
                }),
                Some("text") => {
                    if let Some(text) = str_field(block, "text") {
                        out.push(EventKind::AssistantText {
                            text: text.to_owned(),
                        });
                    }
                }
                Some("tool_use") => {
                    out.extend(self.tool_message(block));
                    if let Some(kind) = tool_started(block) {
                        out.push(kind);
                    }
                }
                other => tracing::debug!(block_type = ?other, "ignoring assistant content block"),
            }
        }

        // Streamed chunks of one response share `message.id`; report usage once per id.
        if let (Some(model), Some(id), Some(usage)) =
            (model, str_field(message, "id"), message.get("usage"))
            && self.usage_ids.insert(id.to_owned())
        {
            out.push(EventKind::UsageReported {
                model: model.to_owned(),
                usage: Usage {
                    input: u64_field(usage, "input_tokens"),
                    output: u64_field(usage, "output_tokens"),
                    cache_read: u64_field(usage, "cache_read_input_tokens"),
                    cache_write: u64_field(usage, "cache_creation_input_tokens"),
                },
            });
        }
    }
    fn user_record(&mut self, record: &Value, out: &mut Vec<EventKind>) {
        let is_meta = record.get("isMeta").and_then(Value::as_bool) == Some(true);
        let origin = record
            .get("origin")
            .and_then(|o| str_field(o, "kind"))
            .unwrap_or_default();
        let Some(content) = record.get("message").and_then(|m| m.get("content")) else {
            return;
        };
        match content {
            Value::String(text) => self.prompt(text, is_meta, origin, out),
            Value::Array(blocks) => {
                let result = record.get("toolUseResult");
                let duration_ms = result.and_then(|r| {
                    r.get("durationMs")
                        .or_else(|| r.get("totalDurationMs"))
                        .and_then(Value::as_u64)
                });
                // A synchronous subagent (`Agent` tool) returns its report as the tool result.
                let sync_agent = result
                    .filter(|r| str_field(r, "status") == Some("completed"))
                    .and_then(|r| str_field(r, "agentId"));
                let mut prompt_parts: Vec<&str> = Vec::new();
                for block in blocks {
                    match str_field(block, "type") {
                        Some("tool_result") => {
                            let Some(id) = str_field(block, "tool_use_id") else {
                                continue;
                            };
                            let output = block.get("content").map(content_text).unwrap_or_default();
                            if let Some(agent) = sync_agent {
                                out.push(message(
                                    AgentId::new(agent),
                                    self.agent.clone(),
                                    MessageChannel::Result,
                                    &output,
                                ));
                            }
                            out.push(EventKind::ToolFinished {
                                tool_use_id: ToolUseId::new(id),
                                is_error: block.get("is_error").and_then(Value::as_bool)
                                    == Some(true),
                                output: truncate_bytes(&output, MAX_OUTPUT_BYTES).to_owned(),
                                duration_ms,
                            });
                        }
                        Some("text") => prompt_parts.extend(str_field(block, "text")),
                        Some("image") => prompt_parts.push("[image]"),
                        other => {
                            tracing::debug!(block_type = ?other, "ignoring user content block");
                        }
                    }
                }
                if !prompt_parts.is_empty() {
                    self.prompt(&prompt_parts.join("\n"), is_meta, origin, out);
                }
            }
            _ => tracing::debug!("ignoring user record with unexpected content"),
        }
    }

    /// Classifies user-side text: a human prompt, a subagent dispatch, an agent-to-agent
    /// message, a background-task notification, or harness noise (which emits nothing).
    fn prompt(&mut self, text: &str, is_meta: bool, origin: &str, out: &mut Vec<EventKind>) {
        // Peer messages arrive as meta records, so check them before the meta filter.
        if let Some((from, inner)) = agent_message(text) {
            out.push(message(
                AgentId::new(from),
                self.agent.clone(),
                MessageChannel::Message,
                inner,
            ));
            return;
        }
        if origin == "task-notification" || text.starts_with("<task-notification>") {
            if let Some(task) = tag_text(text, "task-id") {
                let summary = tag_text(text, "summary").unwrap_or(text);
                out.push(message(
                    AgentId::new(task),
                    self.agent.clone(),
                    MessageChannel::Notification,
                    summary,
                ));
            }
            return;
        }
        let is_main = self.agent == AgentId::main();
        // In a subagent, the parent's `SendMessage` lands as a meta "coordinator" record.
        // The parent's own transcript already produced that message from its `SendMessage`
        // tool call, so emitting it again here would show every message twice.
        if origin == "coordinator" && !is_main {
            return;
        }
        if is_meta || is_harness_text(text) {
            return;
        }
        let (from, channel) = if is_main {
            (AgentId::user(), MessageChannel::Prompt)
        } else if self.dispatched {
            (AgentId::main(), MessageChannel::Message)
        } else {
            (AgentId::main(), MessageChannel::Dispatch)
        };
        self.dispatched = true;
        out.push(message(from, self.agent.clone(), channel, text));
        out.push(EventKind::UserPrompt {
            text: text.to_owned(),
        });
    }

    /// `SendMessage` and `SubagentHandback` tool calls also become [`EventKind::MessageSent`].
    fn tool_message(&self, block: &Value) -> Option<EventKind> {
        let input = block.get("input")?;
        let text = |keys: &[&str]| {
            keys.iter()
                .find_map(|k| str_field(input, k))
                .unwrap_or_default()
        };
        match str_field(block, "name")? {
            "SendMessage" => {
                let to = str_field(input, "to")?;
                Some(message(
                    self.agent.clone(),
                    AgentId::new(to),
                    MessageChannel::Message,
                    text(&["message", "summary"]),
                ))
            }
            "SubagentHandback" => Some(message(
                self.agent.clone(),
                AgentId::main(),
                MessageChannel::Result,
                text(&["message"]),
            )),
            _ => None,
        }
    }
}

fn system_record(record: &Value, out: &mut Vec<EventKind>) {
    match str_field(record, "subtype") {
        Some("compact_boundary") => {
            let meta = record.get("compactMetadata");
            out.push(EventKind::Compacted {
                trigger: meta
                    .and_then(|m| str_field(m, "trigger"))
                    .map(str::to_owned),
                pre_tokens: meta
                    .and_then(|m| m.get("preTokens"))
                    .and_then(Value::as_u64),
            });
        }
        Some("turn_duration") => out.push(EventKind::TurnEnded {
            duration_ms: record.get("durationMs").and_then(Value::as_u64),
        }),
        other => tracing::debug!(subtype = ?other, "ignoring system record"),
    }
}

fn tool_started(block: &Value) -> Option<EventKind> {
    let id = str_field(block, "id")?;
    let name = str_field(block, "name")?;
    let input = block.get("input").cloned().unwrap_or(Value::Null);
    Some(EventKind::ToolStarted {
        tool_use_id: ToolUseId::new(id),
        name: name.to_owned(),
        tool_kind: ToolKind::from_tool_name(name),
        summary: tool_summary(name, &input),
        input,
    })
}

/// One-line human summary of a tool call, e.g. the command or the file path.
fn tool_summary(name: &str, input: &Value) -> String {
    let field = |key: &str| str_field(input, key).filter(|s| !s.is_empty());
    let summary = match name {
        "Bash" | "PowerShell" => field("description")
            .or_else(|| field("command"))
            .map(|s| s.lines().next().unwrap_or_default().to_owned()),
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" | "NotebookRead" => {
            field("file_path")
                .or_else(|| field("notebook_path"))
                .map(str::to_owned)
        }
        "Grep" | "Glob" => field("pattern").map(|p| match field("path") {
            Some(path) => format!("{p} in {path}"),
            None => p.to_owned(),
        }),
        "WebFetch" => field("url").map(str::to_owned),
        "WebSearch" => field("query").map(str::to_owned),
        "Agent" | "Task" => field("description").map(str::to_owned),
        "SendMessage" => field("to").map(|to| format!("to {to}")),
        _ => None,
    };
    let summary = summary.unwrap_or_else(|| name.to_owned());
    if summary.chars().count() > MAX_SUMMARY_CHARS {
        summary.chars().take(MAX_SUMMARY_CHARS).collect()
    } else {
        summary
    }
}

fn message(from: AgentId, to: AgentId, channel: MessageChannel, text: &str) -> EventKind {
    EventKind::MessageSent {
        from,
        to,
        channel,
        text: truncate_bytes(text, MAX_MESSAGE_BYTES).to_owned(),
    }
}

/// Text Claude Code injects as a user record that no human typed.
fn is_harness_text(text: &str) -> bool {
    [
        "<local-command-",
        "<command-name>",
        "<system-reminder>",
        "Caveat:",
    ]
    .iter()
    .any(|p| text.starts_with(p))
}

/// Splits `... <agent-message from="ID">inner</agent-message> ...` into `(ID, inner)`.
fn agent_message(text: &str) -> Option<(&str, &str)> {
    const OPEN: &str = "<agent-message from=\"";
    let rest = text.get(text.find(OPEN)? + OPEN.len()..)?;
    let (from, rest) = rest.split_once('"')?;
    let (_, body) = rest.split_once('>')?;
    let inner = body.split_once("</agent-message>").map_or(body, |(i, _)| i);
    Some((from, inner.trim()))
}

/// Trimmed text between the first `<tag>` and `</tag>`.
fn tag_text<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let rest = text.get(text.find(&open)? + open.len()..)?;
    let (inner, _) = rest.split_once(close.as_str())?;
    Some(inner.trim())
}

/// Text of a `tool_result` content: a string, or an array of `{type: text, text}` blocks.
fn content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => join_texts(blocks, "text"),
        _ => String::new(),
    }
}

/// Joins the `field` text of text blocks with newlines; images become `[image]`.
fn join_texts(blocks: &[Value], field: &str) -> String {
    blocks
        .iter()
        .filter_map(|b| match str_field(b, "type") {
            Some("text") => str_field(b, field),
            Some("image") => Some("[image]"),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Cuts `s` to at most `max` bytes without splitting a UTF-8 character.
fn truncate_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s.get(..end).unwrap_or_default()
}

/// Parses an RFC 3339 timestamp (`2026-11-14T17:16:31.344Z`) into epoch milliseconds.
fn parse_timestamp(s: &str) -> Option<TimestampMs> {
    let dt = OffsetDateTime::parse(s, &Rfc3339).ok()?;
    TimestampMs::try_from(dt.unix_timestamp_nanos() / 1_000_000).ok()
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn u64_field(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parser() -> TranscriptParser {
        TranscriptParser::new(SessionId::new("s1"), AgentId::main())
    }

    fn kinds(p: &mut TranscriptParser, line: &str) -> Vec<EventKind> {
        p.feed_line(line).into_iter().map(|e| e.kind).collect()
    }

    fn sub_parser() -> TranscriptParser {
        TranscriptParser::new(SessionId::new("s1"), AgentId::new("a1"))
    }

    fn msg(from: &str, to: &str, channel: MessageChannel, text: &str) -> EventKind {
        EventKind::MessageSent {
            from: AgentId::new(from),
            to: AgentId::new(to),
            channel,
            text: text.into(),
        }
    }

    #[test]
    fn human_prompt_emits_message_then_prompt() {
        let mut p = parser();
        assert_eq!(
            kinds(
                &mut p,
                r#"{"type":"user","origin":{"kind":"human"},"message":{"content":"hi"}}"#
            ),
            vec![
                msg("user", "main", MessageChannel::Prompt, "hi"),
                EventKind::UserPrompt { text: "hi".into() }
            ]
        );
    }

    #[test]
    fn task_notification_is_not_a_prompt() {
        let mut p = parser();
        let line = r#"{"type":"user","origin":{"kind":"task-notification"},"message":{"content":"<task-notification>\n<task-id>a7</task-id>\n<status>completed</status>\n<summary>Agent \"X\" finished</summary>\n</task-notification>"}}"#;
        assert_eq!(
            kinds(&mut p, line),
            vec![msg(
                "a7",
                "main",
                MessageChannel::Notification,
                "Agent \"X\" finished"
            )]
        );
        // Without `origin`, the prefix alone is enough; without a summary the whole text is used.
        let k = kinds(
            &mut p,
            r#"{"type":"user","message":{"content":"<task-notification><task-id>b2</task-id></task-notification>"}}"#,
        );
        assert_eq!(
            k,
            vec![msg(
                "b2",
                "main",
                MessageChannel::Notification,
                "<task-notification><task-id>b2</task-id></task-notification>"
            )]
        );
    }

    #[test]
    fn harness_texts_emit_nothing() {
        let mut p = parser();
        for text in [
            "<local-command-stdout>ok</local-command-stdout>",
            "<command-name>/clear</command-name>",
            "<system-reminder>x</system-reminder>",
            "Caveat: the messages below",
        ] {
            let line = serde_json::json!({"type":"user","message":{"content":text}}).to_string();
            assert_eq!(kinds(&mut p, &line), vec![], "{text}");
        }
    }

    #[test]
    fn agent_message_becomes_message_even_when_meta() {
        let mut p = parser();
        let k = kinds(
            &mut p,
            r#"{"type":"user","isMeta":true,"origin":{"kind":"peer"},"message":{"content":"Another session sent a message:\n<agent-message from=\"a9\">\nreport\n</agent-message>\n\nnote"}}"#,
        );
        assert_eq!(
            k,
            vec![msg("a9", "main", MessageChannel::Message, "report")]
        );
    }

    #[test]
    fn subagent_first_prompt_is_dispatch_then_messages() {
        let mut p = sub_parser();
        assert_eq!(
            kinds(
                &mut p,
                r#"{"type":"user","message":{"content":[{"type":"text","text":"do it"}]}}"#
            ),
            vec![
                msg("main", "a1", MessageChannel::Dispatch, "do it"),
                EventKind::UserPrompt {
                    text: "do it".into()
                }
            ]
        );
        // Meta noise in between neither dispatches nor counts as a message.
        assert_eq!(
            kinds(
                &mut p,
                r#"{"type":"user","isMeta":true,"message":{"content":"<system-reminder>r</system-reminder>"}}"#
            ),
            vec![]
        );
        let k = kinds(&mut p, r#"{"type":"user","message":{"content":"more"}}"#);
        assert_eq!(k[0], msg("main", "a1", MessageChannel::Message, "more"));
        let k = kinds(
            &mut p,
            r#"{"type":"user","isMeta":true,"origin":{"kind":"coordinator"},"message":{"content":"The coordinator sent a message while you were working:\nresume"}}"#,
        );
        // The parent's SendMessage already produced this message; the child's copy is dropped.
        assert_eq!(k, vec![]);
    }

    #[test]
    fn send_message_tool_use_emits_message() {
        let mut p = sub_parser();
        let k = kinds(
            &mut p,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"SendMessage","input":{"to":"main","message":"hello"}}]}}"#,
        );
        assert_eq!(k.len(), 2);
        assert_eq!(k[0], msg("a1", "main", MessageChannel::Message, "hello"));
        assert!(matches!(k[1], EventKind::ToolStarted { .. }));
        let k = kinds(
            &mut p,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"SendMessage","input":{"to":"b3","summary":"only summary"}}]}}"#,
        );
        assert_eq!(
            k[0],
            msg("a1", "b3", MessageChannel::Message, "only summary")
        );
    }

    #[test]
    fn handback_tool_use_emits_result() {
        let mut p = sub_parser();
        let k = kinds(
            &mut p,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"SubagentHandback","input":{"message":"done"}}]}}"#,
        );
        assert_eq!(k[0], msg("a1", "main", MessageChannel::Result, "done"));
    }

    #[test]
    fn sync_agent_result_emits_result_but_async_launch_does_not() {
        let mut p = parser();
        let k = kinds(
            &mut p,
            r#"{"type":"user","toolUseResult":{"status":"completed","agentId":"a5","totalDurationMs":7},"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"report"}]}]}}"#,
        );
        assert_eq!(k[0], msg("a5", "main", MessageChannel::Result, "report"));
        assert!(matches!(k[1], EventKind::ToolFinished { .. }));
        let k = kinds(
            &mut p,
            r#"{"type":"user","toolUseResult":{"status":"async_launched","agentId":"a6"},"message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"launched"}]}}"#,
        );
        assert_eq!(k.len(), 1);
        assert!(matches!(k[0], EventKind::ToolFinished { .. }));
    }

    #[test]
    fn message_text_is_truncated() {
        let long = "é".repeat(5000); // 10000 bytes
        let EventKind::MessageSent { text, .. } = message(
            AgentId::user(),
            AgentId::main(),
            MessageChannel::Prompt,
            &long,
        ) else {
            panic!("expected MessageSent");
        };
        assert_eq!(text.len(), MAX_MESSAGE_BYTES);
    }

    #[test]
    fn skips_malformed_and_unknown_lines() {
        let mut p = parser();
        assert_eq!(p.feed_line("not json").len(), 0);
        assert_eq!(p.feed_line("").len(), 0);
        assert_eq!(p.feed_line("[1,2]").len(), 0);
        assert_eq!(
            p.feed_line(r#"{"type":"permission-mode","permissionMode":"auto"}"#)
                .len(),
            0
        );
        assert_eq!(
            p.feed_line(r#"{"type":"user","message":{"content":42}}"#)
                .len(),
            0
        );
    }

    #[test]
    fn parses_timestamps_and_reuses_last() {
        let mut p = parser();
        let e = p.feed_line(
            r#"{"type":"user","timestamp":"2026-11-14T17:16:31.344Z","message":{"content":"hi"}}"#,
        );
        assert_eq!(e[0].at, 1_794_676_591_344);
        let e = p.feed_line(r#"{"type":"ai-title","aiTitle":"T"}"#);
        assert_eq!(e[0].at, 1_794_676_591_344);
        assert_eq!(e[0].source, Source::Transcript);
    }

    #[test]
    fn emits_session_started_once() {
        let mut p = parser();
        let line = r#"{"type":"user","cwd":"/w","gitBranch":"main","version":"2.0.0","message":{"content":"hi"}}"#;
        let first = kinds(&mut p, line);
        assert_eq!(
            first[0],
            EventKind::SessionStarted {
                cwd: Some("/w".into()),
                git_branch: Some("main".into()),
                version: Some("2.0.0".into())
            }
        );
        assert_eq!(
            kinds(&mut p, line),
            vec![
                msg("user", "main", MessageChannel::Prompt, "hi"),
                EventKind::UserPrompt { text: "hi".into() }
            ]
        );
    }

    #[test]
    fn title_only_on_change() {
        let mut p = parser();
        let line = r#"{"type":"ai-title","aiTitle":"Fix bug"}"#;
        assert_eq!(kinds(&mut p, line).len(), 1);
        assert_eq!(kinds(&mut p, line).len(), 0);
        assert_eq!(
            kinds(&mut p, r#"{"type":"ai-title","aiTitle":"Other"}"#).len(),
            1
        );
    }

    #[test]
    fn skips_meta_prompts_and_joins_text_blocks() {
        let mut p = parser();
        assert_eq!(
            kinds(
                &mut p,
                r#"{"type":"user","isMeta":true,"message":{"content":"x"}}"#
            )
            .len(),
            0
        );
        let k = kinds(
            &mut p,
            r#"{"type":"user","message":{"content":[{"type":"text","text":"look"},{"type":"image","source":{}}]}}"#,
        );
        assert_eq!(
            k,
            vec![
                msg("user", "main", MessageChannel::Prompt, "look\n[image]"),
                EventKind::UserPrompt {
                    text: "look\n[image]".into()
                }
            ]
        );
    }

    #[test]
    fn parses_tool_results() {
        let mut p = parser();
        let k = kinds(
            &mut p,
            r#"{"type":"user","toolUseResult":{"durationMs":12},"message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":[{"type":"text","text":"boom"}]}]}}"#,
        );
        assert_eq!(
            k,
            vec![EventKind::ToolFinished {
                tool_use_id: ToolUseId::new("t1"),
                is_error: true,
                output: "boom".into(),
                duration_ms: Some(12)
            }]
        );
    }

    #[test]
    fn truncates_output_on_char_boundary() {
        let s = "é".repeat(3000); // 6000 bytes
        let t = truncate_bytes(&s, MAX_OUTPUT_BYTES);
        assert!(t.len() <= MAX_OUTPUT_BYTES);
        assert_eq!(t.len(), 4096);
        assert_eq!(truncate_bytes("aé", 2), "a");
    }

    #[test]
    fn parses_assistant_blocks_and_dedupes_usage() {
        let mut p = parser();
        let usage = r#""usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}"#;
        let a = format!(
            r#"{{"type":"assistant","message":{{"id":"m1","model":"claude-opus-5-5","content":[{{"type":"thinking","thinking":"hmm"}}],{usage}}}}}"#
        );
        let b = format!(
            r#"{{"type":"assistant","message":{{"id":"m1","model":"claude-opus-5-5","content":[{{"type":"tool_use","id":"t1","name":"Bash","input":{{"command":"ls -la\nmore"}}}}],{usage}}}}}"#
        );
        let k = kinds(&mut p, &a);
        assert_eq!(k.len(), 3);
        assert_eq!(
            k[0],
            EventKind::ModelSeen {
                model: "claude-opus-5-5".into()
            }
        );
        assert_eq!(k[1], EventKind::Thinking { text: "hmm".into() });
        assert_eq!(
            k[2],
            EventKind::UsageReported {
                model: "claude-opus-5-5".into(),
                usage: Usage {
                    input: 10,
                    output: 5,
                    cache_read: 100,
                    cache_write: 20
                }
            }
        );
        let k = kinds(&mut p, &b);
        assert_eq!(k.len(), 1);
        let EventKind::ToolStarted {
            summary, tool_kind, ..
        } = &k[0]
        else {
            panic!("expected ToolStarted, got {k:?}");
        };
        assert_eq!(summary, "ls -la");
        assert_eq!(*tool_kind, ToolKind::Bash);
    }

    #[test]
    fn api_error_becomes_error_event() {
        let mut p = parser();
        let k = kinds(
            &mut p,
            r#"{"type":"assistant","isApiErrorMessage":true,"message":{"id":"x","model":"<synthetic>","content":[{"type":"text","text":"API Error: 500"}]}}"#,
        );
        assert_eq!(
            k,
            vec![EventKind::Error {
                message: "API Error: 500".into()
            }]
        );
    }

    #[test]
    fn parses_system_subtypes() {
        let mut p = parser();
        let k = kinds(
            &mut p,
            r#"{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":150000}}"#,
        );
        assert_eq!(
            k,
            vec![EventKind::Compacted {
                trigger: Some("auto".into()),
                pre_tokens: Some(150_000)
            }]
        );
        let k = kinds(
            &mut p,
            r#"{"type":"system","subtype":"turn_duration","durationMs":900}"#,
        );
        assert_eq!(
            k,
            vec![EventKind::TurnEnded {
                duration_ms: Some(900)
            }]
        );
        assert_eq!(
            kinds(&mut p, r#"{"type":"system","subtype":"away_summary"}"#).len(),
            0
        );
    }

    #[test]
    fn summarizes_tools() {
        let v = |s: &str| serde_json::from_str::<Value>(s).unwrap_or_default();
        assert_eq!(
            tool_summary("Bash", &v(r#"{"command":"ls","description":"List"}"#)),
            "List"
        );
        assert_eq!(
            tool_summary("Read", &v(r#"{"file_path":"/a.rs"}"#)),
            "/a.rs"
        );
        assert_eq!(
            tool_summary("Grep", &v(r#"{"pattern":"fn","path":"src"}"#)),
            "fn in src"
        );
        assert_eq!(tool_summary("Glob", &v(r#"{"pattern":"*.rs"}"#)), "*.rs");
        assert_eq!(
            tool_summary("WebFetch", &v(r#"{"url":"https://x.dev"}"#)),
            "https://x.dev"
        );
        assert_eq!(tool_summary("WebSearch", &v(r#"{"query":"rust"}"#)), "rust");
        assert_eq!(
            tool_summary("Agent", &v(r#"{"description":"Explore"}"#)),
            "Explore"
        );
        assert_eq!(tool_summary("TodoWrite", &v("{}")), "TodoWrite");
        assert_eq!(
            tool_summary(
                "Bash",
                &v(&format!(r#"{{"command":"{}"}}"#, "a".repeat(300)))
            )
            .len(),
            120
        );
    }
}
