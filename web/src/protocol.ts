// Wire contract between sim-server and the browser.
//
// Mirrors (exactly, snake_case) the Rust types in:
//   crates/sim-core/src/ids.rs, event.rs, state.rs
//   crates/sim-protocol/src/lib.rs
// Keep both sides in sync; bump PROTOCOL_VERSION on breaking changes.

export const PROTOCOL_VERSION = 1;

// ---- ids.rs: newtypes serialize as bare strings (#[serde(transparent)]) ----
export type SessionId = string;
export type AgentId = string;
export type ToolUseId = string;
export type RequestId = string;
export const MAIN_AGENT: AgentId = 'main';

// ---- event.rs ----
/** Milliseconds since the Unix epoch. */
export type TimestampMs = number;

/** Arbitrary JSON (`serde_json::Value`). */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Source = 'transcript' | 'hook' | 'driver' | 'server';

export type ToolKind = 'read' | 'write' | 'search' | 'bash' | 'web' | 'agent' | 'ask' | 'other';

export interface Usage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** `Decision`, tagged by `behavior`. */
export type Decision =
  | { behavior: 'allow'; updated_input?: JsonValue }
  | { behavior: 'deny'; message: string };

/** `Resolution`, tagged by `outcome`. */
export type Resolution = { outcome: 'decided'; decision: Decision } | { outcome: 'fell_back' };

/** `EventKind`, flattened into `Event` and tagged by `type`. */
export type EventKind =
  | { type: 'session_started'; cwd: string | null; git_branch: string | null; version: string | null }
  | { type: 'title'; title: string }
  | { type: 'user_prompt'; text: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'model_seen'; model: string }
  | { type: 'usage_reported'; model: string; usage: Usage }
  | {
      type: 'tool_started';
      tool_use_id: ToolUseId;
      name: string;
      tool_kind: ToolKind;
      summary: string;
      input: JsonValue;
    }
  | {
      type: 'tool_finished';
      tool_use_id: ToolUseId;
      is_error: boolean;
      output: string;
      duration_ms: number | null;
    }
  | {
      type: 'subagent_spawned';
      child: AgentId;
      agent_type: string | null;
      description: string | null;
      tool_use_id: ToolUseId | null;
    }
  | { type: 'subagent_finished'; child: AgentId }
  | { type: 'permission_requested'; request_id: RequestId; tool_name: string; input: JsonValue }
  | { type: 'permission_resolved'; request_id: RequestId; resolution: Resolution }
  | { type: 'compacted'; trigger: string | null; pre_tokens: number | null }
  | { type: 'turn_ended'; duration_ms: number | null }
  | { type: 'notification'; message: string }
  | { type: 'error'; message: string }
  | { type: 'message_sent'; from: AgentId; to: AgentId; channel: MessageChannel; text: string };

/** `MessageChannel`: how a message travelled between two participants. */
export type MessageChannel = 'prompt' | 'dispatch' | 'result' | 'message' | 'notification';

/** Pseudo-agent id for the human in `message_sent` events. */
export const USER_AGENT: AgentId = 'user';

export type EventType = EventKind['type'];

export interface EventBase {
  session: SessionId;
  agent: AgentId;
  at: TimestampMs;
  source: Source;
}

/** One normalized event (`Event` with `kind` flattened). */
export type AgentEvent = EventBase & EventKind;

// ---- state.rs ----
export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'awaiting_permission'
  | 'compacting'
  | 'done'
  | 'error';

export interface ActiveTool {
  tool_use_id: ToolUseId;
  name: string;
  tool_kind: ToolKind;
  summary: string;
  started_at: TimestampMs;
}

export interface PendingPermission {
  request_id: RequestId;
  agent: AgentId;
  tool_name: string;
  input: JsonValue;
  requested_at: TimestampMs;
}

export interface AgentState {
  id: AgentId;
  parent: AgentId | null;
  name: string;
  agent_type: string | null;
  status: AgentStatus;
  model: string | null;
  active_tools: ActiveTool[];
  usage: Usage;
  context_tokens: number;
  context_window: number;
  cost_usd: number;
  tool_calls: number;
  tool_errors: number;
  started_at: TimestampMs;
  last_activity: TimestampMs;
}

export interface SessionState {
  id: SessionId;
  title: string | null;
  cwd: string | null;
  git_branch: string | null;
  /** BTreeMap<AgentId, AgentState> → JSON object. */
  agents: Record<AgentId, AgentState>;
  pending: PendingPermission[];
  cost_usd: number;
  event_count: number;
  started_at: TimestampMs;
  last_activity: TimestampMs;
}

// ---- sim-protocol ----
export type ServerMsg =
  | { t: 'snapshot'; protocol_version: number; sessions: SessionState[] }
  | { t: 'update'; event: AgentEvent; state: SessionState }
  | { t: 'history'; session: SessionId; events: AgentEvent[] }
  | ({ t: 'drive'; session: SessionId } & DrivePhase);

/** Where a browser-driven turn stands (mirrors sim-protocol `DrivePhase`). */
export type DrivePhase =
  | { phase: 'running' }
  | { phase: 'done'; outcome: string }
  | { phase: 'failed'; message: string }
  | { phase: 'interrupted' };

export type ClientMsg =
  | { t: 'decide'; request_id: RequestId; decision: Decision }
  | { t: 'load_history'; session: SessionId }
  | { t: 'prompt'; session: SessionId; text: string }
  | { t: 'interrupt'; session: SessionId };

// ---- sim-protocol: HTTP replay APIs ----
/** One transcript on disk (`GET /api/sessions`), mirrors `SessionSummary`. */
export interface SessionSummary {
  id: SessionId;
  project: string;
  cwd: string | null;
  title: string | null;
  modified_ms: number;
  size_bytes: number;
  subagents: number;
  live: boolean;
}

/** `GET /api/replay/{id}`: every event of a session (incl. subagents), sorted by `at`. */
export interface ReplayResponse {
  session: SessionId;
  events: AgentEvent[];
}
