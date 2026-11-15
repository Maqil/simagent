//! The normalized event model.
//!
//! Every source (transcript lines, HTTP hooks, the SDK driver) is converted into these
//! events, so everything downstream (state, storage, UI) is source-agnostic.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::{AgentId, RequestId, SessionId, ToolUseId};

/// Milliseconds since the Unix epoch. sim-core never reads the clock; callers pass time in.
pub type TimestampMs = i64;

/// Where an event came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum Source {
    /// Parsed from a transcript `.jsonl` file.
    Transcript,
    /// Received from a Claude Code HTTP hook.
    Hook,
    /// Emitted by the SDK driver sidecar.
    Driver,
    /// Produced by sim-server itself (e.g. broker timeouts).
    Server,
}

/// One normalized event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    /// Session the event belongs to.
    pub session: SessionId,
    /// Agent within the session.
    pub agent: AgentId,
    /// When it happened (from the record's timestamp when available).
    pub at: TimestampMs,
    /// Which ingestion path produced it.
    pub source: Source,
    /// What happened.
    #[serde(flatten)]
    pub kind: EventKind,
}

/// What a tool call does, used for state colors and tool visuals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ToolKind {
    /// Read, `NotebookRead`, image reads.
    Read,
    /// Write, Edit, `MultiEdit`, `NotebookEdit`.
    Write,
    /// Grep, Glob, `WebSearch`, `ToolSearch`.
    Search,
    /// Bash, `PowerShell`, Monitor.
    Bash,
    /// `WebFetch`.
    Web,
    /// Agent / Task (spawns a subagent).
    Agent,
    /// `AskUserQuestion`, `ExitPlanMode`: needs the human.
    Ask,
    /// Anything else (MCP tools, todo lists...).
    Other,
}

impl ToolKind {
    /// Classifies a Claude Code tool name.
    #[must_use]
    pub fn from_tool_name(name: &str) -> Self {
        match name {
            "Read" | "NotebookRead" => Self::Read,
            "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => Self::Write,
            "Grep" | "Glob" | "WebSearch" | "ToolSearch" | "LS" => Self::Search,
            "Bash" | "PowerShell" | "Monitor" | "BashOutput" | "KillShell" => Self::Bash,
            "WebFetch" => Self::Web,
            "Agent" | "Task" => Self::Agent,
            "AskUserQuestion" | "ExitPlanMode" => Self::Ask,
            _ => Self::Other,
        }
    }
}

/// Token usage reported on one assistant message.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    /// Uncached input tokens.
    pub input: u64,
    /// Output tokens (including thinking).
    pub output: u64,
    /// Tokens read from the prompt cache.
    pub cache_read: u64,
    /// Tokens written to the prompt cache.
    pub cache_write: u64,
}

impl Usage {
    /// Total tokens in the context window for this request (input side).
    #[must_use]
    pub fn context_tokens(&self) -> u64 {
        self.input + self.cache_read + self.cache_write
    }
}

/// How a message travelled between two participants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum MessageChannel {
    /// The human prompted an agent.
    Prompt,
    /// A parent handed a task to a subagent (the subagent's first prompt).
    Dispatch,
    /// A subagent returned its result to the parent.
    Result,
    /// An agent sent a message to another agent (`SendMessage`).
    Message,
    /// A background-task notification delivered to an agent.
    Notification,
}

/// The user's answer to a permission request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "behavior", rename_all = "snake_case")]
pub enum Decision {
    /// Allow, optionally replacing the tool input (edit-before-approve).
    Allow {
        /// Replacement for the whole `tool_input`, if edited.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        updated_input: Option<Value>,
    },
    /// Deny with a message shown to Claude.
    Deny {
        /// Why it was denied.
        message: String,
    },
}

/// How a pending permission request ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum Resolution {
    /// Decided in the simagent UI.
    Decided {
        /// The decision.
        decision: Decision,
    },
    /// No decision in time (or no UI); Claude Code fell back to its terminal dialog.
    FellBack,
}

/// The kinds of events. Serialized with a `type` tag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum EventKind {
    /// A session's metadata became known (first record, or `SessionStart` hook).
    SessionStarted {
        /// Working directory.
        cwd: Option<String>,
        /// Git branch.
        git_branch: Option<String>,
        /// Claude Code version.
        version: Option<String>,
    },
    /// AI-generated session title.
    Title {
        /// The title.
        title: String,
    },
    /// A message passed from one participant to another. The human is [`AgentId::user`].
    /// `Event::agent` is the agent whose transcript recorded it.
    MessageSent {
        /// Sender.
        from: AgentId,
        /// Recipient.
        to: AgentId,
        /// What kind of hand-off this is.
        channel: MessageChannel,
        /// Message text, truncated to 8 KB.
        text: String,
    },
    /// The human sent a prompt to the main agent.
    UserPrompt {
        /// Prompt text (images replaced by `[image]`).
        text: String,
    },
    /// Assistant visible text.
    AssistantText {
        /// The text.
        text: String,
    },
    /// Assistant thinking block (text may be empty when redacted).
    Thinking {
        /// Thinking text, possibly empty.
        text: String,
    },
    /// The model in use was seen on an assistant message.
    ModelSeen {
        /// Model id, e.g. `claude-opus-5-5`.
        model: String,
    },
    /// Token usage of one API response, deduplicated by message id.
    UsageReported {
        /// Model id.
        model: String,
        /// Token counts.
        usage: Usage,
    },
    /// A tool call started.
    ToolStarted {
        /// Pairs with [`EventKind::ToolFinished`].
        tool_use_id: ToolUseId,
        /// Tool name, e.g. `Bash`.
        name: String,
        /// Classification for visuals.
        tool_kind: ToolKind,
        /// One-line human summary, e.g. the command or file path.
        summary: String,
        /// Full tool input.
        input: Value,
    },
    /// A tool call finished.
    ToolFinished {
        /// Pairs with [`EventKind::ToolStarted`].
        tool_use_id: ToolUseId,
        /// Whether the result was an error.
        is_error: bool,
        /// First few KB of the result text.
        output: String,
        /// Duration, when known.
        duration_ms: Option<u64>,
    },
    /// A subagent was spawned by `agent` (the parent).
    SubagentSpawned {
        /// The new agent.
        child: AgentId,
        /// `subagent_type`, e.g. `Explore`.
        agent_type: Option<String>,
        /// Short description given by the parent.
        description: Option<String>,
        /// The parent's `Agent` tool call, when known.
        tool_use_id: Option<ToolUseId>,
    },
    /// A subagent finished.
    SubagentFinished {
        /// The finished agent.
        child: AgentId,
    },
    /// Claude Code is waiting for a permission decision.
    PermissionRequested {
        /// Broker id for this request.
        request_id: RequestId,
        /// Tool name.
        tool_name: String,
        /// Tool input to approve or edit.
        input: Value,
    },
    /// A permission request ended.
    PermissionResolved {
        /// Broker id.
        request_id: RequestId,
        /// How it ended.
        resolution: Resolution,
    },
    /// Context compaction happened.
    Compacted {
        /// `manual` or `auto`, when known.
        trigger: Option<String>,
        /// Tokens before compaction, when known.
        pre_tokens: Option<u64>,
    },
    /// The assistant finished a turn and is waiting for the user.
    TurnEnded {
        /// Turn duration, when known.
        duration_ms: Option<u64>,
    },
    /// A notification from Claude Code (e.g. "Claude needs your input").
    Notification {
        /// Message text.
        message: String,
    },
    /// An API or session error.
    Error {
        /// Error text.
        message: String,
    },
}
