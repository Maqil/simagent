// Client state. The server owns the state machine: every `update` carries the session's
// full state after the event, so the store only replaces it and appends the event.
import { create } from 'zustand';
import type {
  AgentEvent,
  DrivePhase,
  AgentId,
  ClientMsg,
  Decision,
  PendingPermission,
  RequestId,
  ServerMsg,
  SessionId,
  SessionState,
} from './protocol';
import { PROTOCOL_VERSION, USER_AGENT } from './protocol';
import {
  ReplayTimeline,
  countAtOrBefore,
  playClock,
  serverSource,
  type ReplaySource,
} from './replay';

/** Events kept per session in memory (the Activity list renders the last 2000). */
export const MAX_EVENTS_PER_SESSION = 5000;

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'demo';

/** An event plus a client-side sequence number, stable while the list is trimmed. */
export interface StoredEvent {
  seq: number;
  ev: AgentEvent;
}

/** A browser-driven turn: what was sent, and where it stands. */
export interface DriveStatus {
  phase: DrivePhase['phase'] | 'sending';
  /** Failure reason or result outcome. */
  detail: string | null;
  /** The text sent, shown as a pending bubble until the transcript echoes it. */
  text: string;
  sentAt: number;
}

export type PanelTab = 'review' | 'messages' | 'activity' | 'finished' | 'agents' | 'files';

export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8, 16] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** Seeks forward by more than this many events reset scene effects instead of animating. */
const APPEND_LIMIT = 200;

/** One loaded replay. Everything derived from `cursor` is recomputed only when it moves. */
export interface ReplayData {
  id: SessionId;
  title: string | null;
  timeline: ReplayTimeline;
  /** All events, wrapped; `stored[i].seq === seqBase + i`. */
  stored: StoredEvent[];
  seqBase: number;
  /** Play-clock offset of every event (see `playClock`). */
  clock: Float64Array;
  /** Number of events applied (the playhead sits after event `cursor - 1`). */
  cursor: number;
  /** Play-clock position in ms; moves smoothly while playing. */
  playT: number;
  /** `stored.slice(0, cursor)`. */
  visible: StoredEvent[];
  /** `timeline.events.slice(0, cursor)`, for the scene. */
  visibleEvents: AgentEvent[];
  state: SessionState;
  playing: boolean;
  speed: ReplaySpeed;
  skipIdle: boolean;
  /** Bumped on backward seeks and long jumps, so the scene clears its effects. */
  seekCounter: number;
}

export interface ReplayStatus {
  loading: SessionId | null;
  error: string | null;
}

export interface PendingRef {
  session: SessionState;
  pending: PendingPermission;
}

interface Store {
  connection: ConnectionState;
  /** Delay before the next reconnect attempt, when reconnecting. */
  retryInMs: number | null;
  protocolWarning: string | null;
  sessions: Record<SessionId, SessionState>;
  events: Record<SessionId, StoredEvent[]>;
  historyRequested: Record<SessionId, boolean>;
  selectedSession: SessionId | null;
  selectedAgent: AgentId | null;
  panelTab: PanelTab;
  /** Event the Activity list should scroll to and highlight (set by the timeline). */
  focusSeq: number | null;
  /** Request ids already decided locally, hidden until the server confirms. */
  decided: Record<RequestId, true>;
  /** Browser-driven turn status per session (from `drive` messages). */
  drive: Record<SessionId, DriveStatus>;
  /** Tabs the user closed, with the session's `last_activity` at close time. A session
   *  reopens on its own when it becomes active again. Persisted in localStorage. */
  closed: Record<SessionId, number>;
  closeSession: (id: SessionId) => void;
  send: (msg: ClientMsg) => void;
  /** Continues `session` with `text` (headless `claude -p --resume`). */
  sendPrompt: (session: SessionId, text: string) => void;
  /** Stops the turn simagent is driving for `session`. */
  interruptTurn: (session: SessionId) => void;

