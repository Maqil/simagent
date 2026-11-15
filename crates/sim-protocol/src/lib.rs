//! # sim-protocol
//!
//! JSON messages exchanged between `sim-server` and the browser over WebSocket `/ws`.
//!
//! **Why separate from sim-core:** sim-core models the domain; this crate models the wire.
//! The web UI mirrors these types in `web/src/protocol.ts`; keep both in sync.

use serde::{Deserialize, Serialize};
use sim_core::{Decision, Event, RequestId, SessionId, SessionState};

/// Version of the wire protocol. Bumped on any breaking change.
pub const PROTOCOL_VERSION: u32 = 1;

/// Messages from server to browser. Tagged with `"t"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
#[non_exhaustive]
pub enum ServerMsg {
    /// Sent once on connect: full state of every known session.
    Snapshot {
        /// [`PROTOCOL_VERSION`].
        protocol_version: u32,
        /// Session states, most recently active first.
        sessions: Vec<SessionState>,
    },
    /// One new event plus the session's state after applying it. Sending the state
    /// means the browser never re-implements the state machine.
    Update {
        /// The event. Boxed (like `state`) so this variant doesn't bloat every `ServerMsg`;
        /// boxing does not change the JSON.
        event: Box<Event>,
        /// Session state after the event.
        state: Box<SessionState>,
    },
    /// Status of a turn started with [`ClientMsg::Prompt`], broadcast to every browser.
    Drive {
        /// Session being driven.
        session: SessionId,
        /// Where the turn stands.
        #[serde(flatten)]
        phase: DrivePhase,
    },
    /// Recent events of one session, sent in reply to [`ClientMsg::LoadHistory`].
    History {
        /// Session.
        session: SessionId,
        /// Events, oldest first.
        events: Vec<Event>,
    },
}

/// Messages from browser to server. Tagged with `"t"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
#[non_exhaustive]
pub enum ClientMsg {
    /// Decide a pending permission request.
    Decide {
        /// Which request.
        request_id: RequestId,
        /// The decision.
        decision: Decision,
    },
    /// Ask for the event history of a session.
    LoadHistory {
        /// Which session.
        session: SessionId,
    },
    /// Send a message to a session, continuing it headless (`claude -p --resume`).
    Prompt {
        /// Which session to continue.
        session: SessionId,
        /// The message text.
        text: String,
    },
    /// Stop the turn simagent is currently driving for this session.
    Interrupt {
        /// Which session.
        session: SessionId,
    },
}

/// Where a browser-driven turn stands. Sent as [`ServerMsg::Drive`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
#[non_exhaustive]
pub enum DrivePhase {
    /// Claude Code is running the turn.
    Running,
    /// The turn finished.
    Done {
        /// Claude Code's result subtype, e.g. `success`.
        outcome: String,
    },
    /// The turn could not start or failed.
    Failed {
        /// Human-readable reason.
        message: String,
    },
    /// The user interrupted the turn.
    Interrupted,
}

/// One transcript on disk, listed by `GET /api/sessions` for the session browser / replay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSummary {
    /// Session id (file stem).
    pub id: SessionId,
    /// Project directory name under `~/.claude/projects` (encoded cwd).
    pub project: String,
    /// Working directory, when found in the first records.
    pub cwd: Option<String>,
    /// Latest AI title, when present.
    pub title: Option<String>,
    /// File modification time, epoch ms.
    pub modified_ms: i64,
    /// Size of the main transcript in bytes.
    pub size_bytes: u64,
    /// Number of subagent transcripts.
    pub subagents: u32,
    /// Whether the live hub currently tracks this session.
    pub live: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decide_wire_format() {
        let json =
            r#"{"t":"decide","request_id":"r1","decision":{"behavior":"deny","message":"no"}}"#;
        let msg: ClientMsg = serde_json::from_str(json).unwrap();
        assert_eq!(
            msg,
            ClientMsg::Decide {
                request_id: RequestId::new("r1"),
                decision: Decision::Deny {
                    message: "no".into()
                },
            }
        );
    }
}
