// Replay: re-derive a session's state client-side from its event list.
//
// Live mode never folds state (the server sends it with every update). Replay needs the
// state at any point in the past, so this module ports sim-core's rules:
//   crates/sim-core/src/state_impl.rs  → applyEvent / newSession
//   crates/sim-core/src/cost.rs        → modelInfo / costUsd / contextWindow
// Keep them in sync when the Rust rules change.
import type {
  AgentEvent,
  AgentId,
  AgentState,
  AgentStatus,
  SessionId,
  SessionState,
  SessionSummary,
  ReplayResponse,
  TimestampMs,
  Usage,
} from './protocol';
import { MAIN_AGENT } from './protocol';
import { getToken } from './connection';

// ---------------------------------------------------------------- cost.rs

interface ModelInfo {
  family: string;
  context_window: number;
  input_per_mtok: number;
  output_per_mtok: number;
}

/** Matched in order against the lowercased model id (same table as cost.rs). */
const MODELS: readonly ModelInfo[] = [
  { family: 'fable', context_window: 1_000_000, input_per_mtok: 10, output_per_mtok: 50 },
  { family: 'mythos', context_window: 1_000_000, input_per_mtok: 10, output_per_mtok: 50 },
  { family: 'opus', context_window: 1_000_000, input_per_mtok: 5, output_per_mtok: 25 },
  { family: 'sonnet', context_window: 1_000_000, input_per_mtok: 3, output_per_mtok: 15 },
  { family: 'haiku', context_window: 200_000, input_per_mtok: 1, output_per_mtok: 5 },
];
const CACHE_WRITE_FACTOR = 1.25;
const CACHE_READ_FACTOR = 0.1;

export function modelInfo(model: string): ModelInfo | null {
  const id = model.toLowerCase();
  return MODELS.find((m) => id.includes(m.family)) ?? null;
}

export function contextWindow(model: string): number {
  return modelInfo(model)?.context_window ?? 200_000;
}

export function costUsd(model: string, u: Usage): number {
  const info = modelInfo(model);
  if (!info) return 0;
  const inputSide = u.input + u.cache_write * CACHE_WRITE_FACTOR + u.cache_read * CACHE_READ_FACTOR;
  return (inputSide * info.input_per_mtok + u.output * info.output_per_mtok) / 1_000_000;
}

// ---------------------------------------------------------------- state_impl.rs

export function newAgent(id: AgentId, parent: AgentId | null, name: string, at: TimestampMs): AgentState {
  return {
    id,
    parent,
    name,
    agent_type: null,
    status: 'idle',
    model: null,
    active_tools: [],
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    context_tokens: 0,
    context_window: 200_000,
    cost_usd: 0,
    tool_calls: 0,
    tool_errors: 0,
    started_at: at,
    last_activity: at,
  };
}

export function newSession(id: SessionId, at: TimestampMs): SessionState {
  return {
    id,
    title: null,
    cwd: null,
    git_branch: null,
    agents: { [MAIN_AGENT]: newAgent(MAIN_AGENT, null, 'main', at) },
    pending: [],
    cost_usd: 0,
    event_count: 0,
    started_at: at,
    last_activity: at,
  };
}

const busyStatus = (a: AgentState): AgentStatus => (a.active_tools.length ? 'tool' : 'thinking');

function ensureAgent(s: SessionState, id: AgentId, at: TimestampMs): AgentState {
  return (s.agents[id] ??= newAgent(id, null, id, at));
}

/** Applies one event to `s` in place (port of `SessionState::apply`). */
export function applyEvent(s: SessionState, e: AgentEvent): void {
  const at = e.at;
  s.event_count += 1;
  s.last_activity = Math.max(s.last_activity, at);
  const agent = ensureAgent(s, e.agent, at);
  agent.last_activity = Math.max(agent.last_activity, at);

  switch (e.type) {
    case 'session_started':
      if (e.cwd !== null) s.cwd = e.cwd;
      if (e.git_branch !== null) s.git_branch = e.git_branch;
      break;
    case 'title':
      s.title = e.title;
      break;
    case 'user_prompt':
      agent.status = 'thinking';
      break;
    case 'thinking':
    case 'assistant_text':
      agent.status = busyStatus(agent);
      break;
    case 'model_seen':
      agent.context_window = contextWindow(e.model);
      agent.model = e.model;
      break;
    case 'usage_reported': {
      const cost = costUsd(e.model, e.usage);
      agent.usage.input += e.usage.input;
      agent.usage.output += e.usage.output;
      agent.usage.cache_read += e.usage.cache_read;
      agent.usage.cache_write += e.usage.cache_write;
      agent.context_tokens = e.usage.input + e.usage.cache_read + e.usage.cache_write;
      agent.cost_usd += cost;
      s.cost_usd += cost;
      break;
    }
    case 'tool_started':
      agent.active_tools.push({
        tool_use_id: e.tool_use_id,
        name: e.name,
        tool_kind: e.tool_kind,
        summary: e.summary,
        started_at: at,
      });
      agent.tool_calls += 1;
      agent.status = 'tool';
      break;
    case 'tool_finished':
      agent.active_tools = agent.active_tools.filter((t) => t.tool_use_id !== e.tool_use_id);
      if (e.is_error) agent.tool_errors += 1;
      agent.status = busyStatus(agent);
      break;
    case 'subagent_spawned': {
      const child = ensureAgent(s, e.child, at);
      child.parent = e.agent;
      child.name = e.description ?? e.agent_type ?? e.child;
      if (e.agent_type !== null) child.agent_type = e.agent_type;
      child.status = 'thinking';
      child.last_activity = Math.max(child.last_activity, at);
      break;
    }
    case 'subagent_finished': {
      const child = ensureAgent(s, e.child, at);
      child.status = 'done';
      child.active_tools = [];
      child.last_activity = Math.max(child.last_activity, at);
      break;
    }
    case 'permission_requested':
      s.pending.push({
        request_id: e.request_id,
        agent: e.agent,
        tool_name: e.tool_name,
        input: e.input,
        requested_at: at,
      });
      agent.status = 'awaiting_permission';
      break;
    case 'permission_resolved': {
      const i = s.pending.findIndex((p) => p.request_id === e.request_id);
      const asker = i >= 0 ? s.pending.splice(i, 1)[0]!.agent : e.agent;
      const stillWaiting = s.pending.some((p) => p.agent === asker);
      const a = ensureAgent(s, asker, at);
      if (!stillWaiting && a.status === 'awaiting_permission') a.status = busyStatus(a);
      break;
    }
    case 'compacted':
      agent.status = 'compacting';
      break;
    case 'turn_ended':
      agent.status = 'idle';
      agent.active_tools = [];
      break;
    case 'error':
      agent.status = 'error';
      break;
    case 'notification':
    case 'message_sent':
      break;
    default:
      // Unknown kinds from a newer server only count as activity.
      break;
  }
}