  setTransport: (send: (msg: ClientMsg) => void) => void;
  setConnection: (c: ConnectionState, retryInMs?: number | null) => void;
  receive: (msg: ServerMsg) => void;
  selectSession: (id: SessionId) => void;
  /** Selects an agent; switches to the Agents tab unless `keepTab`. */
  selectAgent: (id: AgentId | null, opts?: { keepTab?: boolean }) => void;
  setPanelTab: (tab: PanelTab) => void;
  focusEvent: (seq: number | null) => void;
  decide: (requestId: RequestId, decision: Decision) => void;

  // ---- session browser + replay
  replaySource: ReplaySource;
  browserOpen: boolean;
  replay: ReplayData | null;
  replayStatus: ReplayStatus;
  setReplaySource: (src: ReplaySource) => void;
  setBrowserOpen: (open: boolean) => void;
  /** Loads a session and enters replay mode at its start (playing when `autoplay`). */
  openReplay: (id: SessionId, opts?: { title?: string | null; autoplay?: boolean }) => Promise<void>;
  /** Enters replay mode on an already-loaded event list. */
  startReplay: (id: SessionId, events: AgentEvent[], opts?: { title?: string | null; autoplay?: boolean }) => void;
  exitReplay: () => void;
  replaySetPlaying: (playing: boolean) => void;
  replaySetSpeed: (speed: ReplaySpeed) => void;
  replaySetSkipIdle: (skip: boolean) => void;
  /** Moves the playhead so exactly `count` events are applied. */
  replaySeek: (count: number) => void;
  /** Moves the playhead to a play-clock time. */
  replaySeekTime: (t: number) => void;
  /** Steps one event forward (+1) or back (-1). */
  replayStep: (dir: 1 | -1) => void;
  /** Jumps to the next (+1) or previous (-1) message_sent event. */
  replayJumpMessage: (dir: 1 | -1) => void;
  /** Advances playback by `dtMs` of wall time. */
  replayTick: (dtMs: number) => void;
}

let nextSeq = 1;
const wrap = (ev: AgentEvent): StoredEvent => ({ seq: nextSeq++, ev });

function trim(list: StoredEvent[]): StoredEvent[] {
  return list.length > MAX_EVENTS_PER_SESSION
    ? list.slice(list.length - MAX_EVENTS_PER_SESSION)
    : list;
}

/** Merges a history reply with events that arrived live, dropping duplicates. */
function mergeHistory(history: AgentEvent[], live: StoredEvent[]): StoredEvent[] {
  const seen = new Set<string>();
  const out: StoredEvent[] = [];
  for (const ev of history) {
    const key = JSON.stringify(ev);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(wrap(ev));
  }
  for (const se of live) {
    if (!seen.has(JSON.stringify(se.ev))) out.push(se);
  }
  // Stable sort by time: history is oldest first, live events are appended in order.
  out.sort((a, b) => a.ev.at - b.ev.at || a.seq - b.seq);
  return trim(out);
}

function mostRecent(sessions: Record<SessionId, SessionState>, closed: Record<SessionId, number> = {}): SessionId | null {
  let best: SessionState | null = null;
  for (const s of Object.values(sessions)) {
    if (isClosed(s, closed)) continue;
    if (!best || s.last_activity > best.last_activity) best = s;
  }
  return best?.id ?? null;
}

/** Recomputes everything derived from a new cursor/playT. */
function moved(r: ReplayData, cursor: number, playT: number, reset: boolean): ReplayData {
  const n = Math.max(0, Math.min(r.stored.length, cursor));
  if (n === r.cursor && !reset) return { ...r, playT };
  const backward = n < r.cursor;
  const far = n - r.cursor > APPEND_LIMIT;
  return {
    ...r,
    cursor: n,
    playT,
    visible: r.stored.slice(0, n),
    visibleEvents: r.timeline.events.slice(0, n),
    state: r.timeline.stateAt(n),
    seekCounter: r.seekCounter + (reset || backward || far ? 1 : 0),
  };
}

