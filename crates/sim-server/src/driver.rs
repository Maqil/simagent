//! Session driver: continues a Claude Code session from the browser.
//!
//! A [`ClientMsg::Prompt`](sim_protocol::ClientMsg::Prompt) starts one headless turn:
//! `claude -p <text> --resume <session> --output-format stream-json --verbose` in the
//! session's working directory. Claude Code appends to the same transcript file, so the
//! ingest tailer picks the turn up like any other activity: messages, tools and subagents
//! appear live with no extra plumbing. Permission prompts reach the browser through the
//! installed `PermissionRequest` hook and the broker, exactly as for terminal sessions.
//!
//! **Why an actor:** at most one turn may run per session (two would interleave writes
//! to one transcript). The actor owns the map of running turns, so "is one running?" and
//! "start one" are a single step with no lock.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use sim_core::{AgentId, Event, EventKind, SessionId, Source};
use sim_protocol::{DrivePhase, ServerMsg};
use tokio::io::{AsyncBufReadExt as _, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use crate::hub::HubHandle;

/// Longest a single browser-driven turn may run before it is stopped.
const TURN_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// Longest prompt accepted from the browser.
const MAX_PROMPT_BYTES: usize = 100 * 1024;

/// Commands to the driver actor.
#[derive(Debug)]
enum DriverCmd {
    Prompt { session: SessionId, text: String },
    Interrupt { session: SessionId },
    Finished { session: SessionId },
}

/// Cheap, cloneable handle to the driver actor.
#[derive(Debug, Clone)]
pub struct Driver {
    tx: mpsc::Sender<DriverCmd>,
}

impl Driver {
    /// Spawns the actor. `claude_bin` is the Claude Code executable to run.
    #[must_use]
    pub fn spawn(hub: HubHandle, claude_bin: PathBuf) -> Self {
        let (tx, rx) = mpsc::channel(64);
        tokio::spawn(run(rx, tx.clone(), hub, claude_bin));
        Self { tx }
    }

    /// Starts a turn continuing `session` with `text`. Status arrives as
    /// [`ServerMsg::Drive`] broadcasts.
    pub async fn prompt(&self, session: SessionId, text: String) {
        let _ = self.tx.send(DriverCmd::Prompt { session, text }).await;
    }

    /// Stops the running turn for `session`, if any.
    pub async fn interrupt(&self, session: SessionId) {
        let _ = self.tx.send(DriverCmd::Interrupt { session }).await;
    }
}

/// Finds the `claude` executable: `$SIMAGENT_CLAUDE`, then `PATH`, then common install dirs.
#[must_use]
pub fn find_claude() -> PathBuf {
    if let Some(p) = std::env::var_os("SIMAGENT_CLAUDE") {
        return PathBuf::from(p);
    }
    let home = dirs::home_dir().unwrap_or_default();
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .map(|d| d.join("claude"))
                .collect()
        })
        .unwrap_or_default();
    candidates.extend([
        home.join(".local/bin/claude"),
        home.join(".claude/local/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ]);
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("claude"))
}

/// Why a prompt was refused before starting Claude Code.
fn validate(text: &str) -> Result<&str, String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("message is empty".into());
    }
    if t.len() > MAX_PROMPT_BYTES {
        return Err(format!(
            "message is longer than {} KB",
            MAX_PROMPT_BYTES / 1024
        ));
    }
    Ok(t)
}

async fn run(
    mut rx: mpsc::Receiver<DriverCmd>,
    tx: mpsc::Sender<DriverCmd>,
    hub: HubHandle,
    claude: PathBuf,
) {
    // One running turn per session; the sender stops it.
    let mut running: HashMap<SessionId, oneshot::Sender<()>> = HashMap::new();
    while let Some(cmd) = rx.recv().await {
        match cmd {
            DriverCmd::Prompt { session, text } => {
                if running.contains_key(&session) {
                    fail(
                        &hub,
                        &session,
                        "a turn is already running; wait or interrupt it",
                    )
                    .await;
                    continue;
                }
                let text = match validate(&text) {
                    Ok(t) => t.to_owned(),
                    Err(msg) => {
                        fail(&hub, &session, &msg).await;
                        continue;
                    }
                };
                let Some(cwd) = hub.cwd(session.clone()).await.ok().flatten() else {
                    fail(&hub, &session, "unknown session or working directory").await;
                    continue;
                };
                let (stop_tx, stop_rx) = oneshot::channel();
                running.insert(session.clone(), stop_tx);
                tokio::spawn(turn(
                    hub.clone(),
                    tx.clone(),
                    claude.clone(),
                    session,
                    PathBuf::from(cwd),
                    text,
                    stop_rx,
                ));
            }
            DriverCmd::Interrupt { session } => {
                if let Some(stop) = running.remove(&session) {
                    let _ = stop.send(());
                }
            }
            DriverCmd::Finished { session } => {
                running.remove(&session);
            }
        }
    }
}

async fn fail(hub: &HubHandle, session: &SessionId, message: &str) {
    tracing::warn!(session = %session, message, "prompt refused");
    status(
        hub,
        session,
        DrivePhase::Failed {
            message: message.to_owned(),
        },
    )
    .await;
}

async fn status(hub: &HubHandle, session: &SessionId, phase: DrivePhase) {
    let _ = hub
        .broadcast(ServerMsg::Drive {
            session: session.clone(),
            phase,
        })
        .await;
}

