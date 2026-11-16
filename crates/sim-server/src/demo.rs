//! `simagent demo`: a self-contained test bench.
//!
//! It runs the real server against a throwaway projects directory and a *scenario* that
//! writes realistic Claude Code transcripts line by line in real time (main agent, parallel
//! subagents, `SendMessage`, background-task notifications, tool errors, compaction) and
//! fires real `PermissionRequest` hooks at itself. Everything downstream is the production
//! path: tailer, parser, state machine, hub, WebSocket, scene, replay and approvals.
//!
//! **Why write files instead of injecting events:** injecting events would skip the parts
//! most likely to break (tailing partial lines, subagent discovery, parsing). Writing the
//! same bytes Claude Code writes tests them all, with no real session needed.

use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context as _;
use serde_json::{Value, json};
use tokio::time::sleep;

use crate::config::Opts;

/// Demo project folder name under the temporary projects dir (an encoded cwd).
const PROJECT: &str = "-demo-orbital";
/// Working directory the fake sessions claim to run in.
const CWD: &str = "/demo/orbital";
/// Model id the fake assistant reports.
const MODEL: &str = "claude-opus-5-5";

/// Port the demo uses unless `--port` is given, so it can run next to the real server.
pub const DEMO_PORT: u16 = 7420;

/// Options for `simagent demo`.
#[derive(Debug, Clone, clap::Args)]
pub struct DemoArgs {
    /// Speed multiplier for the scenario (2 = twice as fast).
    #[arg(long, default_value_t = 1.0)]
    pub speed: f64,
    /// Replay the scenario forever, starting a new session each round.
    #[arg(long = "loop")]
    pub repeat: bool,
    /// Keep the generated transcripts in this folder instead of a temp dir.
    #[arg(long)]
    pub dir: Option<PathBuf>,
}

/// Runs the server on a demo projects dir and plays the scenario into it.
///
/// # Errors
/// When the demo directory cannot be created or the server fails to start.
pub async fn run(opts: &Opts, args: &DemoArgs) -> anyhow::Result<()> {
    let root = match &args.dir {
        Some(d) => d.clone(),
        None => std::env::temp_dir().join(format!("simagent-demo-{}", std::process::id())),
    };
    let project = root.join(PROJECT);
    fs::create_dir_all(&project).with_context(|| format!("creating {}", project.display()))?;
    tracing::info!(dir = %root.display(), "demo transcripts are written here");

    let mut server_opts = opts.clone();
    server_opts.projects_dir = Some(root.clone());
    // The real server owns the default port; the demo moves aside unless told otherwise.
    if !port_given() {
        server_opts.port = DEMO_PORT;
    }
    // Everything in the demo dir is fresh; load it all.
    server_opts.startup_sessions = usize::MAX;
    let token = crate::config::load_or_create_token()?;
    let port = server_opts.port;
    let speed = if args.speed > 0.0 { args.speed } else { 1.0 };
    let repeat = args.repeat;

    let player = tokio::spawn(async move {
        // Give the server a moment to bind and the browser a moment to connect.
        sleep(Duration::from_millis(2500)).await;
        let mut round = 0u32;
        loop {
            round += 1;
            let mut s = Scenario::new(&project, round, speed, port, token.clone());
            if let Err(err) = s.play().await {
                tracing::warn!(%err, "demo scenario failed");
            }
            if !repeat {
                tracing::info!("demo scenario finished; the server keeps running (Ctrl-C to stop)");
                break;
            }
            sleep(Duration::from_secs(6)).await;
        }
    });

    let result = crate::http::serve(&server_opts).await;
    player.abort();
    if args.dir.is_none() {
        let _ = fs::remove_dir_all(&root);
    }
    result
}

/// True when `--port` was passed on the command line.
fn port_given() -> bool {
    std::env::args().any(|a| a == "--port" || a.starts_with("--port="))
}

/// Writes one demo session: the main transcript plus subagent files.
struct Scenario {
    session: String,
    project: PathBuf,
    main: File,
    clock: time::OffsetDateTime,
    speed: f64,
    hook_url: String,
    token: String,
    next_id: u32,
}

/// A subagent's transcript being written.
struct Sub {
    id: String,
    file: File,
    meta: PathBuf,
    meta_body: Value,
}