/** Play-clock time at which the playhead shows `count` events. */
const timeOf = (r: ReplayData, count: number): number =>
  count <= 0 ? 0 : (r.clock[Math.min(count, r.clock.length) - 1] ?? 0);

let replayLoadToken = 0;

export const useStore = create<Store>((set, get) => ({
  connection: 'connecting',
  retryInMs: null,
  protocolWarning: null,
  sessions: {},
  events: {},
  historyRequested: {},
  selectedSession: null,
  selectedAgent: null,
  panelTab: 'messages',
  drive: {},
  closed: loadClosed(),
  closeSession: (id) => {
    const st = get();
    const closed = { ...st.closed, [id]: st.sessions[id]?.last_activity ?? Date.now() };
    saveClosed(closed);
    let selectedSession = st.selectedSession;
    if (selectedSession === id) {
      const next = sortedSessions(st.sessions).find((s) => s.id !== id && !isClosed(s, closed));
      selectedSession = next?.id ?? null;
    }
    set({ closed, selectedSession, selectedAgent: null, focusSeq: null });
    if (st.replay?.id === id) get().exitReplay();
    if (selectedSession) get().selectSession(selectedSession);
  },
  focusSeq: null,
  decided: {},
  send: () => {},

  setTransport: (send) => set({ send }),
  sendPrompt: (session, text) => {
    const t = text.trim();
    if (!t) return;
    get().send({ t: 'prompt', session, text: t });
    set((st) => ({ drive: { ...st.drive, [session]: { phase: 'sending', detail: null, text: t, sentAt: Date.now() } } }));
  },
  interruptTurn: (session) => get().send({ t: 'interrupt', session }),
  setConnection: (connection, retryInMs = null) => set({ connection, retryInMs }),

  receive: (msg) => {
    switch (msg.t) {
      case 'snapshot': {
        const sessions: Record<SessionId, SessionState> = {};
        for (const s of msg.sessions) sessions[s.id] = s;
        const prev = get().selectedSession;
        const selected = prev && sessions[prev] ? prev : mostRecent(sessions, get().closed);
        set({
          sessions,
          historyRequested: {},
          decided: {},
          selectedSession: selected,
          protocolWarning:
            msg.protocol_version === PROTOCOL_VERSION
              ? null
              : `Server speaks protocol v${msg.protocol_version}, UI expects v${PROTOCOL_VERSION}`,
        });
        // A (re)connect snapshot invalidates history: re-request for the open tab.
        if (selected) get().selectSession(selected);
        break;
      }
      case 'update': {
        const { event, state } = msg;
        set((st) => {
          const list = st.events[state.id] ?? [];
          const sessions = { ...st.sessions, [state.id]: state };
          // Drop local "decided" marks the server has now cleared.
          let decided = st.decided;
          if (event.type === 'permission_resolved' && decided[event.request_id]) {
            decided = { ...decided };
            delete decided[event.request_id];
          }
          return {
            sessions,
            decided,
            events: { ...st.events, [state.id]: trim([...list, wrap(event)]) },
            selectedSession: st.selectedSession ?? state.id,
          };
        });
        if (!get().historyRequested[state.id] && get().selectedSession === state.id) {
          get().selectSession(state.id);
        }
        break;
      }
      case 'drive': {
        const prev = get().drive[msg.session];
        const detail = msg.phase === 'failed' ? msg.message : msg.phase === 'done' ? msg.outcome : null;
        set((st) => ({
          drive: {
            ...st.drive,
            [msg.session]: { phase: msg.phase, detail, text: prev?.text ?? '', sentAt: prev?.sentAt ?? Date.now() },
          },
        }));
        break;
      }
      case 'history': {
        set((st) => ({
          events: {
            ...st.events,
            [msg.session]: mergeHistory(msg.events, st.events[msg.session] ?? []),
          },
        }));
        break;
      }
      default:
        // Unknown message kinds from a newer server are ignored, never fatal.
        break;
    }
  },

  selectSession: (id) => {
    const st = get();
    const changed = st.selectedSession !== id;
    set({
      selectedSession: id,
      selectedAgent: changed ? null : st.selectedAgent,
      focusSeq: changed ? null : st.focusSeq,
    });
    if (!get().historyRequested[id]) {
      set((s) => ({ historyRequested: { ...s.historyRequested, [id]: true } }));
      get().send({ t: 'load_history', session: id });
    }
  },

  selectAgent: (id, opts) =>
    set(
      id
        ? opts?.keepTab || id === USER_AGENT
          ? { selectedAgent: id }
          : { selectedAgent: id, panelTab: 'agents' }
        : { selectedAgent: null },
    ),
  setPanelTab: (panelTab) => set({ panelTab }),
  focusEvent: (focusSeq) => set(focusSeq === null ? { focusSeq } : { focusSeq, panelTab: 'activity' }),

  decide: (requestId, decision) => {
    get().send({ t: 'decide', request_id: requestId, decision });
    set((st) => ({ decided: { ...st.decided, [requestId]: true } }));
  },

  replaySource: serverSource,
  browserOpen: false,
  replay: null,
  replayStatus: { loading: null, error: null },
  setReplaySource: (replaySource) => set({ replaySource }),
  setBrowserOpen: (browserOpen) => set({ browserOpen }),

  openReplay: async (id, opts) => {
    const token = ++replayLoadToken;
    set({ replayStatus: { loading: id, error: null }, browserOpen: false });
    try {
      let events = await get().replaySource.load(id);
      // A live session the server cannot read from disk: fall back to what we hold.
      if (!events.length) events = (get().events[id] ?? []).map((se) => se.ev);
      if (token !== replayLoadToken) return;
      get().startReplay(id, events, {
        title: opts?.title ?? get().sessions[id]?.title ?? null,
        autoplay: opts?.autoplay,
      });
    } catch (e) {
      if (token !== replayLoadToken) return;
      const local = get().events[id];
      if (local?.length) {
        get().startReplay(id, local.map((se) => se.ev), { title: opts?.title, autoplay: opts?.autoplay });
        return;
      }
      set({ replayStatus: { loading: null, error: e instanceof Error ? e.message : String(e) } });
    }
  },

  startReplay: (id, events, opts) => {
    const timeline = new ReplayTimeline(id, events);
    const seqBase = nextSeq;
    nextSeq += events.length;
    const stored = events.map((ev, i) => ({ seq: seqBase + i, ev }));
    const state = timeline.stateAt(0);
    const title = opts?.title ?? timeline.stateAt(events.length).title;
    set((st) => ({
      replay: {
        id,
        title,
        timeline,
        stored,
        seqBase,
        clock: playClock(events, true),
        cursor: 0,
        playT: 0,
        visible: [],
        visibleEvents: [],
        state,
        playing: opts?.autoplay ?? false,
        speed: st.replay?.speed ?? 1,
        skipIdle: st.replay?.skipIdle ?? true,
        seekCounter: 0,
      },
      replayStatus: { loading: null, error: null },
      selectedAgent: null,
      focusSeq: null,
    }));
  },

  exitReplay: () => {
    replayLoadToken++;
    set({ replay: null, replayStatus: { loading: null, error: null }, selectedAgent: null, focusSeq: null });
  },

  replaySetPlaying: (playing) =>
    set((st) => {
      const r = st.replay;
      if (!r) return {};
      // Pressing play at the end restarts from the beginning.
      if (playing && r.cursor >= r.stored.length) return { replay: { ...moved(r, 0, 0, true), playing } };
      return { replay: { ...r, playing } };
    }),
  replaySetSpeed: (speed) => set((st) => (st.replay ? { replay: { ...st.replay, speed } } : {})),
  replaySetSkipIdle: (skipIdle) =>
    set((st) => {
      const r = st.replay;
      if (!r) return {};
      const clock = playClock(r.timeline.events, skipIdle);
      const next = { ...r, skipIdle, clock };
      return { replay: { ...next, playT: timeOf(next, r.cursor) } };
    }),

  replaySeek: (count) =>
    set((st) => {
      const r = st.replay;
      if (!r) return {};
      const n = Math.max(0, Math.min(r.stored.length, Math.round(count)));
      return { replay: moved(r, n, timeOf(r, n), false) };
    }),
  replaySeekTime: (t) =>
    set((st) => {
      const r = st.replay;
      if (!r) return {};
      const end = r.clock[r.clock.length - 1] ?? 0;
      const tt = Math.max(0, Math.min(end, t));
      return { replay: moved(r, countAtOrBefore(r.clock, tt), tt, false) };
    }),
  replayStep: (dir) => {
    const r = get().replay;
    if (r) get().replaySeek(r.cursor + dir);
  },
  replayJumpMessage: (dir) => {
    const r = get().replay;
    if (!r) return;
    const evs = r.timeline.events;
    if (dir > 0) {
      for (let i = r.cursor; i < evs.length; i++) {
        if (evs[i]!.type === 'message_sent') return get().replaySeek(i + 1);
      }
      get().replaySeek(evs.length);
    } else {
      // The message at cursor-1 is the current one; look before it.
      for (let i = r.cursor - 2; i >= 0; i--) {
        if (evs[i]!.type === 'message_sent') return get().replaySeek(i + 1);
      }
      get().replaySeek(0);
    }
  },
  replayTick: (dtMs) =>
    set((st) => {
      const r = st.replay;
      if (!r || !r.playing) return {};
      const end = r.clock[r.clock.length - 1] ?? 0;
      const t = Math.min(end, r.playT + dtMs * r.speed);
      const next = moved(r, countAtOrBefore(r.clock, t), t, false);
      return { replay: t >= end ? { ...next, cursor: next.cursor, playing: false } : next };
    }),
}));

