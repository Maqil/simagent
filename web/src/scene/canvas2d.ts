// Canvas 2D scene renderer: the stand-in until the WebGPU renderer (Phase 5).
//
// The scene is about communication: messages fly between agents (and the human) as
// glowing comets, tools appear as satellites that stream data into or out of their agent,
// and finished subagents bow out. Effects are time-based on an effect clock that runs at
// the replay speed, live in fixed-size pools (oldest dropped) and are drawn with
// pre-rendered sprites, so the hot loop allocates nothing.
//
// Render-on-demand: a frame is drawn when something changed (state, events, resize,
// pan/zoom, hover). The requestAnimationFrame loop only keeps running while an agent is
// busy or an effect is alive.
import type { AgentEvent, AgentId, AgentState, AgentStatus, SessionState, ToolKind } from '../protocol';
import { USER_AGENT } from '../protocol';
import { channelColor, color, fontMono, fontSans, statusColor, toolKindColor } from '../tokens';
import { isBusy } from '../format';
import {
  CHILD_RADIUS,
  layout,
  ROOT_RADIUS,
  USER_RADIUS,
  type BoxSize,
  type LayoutResult,
} from './layout';
import { botSprite, dotSprite, dotTile, glowSprite, rgba, toolIconSprite } from './sprites';
import { BOT_H, BOT_W, botFrame, frameOf, poseFor, prewarm } from './bots';
import type { PushOptions, SceneOptions, SceneRenderer } from './types';

const GRID = 28;
const SHAKE_MS = 500;
const MOVE_EPS = 0.4;
const PILL_MAX_W = 210;
const PILL_FONT = 12;
const LABEL_FONT = 11;
const ROW_H = 18;
const MAX_TOOL_ROWS = 3;
const MIN_ZOOM = 0.15;
const FONT_PILL = `600 ${PILL_FONT}px ${fontSans}`;
const FONT_TOOL = `500 ${LABEL_FONT}px ${fontMono}`;
const FONT_BUBBLE = `500 ${LABEL_FONT}px ${fontSans}`;
const FONT_BADGE = `600 ${LABEL_FONT}px ${fontSans}`;
const FONT_INBOX = `700 9px ${fontMono}`;
const FONT_INBOX_SMALL = `700 7px ${fontMono}`;
const MAX_ZOOM = 3;

// Effects (durations in effect-clock seconds).
const MAX_COMETS = 200;
const MAX_PARTICLES = 2000;
const MAX_RIPPLES = 160;
const MAX_LABELS = 6;
const COMET_DUR = 0.9;
const TAIL = 9;
const RIPPLE_DUR = 0.8;
const RECV_DUR = 0.6;
const SEND_DUR = 0.3;
const SAT_IN = 0.35;
const SAT_OUT = 0.55;
const STREAM_RATE = 12; // particles per second per streaming satellite
const SEEK_WINDOW_MS = 2000;
const EXIT_DELAY = 0.95; // let the result comet land first
const EXIT_DUR = 0.6;

interface NameInfo {
  lines: string[];
  widths: number[];
  w: number;
  h: number;
}

interface Satellite {
  id: string;
  agent: AgentId;
  kind: ToolKind;
  color: string;
  icon: HTMLCanvasElement;
  dot: HTMLCanvasElement;
  label: string;
  labelW: number;
  start: number;
  /** Clock time the tool finished, or -1 while running. */
  endAt: number;
  /** 0 unknown, 1 ok, 2 error. */
  result: 0 | 1 | 2;
  emitAcc: number;
  child: AgentId | null;
  x: number;
  y: number;
}

interface Visual {
  id: AgentId;
  /** Animation phase offset in seconds, stable per agent. */
  phase: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  radius: number;
  status: AgentStatus;
  statusSince: number;
  name: NameInfo;
  nameKey: string;
  /** Nearest visible ancestor (edge target). */
  parent: AgentId | null;
  /** Effect-clock time the exit started, or -1. */
  exitStart: number;
  recvAt: number;
  recvColor: string;
  sendAt: number;
  inbox: number;
  inboxAt: number;
  edgeUntil: number;
  edgeColor: string;
  sats: Satellite[];
  finished: number;
  finishedLabel: string;
  finishedW: number;
  /** Hover key of the badge (`finished:<id>`). */
  badgeKey: string;
  /** "✓ N finished" badge hit box in world units (bw = 0 when none). */
  bx: number;
  by: number;
  bw: number;
  bh: number;
}

interface Comet {
  alive: boolean;
  from: AgentId;
  to: AgentId;
  /** Fixed source point for senders that are not in the scene (background tasks). */
  fixedFrom: boolean;
  fx: number;
  fy: number;
  start: number;
  dur: number;
  color: string;
  img: HTMLCanvasElement;
  label: string;
  labelW: number;
  arrived: boolean;
  /** +1 / -1: which side of the chord the curve bulges to. */
  bend: number;
}

interface Particle {
  alive: boolean;
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  start: number;
  dur: number;
  size: number;
  img: HTMLCanvasElement;
}

interface Ripple {
  alive: boolean;
  agent: AgentId;
  start: number;
  dur: number;
  r0: number;
  r1: number;
  color: string;
}

const ICON_KINDS: Record<ToolKind, ToolKind> = {
  read: 'read',
  write: 'write',
  search: 'search',
  bash: 'bash',
  web: 'web',
  agent: 'agent',
  ask: 'ask',
  other: 'other',
};