/** Folds a whole event list into a fresh state. */
export function foldState(id: SessionId, events: readonly AgentEvent[]): SessionState {
  const s = newSession(id, events[0]?.at ?? 0);
  for (const e of events) applyEvent(s, e);
  return s;
}

// ---------------------------------------------------------------- seeking

/** A checkpoint (deep copy of the state) is kept every this many events. */
export const CHECKPOINT_EVERY = 500;

/** An immutable event list with checkpoints, so `stateAt` is O(CHECKPOINT_EVERY). */
export class ReplayTimeline {
  readonly id: SessionId;
  readonly events: readonly AgentEvent[];
  /** `checkpoints[k]` is the state after `k * CHECKPOINT_EVERY` events. */
  private readonly checkpoints: SessionState[] = [];

  constructor(id: SessionId, events: readonly AgentEvent[]) {
    this.id = id;
    this.events = events;
    const s = newSession(id, events[0]?.at ?? 0);
    this.checkpoints.push(structuredClone(s));
    events.forEach((e, i) => {
      applyEvent(s, e);
      if ((i + 1) % CHECKPOINT_EVERY === 0) this.checkpoints.push(structuredClone(s));
    });
  }

  get length(): number {
    return this.events.length;
  }

  /** State after the first `count` events (a fresh object each call). */
  stateAt(count: number): SessionState {
    const n = Math.max(0, Math.min(this.events.length, Math.floor(count)));
    const k = Math.min(Math.floor(n / CHECKPOINT_EVERY), this.checkpoints.length - 1);
    const s = structuredClone(this.checkpoints[k]!);
    for (let i = k * CHECKPOINT_EVERY; i < n; i++) applyEvent(s, this.events[i]!);
    return s;
  }
}

// ---------------------------------------------------------------- play clock

/** Gaps longer than this are idle when "skip idle gaps" is on… */
export const IDLE_GAP_MS = 3_000;
/** …and are played back as this long. */
export const IDLE_COMPRESSED_MS = 500;

/**
 * Play-clock offset (ms) of every event: `clock[i]` is when event `i` is reached during
 * playback at 1x. With `skipIdle`, gaps > IDLE_GAP_MS shrink to IDLE_COMPRESSED_MS.
 */
export function playClock(events: readonly AgentEvent[], skipIdle: boolean): Float64Array {
  const out = new Float64Array(events.length);
  let t = 0;
  for (let i = 1; i < events.length; i++) {
    const gap = Math.max(0, events[i]!.at - events[i - 1]!.at);
    t += skipIdle && gap > IDLE_GAP_MS ? IDLE_COMPRESSED_MS : gap;
    out[i] = t;
  }
  return out;
}

/** Number of entries of the sorted `clock` that are <= `t`. */
export function countAtOrBefore(clock: Float64Array, t: number): number {
  let lo = 0;
  let hi = clock.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (clock[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------- data sources

/** Where the session browser and replay get their data (the server, or the demo). */
export interface ReplaySource {
  list(): Promise<SessionSummary[]>;
  load(id: SessionId): Promise<AgentEvent[]>;
}

async function getJson<T>(path: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${path}${sep}token=${encodeURIComponent(getToken())}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
  }
  return (await res.json()) as T;
}

export const serverSource: ReplaySource = {
  list: () => getJson<SessionSummary[]>('/api/sessions'),
  load: async (id) => {
    const r = await getJson<ReplayResponse>(`/api/replay/${encodeURIComponent(id)}`);
    // The server sorts by `at`; sort again (stable) so a misbehaving source can't break seeking.
    return [...r.events].sort((a, b) => a.at - b.at);
  },
};