impl Scenario {
    fn new(project: &Path, round: u32, speed: f64, port: u16, token: String) -> Self {
        let session = format!("d3m0{round:04}-5e1f-4c2a-9b7d-0rb1ta1{round:05}");
        let main_path = project.join(format!("{session}.jsonl"));
        // Opening can only fail if the temp dir vanished; fall back to a sink file.
        let main = open_append(&main_path).unwrap_or_else(|_| sink());
        Self {
            session,
            project: project.to_path_buf(),
            main,
            clock: time::OffsetDateTime::now_utc(),
            speed,
            hook_url: format!("http://127.0.0.1:{port}/hooks"),
            token,
            next_id: 0,
        }
    }

    /// Waits `secs` (scaled by speed) and advances the transcript clock by the same amount.
    async fn pause(&mut self, secs: f64) {
        let real = secs / self.speed;
        sleep(Duration::from_secs_f64(real.max(0.0))).await;
        self.clock = time::OffsetDateTime::now_utc();
    }

    fn ts(&self) -> String {
        self.clock
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default()
    }

    fn id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}_demo{:05}", self.next_id)
    }

    fn base(&self, kind: &str, sidechain: bool) -> Value {
        json!({
            "type": kind,
            "timestamp": self.ts(),
            "sessionId": self.session,
            "cwd": CWD,
            "gitBranch": "feat/retry",
            "version": "2.3.0",
            "isSidechain": sidechain,
            "uuid": format!("u-{}", self.next_id),
        })
    }

    fn write(file: &mut File, v: &Value) {
        // A failed write only means a missing demo line; the demo keeps going.
        let _ = writeln!(file, "{v}");
        let _ = file.flush();
    }

    // ── record builders ──────────────────────────────────────────────────────

    fn human(&mut self, text: &str) -> Value {
        let mut v = self.base("user", false);
        v["message"] = json!({ "role": "user", "content": text });
        v["origin"] = json!({ "kind": "human" });
        v
    }

    fn assistant(&mut self, blocks: &Value, tokens_in: u64, tokens_out: u64) -> Value {
        let id = self.id("msg");
        let mut v = self.base("assistant", false);
        v["message"] = json!({
            "id": id, "role": "assistant", "model": MODEL, "content": blocks,
            "usage": {
                "input_tokens": tokens_in, "output_tokens": tokens_out,
                "cache_read_input_tokens": tokens_in * 18, "cache_creation_input_tokens": tokens_in * 2
            }
        });
        v
    }

    fn tool_result(
        &mut self,
        tool_use_id: &str,
        text: &str,
        is_error: bool,
        extra: Value,
    ) -> Value {
        let mut v = self.base("user", false);
        v["message"] = json!({ "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": tool_use_id, "content": text, "is_error": is_error }
        ]});
        v["toolUseResult"] = extra;
        v
    }

    // ── main-agent actions ───────────────────────────────────────────────────

    async fn say(&mut self, text: &str) {
        let v = self.assistant(&json!([{ "type": "text", "text": text }]), 800, 120);
        Self::write(&mut self.main, &v);
        self.pause(0.8).await;
    }

    async fn think(&mut self, secs: f64) {
        let v = self.assistant(
            &json!([{ "type": "thinking", "thinking": "", "signature": "demo" }]),
            600,
            300,
        );
        Self::write(&mut self.main, &v);
        self.pause(secs).await;
    }

    /// Runs one tool on the main agent: `tool_use`, wait, `tool_result`.
    async fn tool(&mut self, name: &str, input: Value, secs: f64, output: &str, is_error: bool) {
        let id = self.id("toolu");
        let v = self.assistant(
            &json!([{ "type": "tool_use", "id": id, "name": name, "input": input }]),
            900,
            160,
        );
        Self::write(&mut self.main, &v);
        self.pause(secs).await;
        let ms = secs_to_ms(secs);
        let r = self.tool_result(&id, output, is_error, json!({ "durationMs": ms }));
        Self::write(&mut self.main, &r);
        self.pause(0.4).await;
    }

    /// Asks for permission through the real hook endpoint, like Claude Code does, and
    /// returns the decision the browser made (or `None` when it fell back).
    async fn permission(&mut self, tool: &str, input: Value) -> Option<Value> {
        let body = json!({
            "session_id": self.session, "transcript_path": "", "cwd": CWD,
            "hook_event_name": "PermissionRequest", "tool_name": tool, "tool_input": input,
        });
        let reply = post_json(
            &format!("{}/PermissionRequest", self.hook_url),
            &self.token,
            &body,
        )
        .await;
        self.clock = time::OffsetDateTime::now_utc();
        reply.and_then(|v| v.pointer("/hookSpecificOutput/decision").cloned())
    }

    // ── subagents ────────────────────────────────────────────────────────────

    /// Launches a background subagent: the parent's `Agent` tool call, the meta file,
    /// and the child's first (dispatch) prompt.
    async fn spawn(&mut self, kind: &str, description: &str, prompt: &str) -> Sub {
        let tool_id = self.id("toolu");
        let agent_id = format!("a{:015x}", 0xdead_beef_u64 + u64::from(self.next_id));
        let v = self.assistant(
            &json!([{ "type": "tool_use", "id": tool_id, "name": "Agent", "input": {
                "description": description, "subagent_type": kind, "prompt": prompt, "run_in_background": true
            }}]),
            700,
            220,
        );
        Self::write(&mut self.main, &v);
        self.pause(0.3).await;
        let launched = self.tool_result(
            &tool_id,
            &format!("Async agent launched successfully.\nagentId: {agent_id}"),
            false,
            json!({ "isAsync": true, "status": "async_launched", "agentId": agent_id, "description": description }),
        );
        Self::write(&mut self.main, &launched);

        let dir = self.project.join(&self.session).join("subagents");
        let _ = fs::create_dir_all(&dir);
        let meta = dir.join(format!("agent-{agent_id}.meta.json"));
        let meta_body = json!({ "agentType": kind, "description": description, "toolUseId": tool_id, "finished": false });
        let _ = fs::write(&meta, meta_body.to_string());
        let mut file =
            open_append(&dir.join(format!("agent-{agent_id}.jsonl"))).unwrap_or_else(|_| sink());
        let mut first = self.base("user", true);
        first["agentId"] = json!(agent_id);
        first["message"] = json!({ "role": "user", "content": prompt });
        Self::write(&mut file, &first);
        self.pause(0.5).await;
        Sub {
            id: agent_id,
            file,
            meta,
            meta_body,
        }
    }

    async fn sub_think(&mut self, sub: &mut Sub, secs: f64) {
        let mut v = self.assistant(
            &json!([{ "type": "thinking", "thinking": "", "signature": "demo" }]),
            400,
            200,
        );
        v["isSidechain"] = json!(true);
        Self::write(&mut sub.file, &v);
        self.pause(secs).await;
    }

    async fn sub_tool(
        &mut self,
        sub: &mut Sub,
        name: &str,
        input: Value,
        secs: f64,
        output: &str,
        is_error: bool,
    ) {
        let id = self.id("toolu");
        let mut v = self.assistant(
            &json!([{ "type": "tool_use", "id": id, "name": name, "input": input }]),
            500,
            90,
        );
        v["isSidechain"] = json!(true);
        Self::write(&mut sub.file, &v);
        self.pause(secs).await;
        let mut r = self.tool_result(
            &id,
            output,
            is_error,
            json!({ "durationMs": secs_to_ms(secs) }),
        );
        r["isSidechain"] = json!(true);
        Self::write(&mut sub.file, &r);
        self.pause(0.3).await;
    }

    /// A parent → child `SendMessage` while the child works.
    async fn send_to(&mut self, sub: &mut Sub, text: &str) {
        let id = self.id("toolu");
        let v = self.assistant(
            &json!([{ "type": "tool_use", "id": id, "name": "SendMessage", "input": { "to": sub.id, "message": text, "summary": "Follow-up" } }]),
            300,
            60,
        );
        Self::write(&mut self.main, &v);
        let r = self.tool_result(&id, "Message queued for delivery.", false, json!({}));
        Self::write(&mut self.main, &r);
        let mut inbox = self.base("user", true);
        inbox["isMeta"] = json!(true);
        inbox["origin"] = json!({ "kind": "coordinator" });
        inbox["message"] = json!({ "role": "user", "content": format!("The coordinator sent a message while you were working:\n{text}") });
        Self::write(&mut sub.file, &inbox);
        self.pause(0.8).await;
    }

    /// The child hands its result back, finishes, and the parent gets a task notification.
    async fn finish(&mut self, mut sub: Sub, result: &str, title: &str) {
        let id = self.id("toolu");
        let mut v = self.assistant(
            &json!([{ "type": "tool_use", "id": id, "name": "SubagentHandback", "input": { "message": result } }]),
            300,
            180,
        );
        v["isSidechain"] = json!(true);
        Self::write(&mut sub.file, &v);
        self.pause(0.6).await;
        sub.meta_body["finished"] = json!(true);
        let _ = fs::write(&sub.meta, sub.meta_body.to_string());
        let mut note = self.base("user", false);
        note["origin"] = json!({ "kind": "task-notification" });
        note["message"] = json!({ "role": "user", "content": format!(
            "<task-notification>\n<task-id>{}</task-id>\n<status>completed</status>\n<summary>Agent \"{title}\" finished</summary>\n</task-notification>",
            sub.id
        )});
        Self::write(&mut self.main, &note);
        self.pause(0.6).await;
    }

    fn system(&mut self, subtype: &str, extra: &Value) {
        let mut v = self.base("system", false);
        v["subtype"] = json!(subtype);
        if let (Some(obj), Some(more)) = (v.as_object_mut(), extra.as_object()) {
            obj.extend(more.clone());
        }
        Self::write(&mut self.main, &v);
    }

    fn title(&mut self, t: &str) {
        let v = json!({ "type": "ai-title", "sessionId": self.session, "aiTitle": t });
        Self::write(&mut self.main, &v);
    }

    // ── the scenario ─────────────────────────────────────────────────────────

    /// About three minutes at speed 1. Covers every visual: prompts, thinking, reads,
    /// writes, search, bash with an error, two parallel subagents, a follow-up message,
    /// results, notifications, a permission request, compaction, and a turn end.
    async fn play(&mut self) -> anyhow::Result<()> {
        let started = std::time::Instant::now();
        let h = self.human("Add retry with exponential backoff to the HTTP client. Explore the call sites in parallel, run the tests, and keep the public API unchanged.");
        Self::write(&mut self.main, &h);
        self.title("Retry with backoff for the HTTP client");
        self.pause(1.0).await;

        self.think(2.0).await;
        self.say("I'll read the client first, then send one agent to map call sites and another to run the test suite.").await;
        self.tool("Read", json!({ "file_path": "/demo/orbital/src/http/client.rs" }), 1.2,
            "pub struct Client {\n    inner: reqwest::Client,\n    base: Url,\n}\n\nimpl Client {\n    pub async fn get(&self, path: &str) -> Result<Response> { ... }\n}", false).await;
        self.tool(
            "Grep",
            json!({ "pattern": "client\\.(get|post)", "path": "src" }),
            1.0,
            "src/api/users.rs:14\nsrc/api/orders.rs:31\nsrc/sync.rs:88",
            false,
        )
        .await;

        self.act_parallel_agents().await;
        self.act_implement().await;
        self.act_approve_and_wrap_up(started).await;
        Ok(())
    }

    /// Act 2: two subagents work in parallel, get a follow-up message, and report back.
    async fn act_parallel_agents(&mut self) {
        let mut scout = self.spawn("Explore", "Map HTTP call sites",
            "Find every call to Client::get/post in src/, note which ones are idempotent, and return a short table.").await;
        let mut tester = self
            .spawn(
                "general-purpose",
                "Run the test suite",
                "Run `cargo test --workspace` and report failures with the first lines of each.",
            )
            .await;

        // Both children work in parallel with the parent.
        self.sub_think(&mut scout, 1.0).await;
        self.sub_tool(
            &mut tester,
            "Bash",
            json!({ "command": "cargo test --workspace", "description": "Run all tests" }),
            0.5,
            "",
            false,
        )
        .await;
        self.sub_tool(
            &mut scout,
            "Grep",
            json!({ "pattern": "\\.get\\(|\\.post\\(", "path": "src/api" }),
            1.4,
            "users.rs:14 get\norders.rs:31 post\norders.rs:52 get",
            false,
        )
        .await;
        self.sub_tool(&mut scout, "Read", json!({ "file_path": "/demo/orbital/src/api/orders.rs" }), 1.0,
            "pub async fn create(c: &Client, o: &Order) -> Result<Id> {\n    c.post(\"/orders\", o).await\n}", false).await;
        self.send_to(
            &mut scout,
            "Also check src/sync.rs — it has a hand-rolled retry loop we should replace.",
        )
        .await;
        self.sub_tool(&mut tester, "Bash", json!({ "command": "cargo test -p http-client", "description": "Run client tests" }), 2.5,
            "running 14 tests\ntest retry::gives_up_after_max ... FAILED\n\nfailures:\n  expected 3 attempts, got 1", true).await;
        self.sub_tool(
            &mut scout,
            "Read",
            json!({ "file_path": "/demo/orbital/src/sync.rs" }),
            1.0,
            "loop {\n    match c.get(url).await { Ok(r) => break r, Err(_) => sleep(1s) }\n}",
            false,
        )
        .await;
        self.sub_think(&mut tester, 1.2).await;

        self.finish(scout, "| site | method | idempotent |\n|---|---|---|\n| users.rs:14 | GET | yes |\n| orders.rs:31 | POST | no |\n| orders.rs:52 | GET | yes |\n| sync.rs:88 | GET | yes (hand-rolled retry) |", "Map HTTP call sites").await;
        self.finish(tester, "1 failing test: retry::gives_up_after_max expects 3 attempts. Everything else passes (13/14).", "Run the test suite").await;
    }

    /// Act 3: the main agent writes and edits files.
    async fn act_implement(&mut self) {
        self.think(1.5).await;
        self.say("Only idempotent GETs should retry. I'll add a RetryPolicy and use it in Client::get, then replace the loop in sync.rs.").await;
        self.tool("Write", json!({ "file_path": "/demo/orbital/src/http/retry.rs", "content": "pub struct RetryPolicy { ... }" }), 1.4, "File created", false).await;
        self.tool("Edit", json!({ "file_path": "/demo/orbital/src/http/client.rs", "old_string": "self.inner.get", "new_string": "self.retry.run(|| self.inner.get" }), 1.0, "Applied 1 edit", false).await;
        self.tool("Edit", json!({ "file_path": "/demo/orbital/src/sync.rs", "old_string": "loop {", "new_string": "c.get(url).await?" }), 0.9, "Applied 1 edit", false).await;
    }

    /// Act 4: a real permission request, compaction, and the final answer.
    async fn act_approve_and_wrap_up(&mut self, started: std::time::Instant) {
        // A real permission request through the hook endpoint. With the browser open,
        // the approval card appears and waits; without it, this falls back immediately.
        let input = json!({ "command": "cargo test --workspace && git add -A", "description": "Run tests and stage changes" });
        let id = self.id("toolu");
        let v = self.assistant(
            &json!([{ "type": "tool_use", "id": id, "name": "Bash", "input": input }]),
            600,
            90,
        );
        Self::write(&mut self.main, &v);
        let decision = self.permission("Bash", input).await;
        let allowed = decision
            .as_ref()
            .and_then(|d| d.get("behavior"))
            .and_then(Value::as_str)
            == Some("allow");
        self.pause(0.3).await;
        if allowed {
            self.pause(2.0).await;
            let r = self.tool_result(
                &id,
                "test result: ok. 14 passed; 0 failed",
                false,
                json!({ "durationMs": 2000 }),
            );
            Self::write(&mut self.main, &r);
        } else {
            let r = self.tool_result(
                &id,
                "The user doesn't want to proceed with this tool use.",
                true,
                json!({}),
            );
            Self::write(&mut self.main, &r);
        }
        self.pause(0.6).await;

        self.system(
            "compact_boundary",
            &json!({ "compactMetadata": { "trigger": "auto", "preTokens": 182_000 } }),
        );
        self.pause(1.5).await;
        self.say(if allowed {
            "Done. GETs retry with backoff (3 attempts, 200ms base, jitter); POSTs never retry. All 14 tests pass and the change is staged."
        } else {
            "Changes are written but not tested or staged, since the command was denied. Run `cargo test --workspace` when ready."
        }).await;
        let ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.system(
            "turn_duration",
            &json!({ "durationMs": ms, "messageCount": 40 }),
        );
    }
}