/// Runs one `claude -p --resume` turn to completion, interruption or timeout.
#[tracing::instrument(skip_all, fields(session = %session))]
async fn turn(
    hub: HubHandle,
    driver: mpsc::Sender<DriverCmd>,
    claude: PathBuf,
    session: SessionId,
    cwd: PathBuf,
    text: String,
    stop: oneshot::Receiver<()>,
) {
    let started = std::time::Instant::now();
    let phase = match spawn_claude(&claude, &session, &cwd, &text) {
        Ok(child) => {
            status(&hub, &session, DrivePhase::Running).await;
            tracing::info!(cwd = %cwd.display(), "driving turn");
            wait_turn(child, stop).await
        }
        Err(err) => DrivePhase::Failed {
            message: format!("could not start {}: {err}", claude.display()),
        },
    };
    tracing::info!(?phase, "turn ended");
    // Headless turns don't write a `turn_duration` record, so the transcript alone would
    // leave the agent "thinking" forever. The driver knows the turn ended; say so.
    if !matches!(phase, DrivePhase::Failed { .. }) {
        let end = Event {
            session: session.clone(),
            agent: AgentId::main(),
            at: crate::now_ms(),
            source: Source::Driver,
            kind: EventKind::TurnEnded {
                duration_ms: u64::try_from(started.elapsed().as_millis()).ok(),
            },
        };
        let _ = hub.ingest(vec![end]).await;
    }
    status(&hub, &session, phase).await;
    let _ = driver.send(DriverCmd::Finished { session }).await;
}

fn spawn_claude(
    claude: &PathBuf,
    session: &SessionId,
    cwd: &PathBuf,
    text: &str,
) -> std::io::Result<Child> {
    Command::new(claude)
        .arg("-p")
        .arg(text)
        .arg("--resume")
        .arg(session.as_str())
        .args(["--output-format", "stream-json", "--verbose"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
}

/// Reads the stream until the `result` line or the process exits. The transcript tailer
/// already shows the turn's content; here we only need how it ended.
async fn wait_turn(mut child: Child, mut stop: oneshot::Receiver<()>) -> DrivePhase {
    let Some(stdout) = child.stdout.take() else {
        return DrivePhase::Failed {
            message: "no stdout from claude".into(),
        };
    };
    let stderr = child.stderr.take();
    let mut lines = BufReader::new(stdout).lines();
    let mut outcome: Option<String> = None;
    let deadline = tokio::time::sleep(TURN_TIMEOUT);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    if let Some(o) = result_subtype(&line) {
                        outcome = Some(o);
                    }
                }
                Ok(None) | Err(_) => break,
            },
            _ = &mut stop => {
                let _ = child.kill().await;
                return DrivePhase::Interrupted;
            }
            () = &mut deadline => {
                let _ = child.kill().await;
                return DrivePhase::Failed { message: "turn timed out".into() };
            }
        }
    }
    let exit = child.wait().await;
    match (outcome, exit) {
        (Some(outcome), _) => DrivePhase::Done { outcome },
        (None, Ok(code)) if code.success() => DrivePhase::Done {
            outcome: "success".into(),
        },
        (None, _) => {
            let detail = match stderr {
                Some(err) => first_stderr_line(err).await,
                None => String::new(),
            };
            DrivePhase::Failed {
                message: if detail.is_empty() {
                    "claude exited with an error".into()
                } else {
                    detail
                },
            }
        }
    }
}

/// `{"type":"result","subtype":"success",...}` → `Some("success")`.
fn result_subtype(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    (v.get("type")?.as_str()? == "result").then(|| {
        v.get("subtype")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("success")
            .to_owned()
    })
}

async fn first_stderr_line(err: tokio::process::ChildStderr) -> String {
    let mut lines = BufReader::new(err).lines();
    while let Ok(Some(l)) = lines.next_line().await {
        let l = l.trim();
        if !l.is_empty() {
            return l.chars().take(300).collect();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_result_subtype() {
        assert_eq!(
            result_subtype(r#"{"type":"result","subtype":"error_max_turns"}"#).as_deref(),
            Some("error_max_turns")
        );
        assert_eq!(result_subtype(r#"{"type":"assistant"}"#), None);
        assert_eq!(result_subtype("not json"), None);
    }

    #[test]
    fn rejects_empty_and_huge_prompts() {
        assert!(validate("   ").is_err());
        assert!(validate(&"x".repeat(MAX_PROMPT_BYTES + 1)).is_err());
        assert_eq!(validate("  hi \n").unwrap(), "hi");
    }

    /// A fake `claude` that prints a stream and exits proves the whole turn path:
    /// spawn in cwd, read the result line, report `Done`.
    #[tokio::test]
    async fn drives_a_fake_claude_to_done() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("claude");
        std::fs::write(
            &bin,
            "#!/bin/sh\necho '{\"type\":\"system\",\"subtype\":\"init\"}'\necho '{\"type\":\"result\",\"subtype\":\"success\"}'\n",
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let child =
            spawn_claude(&bin, &SessionId::new("s"), &dir.path().to_path_buf(), "hi").unwrap();
        let (_stop_tx, stop_rx) = oneshot::channel();
        assert_eq!(
            wait_turn(child, stop_rx).await,
            DrivePhase::Done {
                outcome: "success".into()
            }
        );
    }

    #[tokio::test]
    async fn interrupt_kills_the_turn() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("claude");
        std::fs::write(&bin, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let child =
            spawn_claude(&bin, &SessionId::new("s"), &dir.path().to_path_buf(), "hi").unwrap();
        let (stop_tx, stop_rx) = oneshot::channel();
        stop_tx.send(()).unwrap();
        assert_eq!(wait_turn(child, stop_rx).await, DrivePhase::Interrupted);
    }
}