const NO_EVENTS: StoredEvent[] = [];

/** Events of a session as currently visible: up to the playhead in replay, else the live list. */
export function useSessionEvents(id: SessionId): StoredEvent[] {
  return useStore((s) => (s.replay && s.replay.id === id ? s.replay.visible : (s.events[id] ?? NO_EVENTS)));
}

/** True while a replay is shown. */
export const useIsReplay = (): boolean => useStore((s) => s.replay !== null);

/** All undecided pending requests across sessions, oldest first. */
export function pendingQueue(
  sessions: Record<SessionId, SessionState>,
  decided: Record<RequestId, true>,
): PendingRef[] {
  const out: PendingRef[] = [];
  for (const session of Object.values(sessions)) {
    for (const pending of session.pending) {
      if (!decided[pending.request_id]) out.push({ session, pending });
    }
  }
  out.sort((a, b) => a.pending.requested_at - b.pending.requested_at);
  return out;
}

/** Sessions ordered by last activity, newest first. */
const CLOSED_KEY = 'simagent.closedTabs';

function loadClosed(): Record<SessionId, number> {
  try {
    const raw = localStorage.getItem(CLOSED_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? (v as Record<SessionId, number>) : {};
  } catch {
    return {};
  }
}

function saveClosed(c: Record<SessionId, number>): void {
  try {
    localStorage.setItem(CLOSED_KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable */
  }
}

/** A closed tab stays hidden until the session has activity after it was closed. */
export function isClosed(s: SessionState, closed: Record<SessionId, number>): boolean {
  const at = closed[s.id];
  return at !== undefined && s.last_activity <= at;
}

/** Sessions shown as tabs: not closed, most recently active first. */
export function openSessions(sessions: Record<SessionId, SessionState>, closed: Record<SessionId, number>): SessionState[] {
  return sortedSessions(sessions).filter((s) => !isClosed(s, closed));
}

export function sortedSessions(sessions: Record<SessionId, SessionState>): SessionState[] {
  return Object.values(sessions).sort((a, b) => b.last_activity - a.last_activity);
}