/// Seconds to whole milliseconds for `durationMs` fields. Demo durations are small and
/// positive, so the clamp only guards against a nonsensical negative input.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // clamped to >= 0, < 1 day
fn secs_to_ms(secs: f64) -> u64 {
    (secs.clamp(0.0, 86_400.0) * 1000.0).round() as u64
}

fn open_append(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

/// A writable file that goes nowhere, used if the demo dir disappears mid-run.
fn sink() -> File {
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    // /dev/null always exists on unix; if even that fails there is nothing sensible to do.
    #[allow(clippy::unwrap_used)] // invariant: the null device is always openable
    OpenOptions::new().write(true).open(null).unwrap()
}

/// Minimal HTTP/1.1 POST over a raw TCP socket, so the demo needs no HTTP client crate.
async fn post_json(url: &str, token: &str, body: &Value) -> Option<Value> {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let rest = url.strip_prefix("http://")?;
    let (host, path) = rest.split_once('/')?;
    let mut stream = tokio::net::TcpStream::connect(host).await.ok()?;
    let payload = body.to_string();
    let req = format!(
        "POST /{path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nX-Simagent-Token: {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    stream.write_all(req.as_bytes()).await.ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.ok()?;
    let text = String::from_utf8_lossy(&buf);
    let (_, body) = text.split_once("\r\n\r\n")?;
    serde_json::from_str(body.trim()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim_core::{AgentId, EventKind, MessageChannel, SessionId, SessionState, TranscriptParser};

    /// Plays the whole scenario at high speed into a temp dir (no server, so the
    /// permission request falls back), then parses the files exactly like ingest does
    /// and checks every feature the demo is meant to exercise shows up.
    #[tokio::test]
    async fn scenario_exercises_every_visual() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join(PROJECT);
        fs::create_dir_all(&project).unwrap();
        // Port 9 (discard) has no listener, so the hook POST fails fast: "no decision".
        let mut s = Scenario::new(&project, 1, 1000.0, 9, "t".into());
        s.play().await.unwrap();

        let session = s.session.clone();
        let events =
            crate::ingest::load_session_events(dir.path(), &session).expect("demo session loads");
        let mut state = SessionState::new(SessionId::new(&session), 0);
        for e in &events {
            state.apply(e);
        }
        let count = |f: &dyn Fn(&EventKind) -> bool| events.iter().filter(|e| f(&e.kind)).count();
        let channel = |c: MessageChannel| {
            count(&|k| matches!(k, EventKind::MessageSent { channel, .. } if *channel == c))
        };
        assert_eq!(channel(MessageChannel::Prompt), 1);
        assert_eq!(channel(MessageChannel::Dispatch), 2);
        assert_eq!(channel(MessageChannel::Result), 2);
        assert_eq!(channel(MessageChannel::Notification), 2);
        assert_eq!(
            channel(MessageChannel::Message),
            1,
            "follow-up is not duplicated"
        );
        assert_eq!(
            count(&|k| matches!(k, EventKind::SubagentSpawned { .. })),
            2
        );
        assert_eq!(
            count(&|k| matches!(k, EventKind::SubagentFinished { .. })),
            2
        );
        assert_eq!(count(&|k| matches!(k, EventKind::Compacted { .. })), 1);
        assert!(count(&|k| matches!(k, EventKind::ToolFinished { is_error: true, .. })) >= 1);
        assert_eq!(
            state.title.as_deref(),
            Some("Retry with backoff for the HTTP client")
        );
        assert_eq!(state.agents.len(), 3, "main plus two subagents");
        assert!(state.cost_usd > 0.0);
        // Parsing line by line (the live path) gives the same main-agent events.
        let text = fs::read_to_string(project.join(format!("{session}.jsonl"))).unwrap();
        let mut p = TranscriptParser::new(SessionId::new(&session), AgentId::main());
        let live: usize = text.lines().map(|l| p.feed_line(l).len()).sum();
        assert!(live > 30);
    }
}