export function createCanvas2DRenderer(
  canvas: HTMLCanvasElement,
  options: SceneOptions = {},
): SceneRenderer {
  const maybeCtx = canvas.getContext('2d');
  if (!maybeCtx) throw new Error('Canvas 2D is not available');
  const ctx: CanvasRenderingContext2D = maybeCtx;

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionQuery.matches;

  let session: SessionState | null = null;
  let sessionId: string | null = null;
  let lay: LayoutResult | null = null;
  const visuals = new Map<AgentId, Visual>();
  /** Agents blocked on a human permission decision; refilled in `setState`, read per frame. */
  const waiting = new Set<AgentId>();
  const nameCache = new Map<string, NameInfo>();
  let selected: AgentId | null = null;
  let hovered: AgentId | null = null;

  // The human ("you") node.
  let userSeen = false;
  let layoutDirty = false;
  const user = {
    shown: false,
    x: 0,
    y: 0,
    tx: 0,
    ty: 0,
    appearAt: -1e9,
    recvAt: -1e9,
    sendAt: -1e9,
    recvColor: color.holoBase as string,
    inbox: 0,
    inboxAt: -1e9,
  };

  // Effect clock (seconds), advanced by frame dt × timeScale.
  let clock = 0;
  let timeScale = 1;
  let lastNow = 0;
  // Set during a draw when something wants slow ambient frames (idle standby motion).
  let lazy = false;
  let lazyTimer = 0;

  // Pools: ring buffers, the next slot overwrites the oldest.
  const comets: Comet[] = [];
  for (let i = 0; i < MAX_COMETS; i++) {
    comets.push({
      alive: false,
      from: '',
      to: '',
      fixedFrom: false,
      fx: 0,
      fy: 0,
      start: 0,
      dur: 1,
      color: '',
      img: dotSprite(color.holoBase),
      label: '',
      labelW: 0,
      arrived: false,
      bend: 1,
    });
  }
  const particles: Particle[] = [];
  for (let i = 0; i < MAX_PARTICLES; i++) {
    particles.push({
      alive: false,
      x0: 0,
      y0: 0,
      cx: 0,
      cy: 0,
      x1: 0,
      y1: 0,
      start: 0,
      dur: 1,
      size: 1,
      img: comets[0]!.img,
    });
  }
  const ripples: Ripple[] = [];
  for (let i = 0; i < MAX_RIPPLES; i++) {
    ripples.push({ alive: false, agent: '', start: 0, dur: 1, r0: 0, r1: 0, color: '' });
  }
  let cometHead = 0;
  let particleHead = 0;
  let rippleHead = 0;
  let cometLive = 0;
  let particleLive = 0;
  let rippleLive = 0;
  const satellites = new Map<string, Satellite>();
  /** Agent tool_use_id → spawned child, for dispatch beams. */
  const toolChild = new Map<string, AgentId>();
  /** Indices of the newest comets that get a speech bubble this frame. */
  const labelSlots = new Int32Array(MAX_LABELS);

  // Scratch point outputs (no per-frame allocation).
  const pA = { x: 0, y: 0 };
  const pB = { x: 0, y: 0 };
  const pC = { x: 0, y: 0 };

  // Camera: world → screen is `screen = (world * zoom) + (pan + center)` in CSS pixels.
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let tZoom = 1;
  let tPanX = 0;
  let tPanY = 0;
  let userMovedCamera = false;
  let cssW = 1;
  let cssH = 1;
  let dpr = 1;

  let raf = 0;
  let destroyed = false;
  const gridPattern = ctx.createPattern(dotTile(GRID, rgba(color.holoBase, 0.16)), 'repeat');
  const gridMatrix = new DOMMatrix();
  const bot = botSprite(color.mascotBody, color.mascotEye);
  // Rasterise every bot pose once up front so the first animations don't hitch.
  prewarm(color.mascotBody, statusColor.thinking);
  prewarm(SUB_BODY, statusColor.thinking);

  // ---------------------------------------------------------------- scheduling
  function requestFrame() {
    if (lazyTimer) {
      clearTimeout(lazyTimer);
      lazyTimer = 0;
    }
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    raf = 0;
    const dt = lastNow ? Math.min(now - lastNow, 250) / 1000 : 1 / 60;
    lastNow = now;
    clock += dt * timeScale;
    lazy = false;
    const animating = draw(now, dt);
    options.onViewChanged?.();
    if (animating) requestFrame();
    else {
      lastNow = 0;
      // Only slow ambient motion (idle bots) left: redraw a few times a second instead of
      // every display frame, so an idle scene stays cheap.
      if (lazy && !destroyed) lazyTimer = window.setTimeout(requestFrame, LAZY_MS);
    }
  }

  // ---------------------------------------------------------------- measuring
  function nameInfo(name: string): NameInfo {
    let info = nameCache.get(name);
    if (info) return info;
    ctx.font = FONT_PILL;
    const words = name.split(/\s+/).filter(Boolean);
    let lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(next).width <= PILL_MAX_W || !cur) cur = next;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    // Never truncate: if longer than two lines, fold the rest into the second line.
    if (lines.length > 2) lines = [lines[0]!, lines.slice(1).join(' ')];
    if (!lines.length) lines = ['agent'];
    const widths = lines.map((l) => ctx.measureText(l).width);
    let tw = 0;
    for (const w of widths) tw = Math.max(tw, w);
    info = { lines, widths, w: tw + 30, h: lines.length * (PILL_FONT + 3) + 10 };
    if (nameCache.size > 2000) nameCache.clear();
    nameCache.set(name, info);
    return info;
  }

  /** Label box around an orb: pill + thought bubble above, tool rows + badge below. */
  function measure(a: AgentState, r: number, finished: number): BoxSize {
    const ni = nameInfo(a.name);
    const rows = Math.max(1, Math.min(a.active_tools.length, MAX_TOOL_ROWS) + (a.active_tools.length > MAX_TOOL_ROWS ? 1 : 0));
    const below = r + 30 + rows * ROW_H + (finished ? ROW_H : 0);
    return { w: Math.max(ni.w + 24, 230, r * 2 + 70), top: r + 18 + ni.h + 16, bottom: below };
  }

  // ---------------------------------------------------------------- state
  function newVisual(id: AgentId, x: number, y: number, a: AgentState, since: number): Visual {
    return {
      id,
      phase: phaseOf(id),
      x,
      y,
      tx: x,
      ty: y,
      radius: CHILD_RADIUS,
      status: a.status,
      statusSince: since,
      name: nameInfo(a.name),
      nameKey: a.name,
      parent: null,
      exitStart: -1,
      recvAt: -1e9,
      recvColor: color.holoBase,
      sendAt: -1e9,
      inbox: 0,
      inboxAt: -1e9,
      edgeUntil: -1e9,
      edgeColor: color.edgeDispatch,
      sats: [],
      finished: 0,
      finishedLabel: '',
      finishedW: 0,
      badgeKey: `finished:${id}`,
      bx: 0,
      by: 0,
      bw: 0,
      bh: 0,
    };
  }

  function setState(next: SessionState | null) {
    if (!next) {
      session = null;
      sessionId = null;
      lay = null;
      visuals.clear();
      waiting.clear();
      clearEffects();
      requestFrame();
      return;
    }
    // Who is waiting on the human: the server's status, or any open permission request.
    // Done once per state change (not per frame), reusing the same Set.
    waiting.clear();
    for (const id in next.agents) if (next.agents[id]!.status === 'awaiting_permission') waiting.add(id);
    for (const p of next.pending) waiting.add(p.agent);
    const fresh = next.id !== sessionId;
    if (fresh) {
      visuals.clear();
      clearEffects();
      selected = null;
      userMovedCamera = false;
    }
    session = next;
    sessionId = next.id;
    relayout(fresh);
  }

  function relayout(fresh: boolean) {
    const s = session;
    if (!s) return;
    const now = performance.now();
    layoutDirty = false;
    lay = layout(s, { showUser: userSeen, measure });
    const places = lay.places;
    for (const [id, v] of visuals) {
      if (places.has(id)) continue;
      const a = s.agents[id];
      if (a && a.status === 'done' && !fresh && !reduced) {
        if (v.exitStart < 0) {
          v.exitStart = clock;
          v.status = 'done';
          v.statusSince = now;
          dropSatellites(v);
        }
      } else {
        dropSatellites(v);
        visuals.delete(id);
      }
    }
    for (const [id, p] of places) {
      const agent = s.agents[id]!;
      let v = visuals.get(id);
      if (!v) {
        // New agents emerge from their parent's current position.
        const parent = p.parent ? visuals.get(p.parent) : undefined;
        const sx = fresh || !parent ? p.x : parent.x;
        const sy = fresh || !parent ? p.y : parent.y;
        v = newVisual(id, sx, sy, agent, fresh ? -1e9 : now);
        visuals.set(id, v);
      }
      v.tx = p.x;
      v.ty = p.y;
      v.radius = p.radius;
      v.parent = p.parent;
      const fin = lay.finished.get(id) ?? 0;
      if (fin !== v.finished) {
        v.finished = fin;
        v.finishedLabel = `✓ ${fin} finished`;
        ctx.font = FONT_BADGE;
        v.finishedW = ctx.measureText(v.finishedLabel).width + 16;
      }
      v.exitStart = -1;
      if (v.status !== agent.status) {
        v.status = agent.status;
        v.statusSince = now;
      }
      if (v.nameKey !== agent.name) {
        v.nameKey = agent.name;
        v.name = nameInfo(agent.name);
      }
      syncSatellites(v, agent);
    }
    if (lay.user) {
      if (!user.shown) {
        user.shown = true;
        user.x = lay.user.x;
        user.y = lay.user.y;
        user.appearAt = clock;
      }
      user.tx = lay.user.x;
      user.ty = lay.user.y;
    } else user.shown = false;
    if (!userMovedCamera) fitCamera(fresh);
    requestFrame();
  }

  /** Satellites mirror `active_tools`: start missing ones, end vanished ones. */
  function syncSatellites(v: Visual, a: AgentState) {
    for (const t of a.active_tools) {
      if (!satellites.has(t.tool_use_id)) addSatellite(v, t.tool_use_id, t.name, t.tool_kind, t.summary, clock - 10);
    }
    for (const sat of v.sats) {
      if (sat.endAt >= 0) continue;
      let present = false;
      for (const t of a.active_tools) if (t.tool_use_id === sat.id) present = true;
      if (!present) sat.endAt = clock;
    }
  }

  function addSatellite(v: Visual, id: string, name: string, kind: ToolKind, summary: string, start: number) {
    const k = ICON_KINDS[kind] ?? 'other';
    const c = toolKindColor[k] ?? toolKindColor.other;
    ctx.font = FONT_TOOL;
    const label = truncate(summary ? `${name} · ${summary}` : name, 40);
    const sat: Satellite = {
      id,
      agent: v.id,
      kind: k,
      color: c,
      icon: toolIconSprite(k, c),
      dot: dotSprite(c),
      label,
      labelW: ctx.measureText(label).width,
      start,
      endAt: -1,
      result: 0,
      emitAcc: 0,
      child: toolChild.get(id) ?? null,
      x: v.x,
      y: v.y,
    };
    satellites.set(id, sat);
    v.sats.push(sat);
    return sat;
  }

  function dropSatellites(v: Visual) {
    for (const s of v.sats) satellites.delete(s.id);
    v.sats.length = 0;
  }

  function fitCamera(snap: boolean) {
    let minX = -ROOT_RADIUS;
    let maxX = ROOT_RADIUS;
    let minY = -ROOT_RADIUS;
    let maxY = ROOT_RADIUS;
    if (lay && session) {
      for (const [id, p] of lay.places) {
        const a = session.agents[id];
        if (!a) continue;
        const b = measure(a, p.radius, lay.finished.get(id) ?? 0);
        minX = Math.min(minX, p.x - b.w / 2);
        maxX = Math.max(maxX, p.x + b.w / 2);
        minY = Math.min(minY, p.y - b.top);
        maxY = Math.max(maxY, p.y + b.bottom);
      }
      if (lay.user) {
        minX = Math.min(minX, lay.user.x - 60);
        maxX = Math.max(maxX, lay.user.x + 60);
      }
    }
    const pad = 36;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    tZoom = clamp(Math.min(cssW / w, cssH / h, 1.15), MIN_ZOOM, MAX_ZOOM);
    tPanX = -((minX + maxX) / 2) * tZoom;
    tPanY = -((minY + maxY) / 2) * tZoom;
    if (snap || reduced) {
      zoom = tZoom;
      panX = tPanX;
      panY = tPanY;
    }
  }

  // ---------------------------------------------------------------- effects
  function clearEffects() {
    for (const c of comets) c.alive = false;
    for (const p of particles) p.alive = false;
    for (const r of ripples) r.alive = false;
    cometLive = particleLive = rippleLive = 0;
    for (const v of visuals.values()) {
      v.inbox = 0;
      v.recvAt = v.sendAt = v.inboxAt = v.edgeUntil = -1e9;
      for (const s of v.sats) s.start = clock - 10;
    }
    // Agents bowing out are gone at once (a seek should not replay their exit).
    for (const [id, v] of visuals) if (v.exitStart >= 0) visuals.delete(id);
    toolChild.clear();
    user.inbox = 0;
    user.recvAt = user.sendAt = user.inboxAt = -1e9;
    // Re-derived from the events pushed next; relaid out lazily so the node does not flicker.
    userSeen = false;
    layoutDirty = true;
    requestFrame();
  }

  /** Resolves a participant's current position; false if it is not in the scene. */
  function posOf(id: AgentId, out: { x: number; y: number }): boolean {
    if (id === USER_AGENT) {
      if (!user.shown) return false;
      out.x = user.x;
      out.y = user.y;
      return true;
    }
    const v = visuals.get(id);
    if (!v) return false;
    out.x = v.x;
    out.y = v.y;
    return true;
  }

  /** Maps a message endpoint onto something drawn (hidden agents → visible ancestor). */
  function resolveId(id: AgentId): AgentId | null {
    if (id === USER_AGENT) return user.shown ? id : null;
    if (visuals.has(id)) return id;
    const s = session;
    if (!s || !lay?.root) return null;
    let cur = s.agents[id]?.parent ?? null;
    for (let g = 0; cur && g < 64; g++) {
      if (visuals.has(cur)) return cur;
      cur = s.agents[cur]?.parent ?? null;
    }
    return s.agents[id] ? lay.root : null;
  }

  function spawnParticle(x0: number, y0: number, x1: number, y1: number, curve: number, start: number, dur: number, size: number, img: HTMLCanvasElement) {
    const p = particles[particleHead]!;
    particleHead = (particleHead + 1) % MAX_PARTICLES;
    if (!p.alive) particleLive++;
    p.alive = true;
    p.x0 = x0;
    p.y0 = y0;
    p.x1 = x1;
    p.y1 = y1;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    p.cx = mx - (y1 - y0) * curve;
    p.cy = my + (x1 - x0) * curve;
    p.start = start;
    p.dur = dur;
    p.size = size;
    p.img = img;
  }

  function burst(x: number, y: number, n: number, dist: number, start: number, img: HTMLCanvasElement) {
    if (reduced) return;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + Math.random() * 0.6;
      const d = dist * (0.6 + Math.random() * 0.6);
      spawnParticle(x, y, x + Math.cos(ang) * d, y + Math.sin(ang) * d, 0.15, start, 0.45 + Math.random() * 0.35, 5 + Math.random() * 3, img);
    }
  }

  function spawnRipple(agent: AgentId, c: string, start: number, r0: number, r1: number, dur = RIPPLE_DUR) {
    const r = ripples[rippleHead]!;
    rippleHead = (rippleHead + 1) % MAX_RIPPLES;
    if (!r.alive) rippleLive++;
    r.alive = true;
    r.agent = agent;
    r.color = c;
    r.start = start;
    r.dur = dur;
    r.r0 = r0;
    r.r1 = r1;
  }

  function radiusOf(id: AgentId): number {
    if (id === USER_AGENT) return USER_RADIUS;
    return visuals.get(id)?.radius ?? CHILD_RADIUS;
  }

  function spawnComet(from: AgentId, to: AgentId, c: string, text: string, start: number) {
    const dst = resolveId(to);
    if (!dst) return;
    let src = resolveId(from);
    if (src === dst) src = null;
    if (!src && from === to) return;
    const k = comets[cometHead]!;
    cometHead = (cometHead + 1) % MAX_COMETS;
    if (!k.alive) cometLive++;
    k.alive = true;
    k.to = dst;
    k.from = src ?? '';
    k.fixedFrom = !src;
    if (!src && posOf(dst, pA)) {
      // Unknown sender (background task, hook): arrive from above-left, out of the dark.
      k.fx = pA.x - 140;
      k.fy = pA.y - 230;
    }
    k.start = start;
    k.dur = reduced ? 0 : COMET_DUR;
    k.color = c;
    k.img = dotSprite(c);
    ctx.font = FONT_BUBBLE;
    k.label = truncate(text, 40);
    k.labelW = ctx.measureText(k.label).width;
    k.arrived = false;
    // Parent ↔ child messages follow the drawn edge (same bulge in both directions).
    const vd = visuals.get(dst);
    const vs = src ? visuals.get(src) : undefined;
    const edge = (vd && vd.parent === src) ? 1 : (vs && vs.parent === dst) ? -1 : 0;
    k.bend = edge !== 0 ? edge : 1;
    const child = edge === 1 ? vd : edge === -1 ? vs : undefined;
    if (child) {
      child.edgeUntil = start + COMET_DUR + 0.5;
      child.edgeColor = c;
    }
    const sv = src === USER_AGENT ? null : src ? visuals.get(src) : undefined;
    if (src === USER_AGENT) user.sendAt = start;
    else if (sv) sv.sendAt = start;
  }

  function arrive(k: Comet, at: number) {
    k.arrived = true;
    const c = k.color;
    spawnRipple(k.to, c, at, radiusOf(k.to) + 2, radiusOf(k.to) + 34);
    if (k.to === USER_AGENT) {
      user.recvAt = at;
      user.recvColor = c;
      user.inbox++;
      user.inboxAt = at;
    } else {
      const v = visuals.get(k.to);
      if (v) {
        v.recvAt = at;
        v.recvColor = c;
        v.inbox++;
        v.inboxAt = at;
      }
    }
    if (posOf(k.to, pA)) burst(pA.x, pA.y, 10, radiusOf(k.to) + 26, at, k.img);
  }

  function pushEvents(events: AgentEvent[], opts?: PushOptions) {
    if (!events.length) return;
    const instant = opts?.instant ?? false;
    const newest = events[events.length - 1]!.at;
    let needLayout = false;
    for (const e of events) {
      // Effects only for what is (or was just) happening.
      const recent = !instant || newest - e.at <= SEEK_WINDOW_MS;
      const back = instant ? (newest - e.at) / 1000 : Math.min(0.3, Math.max(0, (newest - e.at) / 1000));
      const start = clock - back;
      switch (e.type) {
        case 'message_sent': {
          if (e.from === USER_AGENT || e.to === USER_AGENT) {
            if (!userSeen) {
              userSeen = true;
              needLayout = true;
            }
          }
          if (needLayout) {
            relayout(false);
            needLayout = false;
          }
          if (recent) spawnComet(e.from, e.to, channelColor[e.channel] ?? color.holoBase, e.text, start);
          else {
            // Seeking: no flight, just count it as received.
            const dst = resolveId(e.to);
            if (dst === USER_AGENT) user.inbox++;
            else if (dst) {
              const v = visuals.get(dst);
              if (v) v.inbox++;
            }
          }
          break;
        }
        case 'user_prompt':
          if (e.agent === lay?.root && !userSeen) {
            userSeen = true;
            needLayout = true;
          }
          break;
        case 'subagent_spawned': {
          if (e.tool_use_id) {
            toolChild.set(e.tool_use_id, e.child);
            const sat = satellites.get(e.tool_use_id);
            if (sat) sat.child = e.child;
          }
          if (recent && visuals.has(e.child)) spawnRipple(e.child, color.edgeDispatch, start, CHILD_RADIUS, CHILD_RADIUS + 40, 1);
          break;
        }
        case 'tool_started': {
          if (!recent) break;
          const v = visuals.get(e.agent);
          if (!v) break;
          const sat = satellites.get(e.tool_use_id);
          if (sat) sat.start = start;
          else addSatellite(v, e.tool_use_id, e.name, e.tool_kind, e.summary, start);
          break;
        }
        case 'tool_finished': {
          const sat = satellites.get(e.tool_use_id);
          if (!sat) break;
          if (sat.endAt < 0) sat.endAt = start;
          sat.result = e.is_error ? 2 : 1;
          if (!recent) break;
          const v = visuals.get(sat.agent);
          if (!v) break;
          // Output size scales the burst of data flowing back into the agent.
          const n = Math.min(26, 5 + Math.round(Math.log2(e.output.length + 1) * 1.6));
          const img = e.is_error ? dotSprite(statusColor.error) : sat.dot;
          if (!reduced && sat.kind !== 'write') {
            for (let i = 0; i < n; i++) {
              spawnParticle(sat.x + (Math.random() - 0.5) * 10, sat.y + (Math.random() - 0.5) * 10, v.tx, v.ty, (Math.random() - 0.5) * 0.6, start + i * 0.02, 0.5 + Math.random() * 0.3, 4 + Math.random() * 3, img);
            }
          }
          burst(sat.x, sat.y, 8, 22, start, e.is_error ? dotSprite(statusColor.error) : dotSprite(statusColor.done));
          break;
        }
        case 'permission_requested':
          if (recent && visuals.has(e.agent)) spawnRipple(e.agent, statusColor.awaiting_permission, start, radiusOf(e.agent), radiusOf(e.agent) + 50, 1.2);
          break;
        case 'error':
          if (recent && visuals.has(e.agent)) spawnRipple(e.agent, statusColor.error, start, radiusOf(e.agent), radiusOf(e.agent) + 40);
          break;
        case 'compacted':
          if (recent && visuals.has(e.agent)) spawnRipple(e.agent, statusColor.compacting, start, radiusOf(e.agent) + 40, radiusOf(e.agent), 0.9);
          break;
        default:
          break;
      }
    }
    if (needLayout || layoutDirty) relayout(false);
    requestFrame();
  }

  // ---------------------------------------------------------------- geometry
  /** Control point of the curve between a and b (bulging to the left of a→b by `k`). */
  function control(ax: number, ay: number, bx: number, by: number, k: number, out: { x: number; y: number }) {
    out.x = (ax + bx) / 2 - (by - ay) * k;
    out.y = (ay + by) / 2 + (bx - ax) * k;
  }

  function bez(a: number, c: number, b: number, t: number): number {
    const u = 1 - t;
    return u * u * a + 2 * u * t * c + t * t * b;
  }

  /**
   * Satellite slot around its agent. Slots alternate right/left on side arcs (never above,
   * where the pill is, or below, where the tool rows are) and bob gently.
   */
  function satPos(v: Visual, i: number, t: number, out: { x: number; y: number }) {
    const or = v.radius + 30 + Math.floor(i / 6) * 30;
    const k = i % 6;
    const side = k % 2 === 0 ? 0 : Math.PI;
    const row = (k >> 1) - 1; // -1, 0, 1
    const ang = side + (side === 0 ? row : -row) * 0.62;
    const bob = reduced ? 0 : Math.sin(t * 1.6 + i * 1.3) * 2.5;
    out.x = v.x + Math.cos(ang) * or;
    out.y = v.y + Math.sin(ang) * or + bob;
  }

  // ---------------------------------------------------------------- drawing
  function draw(now: number, dt: number): boolean {
    let animating = false;

    // Camera easing toward the fitted target.
    if (!userMovedCamera && (Math.abs(tZoom - zoom) > 1e-3 || Math.abs(tPanX - panX) > 0.3 || Math.abs(tPanY - panY) > 0.3)) {
      zoom += (tZoom - zoom) * 0.12;
      panX += (tPanX - panX) * 0.12;
      panY += (tPanY - panY) * 0.12;
      animating = true;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color.bgVoid;
    ctx.fillRect(0, 0, cssW, cssH);

    const ox = cssW / 2 + panX;
    const oy = cssH / 2 + panY;

    // Dot grid, transformed with the camera via the pattern matrix.
    if (gridPattern) {
      gridMatrix.a = zoom;
      gridMatrix.d = zoom;
      gridMatrix.e = ox;
      gridMatrix.f = oy;
      gridPattern.setTransform(gridMatrix);
      ctx.fillStyle = gridPattern;
      ctx.fillRect(0, 0, cssW, cssH);
    }

    if (layoutDirty) relayout(false);
    const s = session;
    if (!s) return animating;

    // Ease positions toward their targets.
    for (const v of visuals.values()) {
      const dx = v.tx - v.x;
      const dy = v.ty - v.y;
      if (reduced || (Math.abs(dx) < MOVE_EPS && Math.abs(dy) < MOVE_EPS)) {
        v.x = v.tx;
        v.y = v.ty;
      } else {
        const f = 1 - Math.pow(0.86, dt * 60);
        v.x += dx * f;
        v.y += dy * f;
        animating = true;
      }
    }
    if (user.shown) {
      user.x += (user.tx - user.x) * 0.14;
      user.y += (user.ty - user.y) * 0.14;
      if (Math.abs(user.tx - user.x) > MOVE_EPS) animating = true;
    }

    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * ox, dpr * oy);
    const t = now / 1000;

    if (drawEdges(s, t)) animating = true;
    if (drawUser()) animating = true;

    for (const v of visuals.values()) {
      const agent = s.agents[v.id];
      if (!agent) continue;
      if (drawAgent(agent, v, now, t)) animating = true;
    }

    if (drawSatellites(dt, t)) animating = true;
    if (drawRipples()) animating = true;
    if (drawComets()) animating = true;
    if (drawParticles()) animating = true;
    drawCometLabels();
    return animating;
  }

  function drawEdges(s: SessionState, t: number): boolean {
    let animating = false;
    const w = Math.max(1.2, 1.4 / zoom);
    for (const v of visuals.values()) {
      if (!v.parent) continue;
      const p = visuals.get(v.parent);
      if (!p) continue;
      const a = s.agents[v.id];
      const exitA = v.exitStart >= 0 ? 1 - clamp((clock - v.exitStart - EXIT_DELAY) / EXIT_DUR, 0, 1) : 1;
      const active = a ? isBusy(a.status) : false;
      control(p.x, p.y, v.x, v.y, 0.14, pC);
      ctx.lineWidth = w;
      ctx.strokeStyle = rgba(color.edgeDispatch, (active ? 0.42 : 0.24) * exitA);
      ctx.setLineDash([5, 7]);
      ctx.lineDashOffset = active && !reduced ? -t * 24 : 0;
      if (active && !reduced) animating = true;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(pC.x, pC.y, v.x, v.y);
      ctx.stroke();
      // Lit while a message travels along it.
      const lit = v.edgeUntil - clock;
      if (lit > 0) {
        ctx.setLineDash([]);
        ctx.globalAlpha = Math.min(1, lit / 0.5) * 0.75 * exitA;
        ctx.strokeStyle = v.edgeColor;
        ctx.lineWidth = w * 2.2;
        ctx.stroke();
        ctx.globalAlpha = 1;
        animating = true;
      }
    }
    ctx.setLineDash([]);
    // The human's link to the root.
    if (user.shown && lay?.root) {
      const r = visuals.get(lay.root);
      if (r) {
        control(user.x, user.y, r.x, r.y, 0.14, pC);
        ctx.lineWidth = w;
        ctx.strokeStyle = rgba(color.mascotBody, 0.3);
        ctx.setLineDash([3, 7]);
        ctx.beginPath();
        ctx.moveTo(user.x, user.y);
        ctx.quadraticCurveTo(pC.x, pC.y, r.x, r.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    return animating;
  }

  function drawUser(): boolean {
    if (!user.shown) return false;
    let animating = false;
    const x = user.x;
    const y = user.y;
    const appear = reduced ? 1 : clamp((clock - user.appearAt) / 0.5, 0, 1);
    if (appear < 1) animating = true;
    const recv = clock - user.recvAt;
    const send = clock - user.sendAt;
    let scale = appear;
    if (!reduced && send >= 0 && send < SEND_DUR) {
      scale *= 1 - 0.12 * Math.sin((send / SEND_DUR) * Math.PI);
      animating = true;
    }
    ctx.globalAlpha = 0.5 * appear;
    const gs = USER_RADIUS * 3.4;
    ctx.drawImage(glowSprite(color.mascotBody), x - gs, y - gs, gs * 2, gs * 2);
    if (recv >= 0 && recv < RECV_DUR) {
      ctx.globalAlpha = 1 - recv / RECV_DUR;
      ctx.drawImage(glowSprite(user.recvColor), x - gs, y - gs, gs * 2, gs * 2);
      animating = true;
    }
    ctx.globalAlpha = appear;
    // Ring and pixel bot (crisp).
    ctx.strokeStyle = rgba(color.mascotBody, 0.8);
    ctx.lineWidth = 2;
    ctx.fillStyle = 'rgba(8,12,24,0.9)';
    ctx.beginPath();
    ctx.arc(x, y, USER_RADIUS * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const px = 2.6 * scale;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bot, x - 6 * px, y - 4 * px, 12 * px, 8 * px);
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = color.holoBright;
    ctx.font = FONT_PILL;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('you', x, y + USER_RADIUS + 14);
    if (hovered === USER_AGENT || selected === USER_AGENT) drawSelection(x, y, USER_RADIUS + 9);
    if (user.inbox > 0) animating = drawInbox(x + USER_RADIUS * 0.75, y - USER_RADIUS * 0.75, user.inbox, user.inboxAt, user.recvColor) || animating;
    ctx.globalAlpha = 1;
    return animating;
  }

  /** Small count badge that pops when a message lands. */
  function drawInbox(x: number, y: number, n: number, at: number, c: string): boolean {
    const age = clock - at;
    const pop = !reduced && age >= 0 && age < 0.45 ? 1 + 0.5 * Math.sin((age / 0.45) * Math.PI) : 1;
    const label = n > 99 ? '99+' : COUNT_LABELS[n] ?? String(n);
    const r = (label.length > 1 ? 9 : 7.5) * pop;
    ctx.fillStyle = 'rgba(8,12,24,0.95)';
    ctx.strokeStyle = age < 0.8 ? c : rgba(color.holoBase, 0.6);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color.holoBright;
    ctx.font = label.length > 2 ? FONT_INBOX_SMALL : FONT_INBOX;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 0.5);
    return pop !== 1;
  }

  /** Draws one agent; returns whether it needs more animation frames. */
  function drawAgent(a: AgentState, v: Visual, now: number, t: number): boolean {
    // Waiting on the human outranks whatever the transcript last said (thinking/tool).
    const wait = waiting.has(a.id) && v.exitStart < 0;
    const st: AgentStatus = wait ? 'awaiting_permission' : a.status;
    const c = statusColor[st] ?? statusColor.idle;
    const age = now - v.statusSince;
    let animating = false;
    let x = v.x;
    const y = v.y;
    let r = v.radius;
    let alpha = 1;

    // Finished subagent bowing out: hold briefly, then shrink and fade with a ring.
    if (v.exitStart >= 0) {
      const p = clamp((clock - v.exitStart - EXIT_DELAY) / EXIT_DUR, 0, 1);
      if (p >= 1) {
        visuals.delete(v.id);
        return true;
      }
      animating = true;
      if (p > 0) {
        ctx.globalAlpha = (1 - p) * 0.8;
        ctx.strokeStyle = statusColor.done;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r + p * r * 1.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      alpha = 1 - p;
      r *= 1 - p * 0.8;
    }

    // Error: short shake, then a red rim.
    if (a.status === 'error' && !reduced && age < SHAKE_MS) {
      x += Math.sin(age / 22) * 4 * (1 - age / SHAKE_MS);
      animating = true;
    }

    // Receive bump and send recoil.
    const recv = clock - v.recvAt;
    const send = clock - v.sendAt;
    let scale = 1;
    if (recv >= 0 && recv < RECV_DUR) {
      if (!reduced) scale += 0.1 * Math.sin((recv / RECV_DUR) * Math.PI);
      animating = true;
    }
    if (!reduced && send >= 0 && send < SEND_DUR) {
      scale -= 0.08 * Math.sin((send / SEND_DUR) * Math.PI);
      animating = true;
    }
    const rr = r * scale;

    // Glow (pre-rendered sprite, brighter while waiting on the human).
    const busy = isBusy(st);
    const breathe = busy && !reduced ? 0.85 + 0.15 * Math.sin(t * 2.4) : 1;
    ctx.globalAlpha = alpha * (st === 'idle' || st === 'done' ? 0.45 : wait ? 1 : 0.8) * breathe;
    const gs = rr * (wait ? 5 : 4);
    ctx.drawImage(glowSprite(c), x - gs, y - gs, gs * 2, gs * 2);
    if (recv >= 0 && recv < RECV_DUR) {
      ctx.globalAlpha = alpha * (1 - recv / RECV_DUR);
      ctx.drawImage(glowSprite(v.recvColor), x - gs, y - gs, gs * 2, gs * 2);
    }
    ctx.globalAlpha = alpha;

    // Status motion. Waiting on the human replaces the thinking/tool motion with an amber
    // double ring and a dashed lead toward the "you" node.
    if (wait) {
      if (user.shown) drawWaitLead(x, y, rr, t, alpha);
      drawWaitRings(x, y, rr, t, alpha);
      if (!reduced) animating = true;
    } else if (!reduced && v.exitStart < 0) {
      if (a.status === 'thinking') {
        drawThinkHalo(x, y, rr, t + v.phase, alpha);
        animating = true;
      } else if (a.status === 'idle') {
        drawIdleHalo(x, y, rr, t + v.phase, alpha, c);
        lazy = true;
      } else if (a.status === 'tool') {
        const ph = (t % 1.2) / 1.2;
        ctx.strokeStyle = c;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.6 * (1 - ph);
        ctx.beginPath();
        ctx.arc(x, y, r + 4 + ph * 18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        animating = true;
      } else if (a.status === 'compacting') {
        ctx.fillStyle = c;
        for (let i = 0; i < 6; i++) {
          const ph = ((t * 0.6 + i / 6) % 1 + 1) % 1;
          const ang = i * 1.05 + ph * 3;
          const dist = r + 30 * (1 - ph);
          ctx.globalAlpha = ph;
          ctx.beginPath();
          ctx.arc(x + Math.cos(ang) * dist, y + Math.sin(ang) * dist, 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        animating = true;
      }
    } else if (a.status === 'thinking') {
      drawThinkHalo(x, y, rr, 0, alpha);
    } else if (a.status === 'tool') {
      ctx.strokeStyle = c;
      ctx.globalAlpha = 0.6 * alpha;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = alpha;
    }

    // Bot body: a dark disc as a stage, then the animated pixel bot on top. The pose shows
    // what the agent is doing (reading, writing, searching, typing, asking...).
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(8,12,24,0.88)';
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = rgba(c, st === 'idle' || st === 'done' ? 0.45 : 0.85);
    ctx.lineWidth = a.status === 'error' ? 3 : 2;
    ctx.stroke();
    const newest = a.active_tools.length ? a.active_tools[a.active_tools.length - 1]!.tool_kind : null;
    const pose = poseFor(st, newest);
    // Each agent gets a phase offset so a crowd doesn't animate in lockstep.
    const frame = reduced ? 0 : frameOf(pose, t + v.phase);
    const body = a.parent === null ? color.mascotBody : SUB_BODY;
    const img = botFrame(pose, frame, body, c);
    const bw = rr * 1.55;
    const bh = (bw * BOT_H) / BOT_W;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, x - bw / 2, y - bh / 2 - rr * 0.04, bw, bh);
    ctx.imageSmoothingEnabled = true;
    if (!reduced) {
      if (pose === 'idle') lazy = true;
      else animating = true;
    }

    // Context ring: track + fill arc for context_tokens / context_window.
    const ringR = rr + 5;
    ctx.lineWidth = 3;
    ctx.strokeStyle = rgba(color.holoBase, 0.12);
    ctx.beginPath();
    ctx.arc(x, y, ringR, 0, Math.PI * 2);
    ctx.stroke();
    const frac = a.context_window > 0 ? clamp(a.context_tokens / a.context_window, 0, 1) : 0;
    if (frac > 0) {
      ctx.strokeStyle = frac > 0.85 ? statusColor.error : frac > 0.6 ? statusColor.tool : color.holoBright;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(x, y, ringR, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    if (v.inbox > 0 && drawInbox(x + rr * 0.78, y - rr * 0.78, v.inbox, v.inboxAt, v.recvColor)) animating = true;

    if (hovered === a.id || selected === a.id) drawSelection(x, y, r + 11);

    const pillBottom = y - v.radius - 16;
    drawPill(x, pillBottom, v, c);
    if (wait) {
      drawWaitBadge(x, pillBottom - v.name.h - WAIT_BADGE_R - 6, t, alpha);
    } else if (a.status === 'thinking' && v.exitStart < 0) {
      drawThought(x + v.name.w / 2 - 4, pillBottom - v.name.h, t);
      animating = animating || !reduced;
    }
    drawToolRows(v, x, y + v.radius + 22);
    ctx.globalAlpha = 1;
    return animating;
  }

  /**
   * Waiting for permission: two amber rings that swell and brighten together on a slow
   * ~1.6 s pulse, the inner one leading the outer. With reduced motion they hold still.
   */
  function drawWaitRings(x: number, y: number, rr: number, t: number, alpha: number) {
    const amber = statusColor.awaiting_permission;
    ctx.strokeStyle = amber;
    for (let i = 0; i < 2; i++) {
      const p = reduced ? 0.6 : 0.5 + 0.5 * Math.sin(((t - i * 0.2) * Math.PI * 2) / WAIT_PERIOD);
      ctx.globalAlpha = alpha * (0.35 + 0.5 * p) * (i === 0 ? 1 : 0.7);
      ctx.lineWidth = i === 0 ? 2 + p : 1.2 + p * 0.6;
      ctx.beginPath();
      ctx.arc(x, y, rr + 10 + i * 7 + p * 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = alpha;
  }

  /**
   * Amber "!" badge floating above the name pill, bobbing gently: "this needs you".
   * `cy` is the badge centre when at rest.
   */
  function drawWaitBadge(cx: number, cy: number, t: number, alpha: number) {
    const amber = statusColor.awaiting_permission;
    const bob = reduced ? 0 : Math.sin((t * Math.PI * 2) / WAIT_PERIOD) * 2.5;
    const y = cy + bob;
    // Soft halo, then a dark disc with an amber rim and a bold amber "!".
    ctx.globalAlpha = alpha * 0.55;
    const gs = WAIT_BADGE_R * 3;
    ctx.drawImage(glowSprite(amber), cx - gs, y - gs, gs * 2, gs * 2);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(8,12,24,0.92)';
    ctx.strokeStyle = amber;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, y, WAIT_BADGE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Little tail pointing down at the pill, like a speech bubble.
    ctx.fillStyle = amber;
    ctx.beginPath();
    ctx.moveTo(cx - 3, y + WAIT_BADGE_R - 0.5);
    ctx.lineTo(cx + 3, y + WAIT_BADGE_R - 0.5);
    ctx.lineTo(cx, y + WAIT_BADGE_R + 4);
    ctx.closePath();
    ctx.fill();
    ctx.font = FONT_WAIT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', cx, y + 0.5);
  }

  /**
   * A faint amber dashed curve from the waiting agent to the "you" node, with dashes
   * marching toward you. Static with reduced motion.
   */
  function drawWaitLead(x: number, y: number, rr: number, t: number, alpha: number) {
    const dx = user.x - x;
    const dy = user.y - y;
    const d = Math.hypot(dx, dy);
    if (d < rr + USER_RADIUS + 20) return;
    const ux = dx / d;
    const uy = dy / d;
    // Start/end just outside each orb; bow the curve sideways a little.
    const sx = x + ux * (rr + 18);
    const sy = y + uy * (rr + 18);
    const ex = user.x - ux * (USER_RADIUS + 10);
    const ey = user.y - uy * (USER_RADIUS + 10);
    const bend = Math.min(60, d * 0.15);
    const cx = (sx + ex) / 2 - uy * bend;
    const cy = (sy + ey) / 2 + ux * bend;
    ctx.strokeStyle = statusColor.awaiting_permission;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = alpha * 0.35;
    ctx.setLineDash(WAIT_DASH);
    ctx.lineDashOffset = reduced ? 0 : -t * 18;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(cx, cy, ex, ey);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    ctx.lineDashOffset = 0;
    ctx.globalAlpha = alpha;
  }

  /**
   * Thinking: a "neural halo". Neurons sit on a ring around the bot; they fire one after
   * another in a scrambled order, and each firing sends a signal along a curved synapse to
   * the next neuron. Two counter-rotating arcs with fading tails sweep the ring like a
   * scanner. Everything is plain arcs and lines; no allocations.
   */
  function drawThinkHalo(x: number, y: number, rr: number, t: number, alpha: number) {
    const ring = rr + 12;
    const drift = t * 0.25;
    const step = 0.32; // seconds between firings
    const tick = Math.floor(t / step);
    const into = t / step - tick; // 0..1 through the current firing
    const nodeAt = (k: number) => (((k * 3) % THINK_NODES) + THINK_NODES) % THINK_NODES;
    const angOf = (i: number) => drift + (i * Math.PI * 2) / THINK_NODES;

    // Scanner arcs: a bright head with a tail of fading segments.
    ctx.lineCap = 'round';
    for (let arc = 0; arc < 2; arc++) {
      const rad = arc === 0 ? ring + 4 : ring - 4;
      const head = arc === 0 ? t * 1.7 : -t * 1.15 + 2;
      const dir = arc === 0 ? -1 : 1;
      ctx.strokeStyle = arc === 0 ? color.holoBright : color.holoBase;
      ctx.lineWidth = arc === 0 ? 1.6 : 1.2;
      for (let k = 0; k < 5; k++) {
        ctx.globalAlpha = alpha * (0.75 - k * 0.14);
        const a0 = head + dir * k * 0.2;
        ctx.beginPath();
        ctx.arc(x, y, rad, Math.min(a0, a0 + dir * 0.22), Math.max(a0, a0 + dir * 0.22));
        ctx.stroke();
      }
    }

    // Synapse: from the neuron firing now to the next one, bowed outward, with a
    // travelling signal dot.
    if (!reduced) {
      const ia = angOf(nodeAt(tick));
      const ib = angOf(nodeAt(tick + 1));
      const ax = x + Math.cos(ia) * ring;
      const ay = y + Math.sin(ia) * ring;
      const bx = x + Math.cos(ib) * ring;
      const by = y + Math.sin(ib) * ring;
      let mid = (ia + ib) / 2;
      if (Math.abs(ib - ia) > Math.PI) mid += Math.PI;
      const cx = x + Math.cos(mid) * (ring + 22);
      const cy = y + Math.sin(mid) * (ring + 22);
      ctx.strokeStyle = color.holoBase;
      ctx.lineWidth = 1;
      ctx.globalAlpha = alpha * 0.7 * Math.sin(into * Math.PI);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cx, cy, bx, by);
      ctx.stroke();
      const u = easeInOut(into);
      const w = 1 - u;
      ctx.fillStyle = color.holoHot;
      ctx.globalAlpha = alpha * 0.95;
      ctx.beginPath();
      ctx.arc(w * w * ax + 2 * w * u * cx + u * u * bx, w * w * ay + 2 * w * u * cy + u * u * by, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Neurons: dim at rest, flash when they fire, then decay over two steps.
    for (let i = 0; i < THINK_NODES; i++) {
      let heat = 0;
      if (!reduced) {
        for (let back = 0; back < 3; back++) {
          if (nodeAt(tick - back) === i) heat = Math.max(heat, 1 - (back + into) / 3);
        }
      }
      const ang = angOf(i);
      const nx = x + Math.cos(ang) * ring;
      const ny = y + Math.sin(ang) * ring;
      if (heat > 0.05) {
        ctx.globalAlpha = alpha * heat * 0.35;
        ctx.fillStyle = color.holoBase;
        ctx.beginPath();
        ctx.arc(nx, ny, 3 + heat * 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = alpha * (0.35 + heat * 0.65);
      ctx.fillStyle = heat > 0.5 ? color.holoHot : color.holoBright;
      ctx.beginPath();
      ctx.arc(nx, ny, 1.4 + heat * 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.lineCap = 'butt';
    ctx.globalAlpha = alpha;
  }

  /**
   * Idle: standby. A dim ring breathes in and out every few seconds, and a single dim
   * "standby" dot circles slowly. It's drawn at a low frame rate (see `lazy`).
   */
  function drawIdleHalo(x: number, y: number, rr: number, t: number, alpha: number, c: string) {
    const br = 0.5 + 0.5 * Math.sin(t * ((Math.PI * 2) / IDLE_BREATH));
    ctx.strokeStyle = c;
    ctx.lineWidth = 1;
    ctx.globalAlpha = alpha * (0.12 + br * 0.18);
    ctx.beginPath();
    ctx.arc(x, y, rr + 10 + br * 3, 0, Math.PI * 2);
    ctx.stroke();
    const ang = t * 0.5;
    ctx.fillStyle = c;
    ctx.globalAlpha = alpha * 0.55;
    ctx.beginPath();
    ctx.arc(x + Math.cos(ang) * (rr + 10 + br * 3), y + Math.sin(ang) * (rr + 10 + br * 3), 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
  }

  function drawSelection(x: number, y: number, rr: number) {
    ctx.strokeStyle = rgba(color.holoBright, 0.7);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Title pill: full name (wrapped to two lines) with a state dot; bottom edge at `bottom`. */
  function drawPill(cx: number, bottom: number, v: Visual, dot: string) {
    const lineH = PILL_FONT + 3;
    const { w, h, lines } = v.name;
    const x = cx - w / 2;
    const y = bottom - h;
    ctx.fillStyle = 'rgba(8,12,24,0.88)';
    ctx.strokeStyle = 'rgba(100,200,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(h / 2, 11));
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = dot;
    ctx.beginPath();
    ctx.arc(x + 11, y + h / 2, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color.holoBright;
    ctx.font = FONT_PILL;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i]!, x + 21, y + 5 + lineH * i + lineH / 2);
    }
  }

  /** Thought bubble with three bouncing dots, rising from the pill's top-right corner. */
  function drawThought(x: number, y: number, t: number) {
    ctx.fillStyle = 'rgba(8,12,24,0.92)';
    ctx.strokeStyle = rgba(color.holoBase, 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x + 2, y - 3, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(x + 4, y - 20, 30, 13, 6.5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color.holoBright;
    for (let i = 0; i < 3; i++) {
      const bob = reduced ? 0 : Math.max(0, Math.sin(t * 6 - i * 0.7)) * 2;
      ctx.beginPath();
      ctx.arc(x + 12 + i * 7, y - 13.5 - bob, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Tool rows stacked under the orb, plus the "✓ N finished" badge. */
  function drawToolRows(v: Visual, cx: number, top: number) {
    const sats = v.sats;
    let shown = 0;
    let running = 0;
    for (const s of sats) if (s.endAt < 0) running++;
    ctx.font = FONT_TOOL;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const base = ctx.globalAlpha;
    for (const s of sats) {
      if (shown >= MAX_TOOL_ROWS) break;
      const fade = s.endAt >= 0 ? 1 - clamp((clock - s.endAt) / SAT_OUT, 0, 1) : 1;
      if (fade <= 0) continue;
      const y = top + shown * ROW_H;
      const w = s.labelW + 28;
      const x = cx - w / 2;
      ctx.globalAlpha = base * fade;
      ctx.fillStyle = 'rgba(8,12,24,0.85)';
      ctx.strokeStyle = s.result === 2 ? statusColor.error : s.result === 1 ? statusColor.done : rgba(s.color, 0.35);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x, y - 8, w, 16, 4);
      ctx.fill();
      ctx.stroke();
      ctx.drawImage(s.icon, x + 3, y - 6, 12, 12);
      ctx.fillStyle = s.color;
      ctx.fillText(s.label, x + 20, y);
      shown++;
    }
    ctx.globalAlpha = base;
    let y = top + shown * ROW_H;
    if (running > shown) {
      ctx.fillStyle = color.textMuted;
      ctx.textAlign = 'center';
      ctx.fillText(`+${running - shown} more`, cx, y);
      y += ROW_H;
    }
    v.bw = 0;
    if (v.finished > 0 && v.exitStart < 0) {
      const label = v.finishedLabel;
      ctx.font = FONT_BADGE;
      const w = v.finishedW;
      v.bx = cx - w / 2;
      v.by = y - 8;
      v.bw = w;
      v.bh = 16;
      ctx.fillStyle = rgba(statusColor.done, 0.08);
      ctx.strokeStyle = rgba(statusColor.done, hovered === v.badgeKey ? 0.8 : 0.35);
      ctx.beginPath();
      ctx.roundRect(v.bx, v.by, w, 16, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = statusColor.done;
      ctx.textAlign = 'center';
      ctx.fillText(label, cx, y + 0.5);
    }
  }

  function drawSatellites(dt: number, t: number): boolean {
    if (!satellites.size) return false;
    let animating = false;
    const edt = dt * timeScale;
    for (const v of visuals.values()) {
      const sats = v.sats;
      if (!sats.length) continue;
      const exitA = v.exitStart >= 0 ? 0 : 1;
      for (let i = sats.length - 1; i >= 0; i--) {
        const s = sats[i]!;
        if (s.endAt >= 0 && clock - s.endAt > SAT_OUT) {
          satellites.delete(s.id);
          sats.splice(i, 1);
        }
      }
      const n = sats.length;
      for (let i = 0; i < n; i++) {
        const s = sats[i]!;
        satPos(v, i, t, pA);
        s.x = pA.x;
        s.y = pA.y;
        const age = clock - s.start;
        const appear = reduced ? 1 : clamp(age / SAT_IN, 0, 1);
        const ending = s.endAt >= 0;
        const out = ending ? clamp((clock - s.endAt) / SAT_OUT, 0, 1) : 0;
        const alpha = appear * (1 - out) * exitA;
        if (alpha <= 0) {
          animating = true;
          continue;
        }
        animating = true;
        // Tether from the orb.
        ctx.globalAlpha = alpha * 0.35;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const dd = Math.hypot(s.x - v.x, s.y - v.y) || 1;
        ctx.moveTo(v.x + ((s.x - v.x) * v.radius) / dd, v.y + ((s.y - v.y) * v.radius) / dd);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();

        // Dispatch beam to the child this Agent call spawned.
        if (s.kind === 'agent' && s.child && !ending) {
          const child = visuals.get(s.child);
          if (child) {
            control(v.x, v.y, child.x, child.y, 0.14, pC);
            ctx.globalAlpha = alpha * 0.55;
            ctx.strokeStyle = color.edgeDispatch;
            ctx.lineWidth = 2.5;
            ctx.setLineDash([2, 14]);
            ctx.lineDashOffset = reduced ? 0 : -clock * 60;
            ctx.beginPath();
            ctx.moveTo(v.x, v.y);
            ctx.quadraticCurveTo(pC.x, pC.y, child.x, child.y);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }

        // Icon (pops in, flashes green/red when done).
        const pop = appear < 1 ? 0.6 + 0.4 * appear + Math.sin(appear * Math.PI) * 0.25 : 1;
        const size = (v.radius > CHILD_RADIUS ? 24 : 20) * pop * (1 + out * 0.6);
        ctx.globalAlpha = alpha * 0.55;
        const fc = s.result === 2 ? statusColor.error : s.result === 1 ? statusColor.done : s.color;
        const gsz = size * (ending ? 2.6 : 1.6);
        ctx.drawImage(glowSprite(fc), s.x - gsz, s.y - gsz, gsz * 2, gsz * 2);
        ctx.globalAlpha = alpha;
        ctx.drawImage(s.icon, s.x - size / 2, s.y - size / 2, size, size);

        if (!ending && !reduced) {
          if (s.kind === 'bash') {
            // Terminal: blinking cursor and a soft pulse.
            if (Math.floor(t * 2.5) % 2 === 0) {
              ctx.fillStyle = s.color;
              ctx.fillRect(s.x + size * 0.32, s.y - size * 0.05, size * 0.16, size * 0.3);
            }
            const ph = (t % 1) / 1;
            ctx.globalAlpha = alpha * 0.5 * (1 - ph);
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(s.x, s.y, size / 2 + ph * 10, 0, Math.PI * 2);
            ctx.stroke();
          } else if (s.kind !== 'agent' && s.kind !== 'ask') {
            // Data stream: into the agent for reads, out of it for writes.
            s.emitAcc += edt * STREAM_RATE;
            while (s.emitAcc >= 1) {
              s.emitAcc -= 1;
              const jitter = (Math.random() - 0.5) * 0.5;
              if (s.kind === 'write') spawnParticle(v.x, v.y, s.x, s.y, jitter, clock, 0.6 + Math.random() * 0.3, 4 + Math.random() * 2, s.dot);
              else spawnParticle(s.x, s.y, v.x, v.y, jitter, clock, 0.6 + Math.random() * 0.3, 4 + Math.random() * 2, s.dot);
            }
          }
        }
      }
    }
    ctx.globalAlpha = 1;
    return animating;
  }

  function drawRipples(): boolean {
    if (!rippleLive) return false;
    ctx.lineWidth = 2;
    for (const r of ripples) {
      if (!r.alive) continue;
      const p = (clock - r.start) / r.dur;
      if (p >= 1 || !posOf(r.agent, pA)) {
        r.alive = false;
        rippleLive--;
        continue;
      }
      if (p < 0) continue;
      const e = 1 - (1 - p) * (1 - p);
      ctx.globalAlpha = 0.8 * (1 - p);
      ctx.strokeStyle = r.color;
      ctx.beginPath();
      ctx.arc(pA.x, pA.y, r.r0 + (r.r1 - r.r0) * e, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    return rippleLive > 0;
  }

  /** Endpoints and control point of a comet into pA (from), pB (to), pC (control). */
  function cometPath(k: Comet): boolean {
    if (!posOf(k.to, pB)) return false;
    if (k.fixedFrom) {
      pA.x = k.fx;
      pA.y = k.fy;
    } else if (!posOf(k.from, pA)) return false;
    // Same bulge as the edge: always computed parent → child, so reverse for returns.
    if (k.bend < 0) control(pB.x, pB.y, pA.x, pA.y, 0.14, pC);
    else control(pA.x, pA.y, pB.x, pB.y, 0.14, pC);
    return true;
  }

  function drawComets(): boolean {
    if (!cometLive) return false;
    let li = 0;
    labelSlots.fill(-1);
    ctx.globalCompositeOperation = 'lighter';
    for (let idx = 0; idx < MAX_COMETS; idx++) {
      const k = comets[idx]!;
      if (!k.alive) continue;
      const age = clock - k.start;
      if (age < 0) continue;
      const p = k.dur > 0 ? age / k.dur : 1;
      if (!k.arrived && p >= 1) arrive(k, k.start + k.dur);
      // Keep the record a moment after arrival for the label fade.
      if (p >= 1 && age > k.dur + 0.6) {
        k.alive = false;
        cometLive--;
        continue;
      }
      if (!cometPath(k)) {
        k.alive = false;
        cometLive--;
        continue;
      }
      if (li < MAX_LABELS) labelSlots[li++] = idx;
      else {
        // Keep the newest few: replace the oldest slot.
        let oldest = 0;
        for (let j = 1; j < MAX_LABELS; j++) if (comets[labelSlots[j]!]!.start < comets[labelSlots[oldest]!]!.start) oldest = j;
        if (comets[labelSlots[oldest]!]!.start < k.start) labelSlots[oldest] = idx;
      }
      if (p >= 1) continue;
      const e = easeInOut(p);
      const rev = k.bend < 0;
      // Tail: fading dots behind the head along the same curve.
      for (let j = TAIL; j >= 0; j--) {
        const tp = e - j * 0.028;
        if (tp < 0) continue;
        const u = rev ? 1 - tp : tp;
        const sx = rev ? bez(pB.x, pC.x, pA.x, u) : bez(pA.x, pC.x, pB.x, u);
        const sy = rev ? bez(pB.y, pC.y, pA.y, u) : bez(pA.y, pC.y, pB.y, u);
        const sz = j === 0 ? 22 : 13 * (1 - j / (TAIL + 1));
        ctx.globalAlpha = j === 0 ? 1 : 0.7 * (1 - j / (TAIL + 1));
        ctx.drawImage(k.img, sx - sz / 2, sy - sz / 2, sz, sz);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    return cometLive > 0;
  }

  /** Speech bubbles with the first words of each message, on the newest few comets. */
  function drawCometLabels() {
    if (!cometLive) return;
    ctx.font = FONT_BUBBLE;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const inv = 1 / Math.max(zoom, 0.5);
    for (let j = 0; j < MAX_LABELS; j++) {
      const idx = labelSlots[j]!;
      if (idx < 0) continue;
      const k = comets[idx]!;
      if (!k.alive || !k.label || !cometPath(k)) continue;
      const age = clock - k.start;
      const p = k.dur > 0 ? clamp(age / k.dur, 0, 1) : 1;
      const e = easeInOut(p);
      const u = k.bend < 0 ? 1 - e : e;
      const hx = k.bend < 0 ? bez(pB.x, pC.x, pA.x, u) : bez(pA.x, pC.x, pB.x, u);
      const hy = k.bend < 0 ? bez(pB.y, pC.y, pA.y, u) : bez(pA.y, pC.y, pB.y, u);
      const fadeIn = clamp(age / 0.15, 0, 1);
      const fadeOut = 1 - clamp((age - k.dur - (reduced ? 0.6 : 0.05)) / 0.3, 0, 1);
      const a = fadeIn * fadeOut;
      if (a <= 0) continue;
      ctx.save();
      ctx.translate(hx, hy - 16);
      ctx.scale(inv, inv);
      const w = k.labelW + 16;
      const h = 20;
      ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(8,12,24,0.94)';
      ctx.strokeStyle = k.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h - 4, w, h, 7);
      ctx.moveTo(-4, -4);
      ctx.lineTo(0, 2);
      ctx.lineTo(4, -4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color.holoBright;
      ctx.fillText(k.label, -w / 2 + 8, -h / 2 - 4);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawParticles(): boolean {
    if (!particleLive) return false;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = particles[i]!;
      if (!p.alive) continue;
      const q = (clock - p.start) / p.dur;
      if (q >= 1) {
        p.alive = false;
        particleLive--;
        continue;
      }
      if (q < 0) continue;
      const x = bez(p.x0, p.cx, p.x1, q);
      const y = bez(p.y0, p.cy, p.y1, q);
      ctx.globalAlpha = q < 0.15 ? q / 0.15 : 1 - (q - 0.15) / 0.85;
      const sz = p.size * (1.2 - q * 0.5);
      ctx.drawImage(p.img, x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    return particleLive > 0;
  }

  // ---------------------------------------------------------------- input
  function toWorld(sx: number, sy: number): [number, number] {
    return [(sx - cssW / 2 - panX) / zoom, (sy - cssH / 2 - panY) / zoom];
  }

  function hit(sx: number, sy: number): AgentId | null {
    const [wx, wy] = toWorld(sx, sy);
    let best: AgentId | null = null;
    let bestD = Infinity;
    // The "you" node is a pseudo-agent: clicking it selects USER_AGENT.
    if (user.shown) {
      const d = Math.hypot(user.x - wx, user.y - wy);
      if (d < Math.max(USER_RADIUS + 8, 22)) {
        best = USER_AGENT;
        bestD = d;
      }
    }
    for (const [id, v] of visuals) {
      if (v.exitStart >= 0) continue;
      if (v.bw > 0 && wx >= v.bx && wx <= v.bx + v.bw && wy >= v.by && wy <= v.by + v.bh) {
        return v.badgeKey;
      }
      const d = Math.hypot(v.x - wx, v.y - wy);
      const reach = Math.max(v.radius + 8, 22);
      if (d < reach && d < bestD) {
        best = id;
        bestD = d;
      }
    }
    return best;
  }

  let drag: { id: number; x: number; y: number; moved: boolean } | null = null;

  function local(e: { clientX: number; clientY: number }): [number, number] {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  }

  function onPointerMove(e: PointerEvent) {
    if (drag && drag.id === e.pointerId) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      panX += dx;
      panY += dy;
      userMovedCamera = true;
      canvas.style.cursor = 'grabbing';
      requestFrame();
      return;
    }
    const [sx, sy] = local(e);
    const h = hit(sx, sy);
    if (h !== hovered) {
      hovered = h;
      canvas.style.cursor = h ? 'pointer' : 'grab';
      requestFrame();
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (!drag || drag.id !== e.pointerId) return;
    const wasClick = !drag.moved;
    drag = null;
    canvas.style.cursor = hovered ? 'pointer' : 'grab';
    if (wasClick) {
      const [sx, sy] = local(e);
      const id = hit(sx, sy);
      if (id?.startsWith('finished:')) {
        options.onShowFinished?.();
        return;
      }
      selected = id;
      options.onSelectAgent?.(id);
      requestFrame();
    }
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const [sx, sy] = local(e);
    const [wx, wy] = toWorld(sx, sy);
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    zoom = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    // Keep the world point under the cursor fixed.
    panX = sx - cssW / 2 - wx * zoom;
    panY = sy - cssH / 2 - wy * zoom;
    userMovedCamera = true;
    requestFrame();
  }

  function onDblClick() {
    userMovedCamera = false;
    fitCamera(false);
    requestFrame();
  }

  function onMotionChange() {
    reduced = motionQuery.matches;
    requestFrame();
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, rect.width);
    cssH = Math.max(1, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    if (!userMovedCamera) fitCamera(true);
    requestFrame();
  }

  canvas.style.cursor = 'grab';
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDblClick);
  motionQuery.addEventListener('change', onMotionChange);
  resize();

  return {
    setState,
    pushEvents,
    clearEffects,
    setTimeScale(k: number) {
      // Effects speed up with replay, but stay readable at high speeds.
      timeScale = clamp(Number.isFinite(k) ? k : 1, 0.25, 4);
    },
    resize,
    setSelected(agent) {
      if (agent === selected) return;
      selected = agent;
      requestFrame();
    },
    anchorOf(id, out) {
      if (!posOf(id, out)) return false;
      // World → screen: the inverse of toWorld().
      out.x = out.x * zoom + cssW / 2 + panX;
      out.y = out.y * zoom + cssH / 2 + panY;
      out.r = radiusOf(id) * zoom;
      return true;
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      if (lazyTimer) clearTimeout(lazyTimer);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
      motionQuery.removeEventListener('change', onMotionChange);
    },
  };
}

const COUNT_LABELS: string[] = Array.from({ length: 100 }, (_, i) => String(i));

/** Neurons on the thinking halo. */
const THINK_NODES = 7;
/** Seconds per idle breath. */
const IDLE_BREATH = 4;
/** Redraw interval for slow ambient (idle) motion, ms. */
const LAZY_MS = 110;
/** Seconds per pulse of the "waiting for permission" rings and badge bob. */
const WAIT_PERIOD = 1.6;
/** Radius of the "!" badge above a waiting agent. */
const WAIT_BADGE_R = 8;
const FONT_WAIT = `800 12px ${fontSans}`;
/** Dash patterns reused every frame (setLineDash copies, so sharing is safe). */
const WAIT_DASH = [4, 7];
const NO_DASH: number[] = [];

/** Subagent bots are cool blue-grey so the orchestrator's coral bot stands out. */
const SUB_BODY = '#8fb4d8';

/** Stable pseudo-random phase in [0, 3) seconds from an agent id. */
function phaseOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 3000) / 1000;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
