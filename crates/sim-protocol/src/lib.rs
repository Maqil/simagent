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
    /// Start following a session that was not loaded at startup. Its state then arrives
    /// like any other session's, through `Update` messages.
    OpenSession {
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

/// `GET /api/usage?days=N`: token and cost totals across every transcript on disk.
///
/// **Why hour buckets instead of daily totals:** the browser groups hours into *local*
/// days (the server doesn't know the viewer's timezone) and can re-slice 7/30/90 days
/// without another request. Hours keep the payload small: one row per active
/// (session, hour, model, main-or-subagent).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageReport {
    /// When the report was built, epoch ms.
    pub generated_ms: i64,
    /// Start of the window covered (`generated_ms - days`), epoch ms.
    pub since_ms: i64,
    /// Sessions with any usage in the window, most recently active first.
    pub sessions: Vec<SessionUsage>,
    /// Estimated 5-hour usage windows across all sessions, oldest first.
    pub blocks: Vec<UsageBlock>,
}

/// One session's usage, as hour buckets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionUsage {
    /// Session id (transcript file stem).
    pub id: SessionId,
    /// Project directory name under `~/.claude/projects`.
    pub project: String,
    /// Working directory, when known.
    pub cwd: Option<String>,
    /// Latest AI title, when known.
    pub title: Option<String>,
    /// Whether the live hub currently tracks this session.
    pub live: bool,
    /// Last response time, epoch ms.
    pub last_activity_ms: i64,
    /// Non-empty buckets, sorted by (`hour_ms`, `model`, `subagent`).
    pub buckets: Vec<UsageBucket>,
}

/// Usage summed over one hour for one model, split by main agent vs subagents.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageBucket {
    /// Start of the UTC hour, epoch ms.
    pub hour_ms: i64,
    /// Model id as reported by the API.
    pub model: String,
    /// True for subagent transcripts.
    pub subagent: bool,
    /// Number of API responses.
    pub requests: u32,
    /// Summed tokens.
    pub usage: sim_core::Usage,
    /// Summed estimated cost.
    pub cost: sim_core::cost::CostBreakdown,
}

/// An estimated 5-hour usage window (the unit Pro/Max limits use). It starts at the
/// first response floored to the hour and lasts 5 hours; the next response after it
/// ends starts a new one. Estimated from timestamps: the real quota isn't on disk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageBlock {
    /// Window start, epoch ms.
    pub start_ms: i64,
    /// Window end (`start_ms` + 5h), epoch ms.
    pub end_ms: i64,
    /// Last response inside the window, epoch ms.
    pub last_activity_ms: i64,
    /// True when `generated_ms` falls inside the window.
    pub active: bool,
    /// Number of API responses.
    pub requests: u32,
    /// Summed tokens.
    pub usage: sim_core::Usage,
    /// Summed estimated cost.
    pub cost: sim_core::cost::CostBreakdown,
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

    #[test]
    fn open_session_wire_format() {
        let msg = ClientMsg::OpenSession {
            session: SessionId::new("abc-1"),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(json, r#"{"t":"open_session","session":"abc-1"}"#);
        assert_eq!(serde_json::from_str::<ClientMsg>(&json).unwrap(), msg);
    }
}
