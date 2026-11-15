// Pure layout: where each visible agent orb sits in world space. Main sits at the origin,
// the human ("you") to its left, subagents fan out to the right on a ring sized for their
// title pills, and a collision pass pushes overlapping label boxes apart. Finished
// subagents are hidden and take no slot. Kept free of drawing so the WebGPU renderer can
// reuse it.
import type { AgentId, AgentState, SessionState } from '../protocol';
import { MAIN_AGENT } from '../protocol';

export interface Placement {
  x: number;
  y: number;
  radius: number;
  depth: number;
  /** Nearest visible ancestor (where the edge is drawn to), or `null` for the root. */
  parent: AgentId | null;
}

/** Extents of an agent's label box relative to its orb center. */
export interface BoxSize {
  /** Total width, centered on the orb. */
  w: number;
  /** Distance from the orb center up to the box top (pill, thought bubble). */
  top: number;
  /** Distance from the orb center down to the box bottom (tool satellites, labels). */
  bottom: number;
}

export interface LayoutOptions {
  /** Reserve a slot for the human on the left of the root. */
  showUser: boolean;
  /** Label box of one agent at the given orb radius. */
  measure: (agent: AgentState, radius: number, finished: number) => BoxSize;
}

export interface LayoutResult {
  places: Map<AgentId, Placement>;
  /** The "you" node, when shown. */
  user: { x: number; y: number } | null;
  /** Finished (hidden) subagents counted at their nearest visible ancestor. */
  finished: Map<AgentId, number>;
  root: AgentId | null;
}

export const ROOT_RADIUS = 46;
export const CHILD_RADIUS = 30;
export const USER_RADIUS = 22;
export const USER_ID: AgentId = 'user';
const USER_OFFSET = 250;
const RING_ROOT = 320;
const RING_CHILD = 290;
/** Angular gap kept free on the left of the root for the user node. */
const USER_WEDGE = 1.1;
const GAP = 16;
const PASSES = 48;

export function findRoot(agents: Record<AgentId, AgentState>): AgentId | null {
  if (agents[MAIN_AGENT]) return MAIN_AGENT;
  for (const a of Object.values(agents)) if (!a.parent || !agents[a.parent]) return a.id;
  return null;
}

/** Finished subagents leave the scene; the root always stays. */
export function isHidden(a: AgentState, root: AgentId | null): boolean {
  return a.id !== root && a.status === 'done';
}

/** Walks up to the nearest visible ancestor (the root when the chain is broken). */
export function visibleAncestor(
  agents: Record<AgentId, AgentState>,
  id: AgentId,
  root: AgentId,
): AgentId {
  let cur = agents[id]?.parent ?? null;
  for (let guard = 0; cur && guard < 64; guard++) {
    const a = agents[cur];
    if (!a) break;
    if (!isHidden(a, root)) return cur;
    cur = a.parent;
  }
  return root;
}

interface Node {
  id: AgentId | null;
  x: number;
  y: number;
  box: BoxSize;
  fixed: boolean;
}

export function layout(session: SessionState, opts: LayoutOptions): LayoutResult {
  const places = new Map<AgentId, Placement>();
  const finished = new Map<AgentId, number>();
  const agents = session.agents;
  const root = findRoot(agents);
  if (!root) return { places, user: null, finished, root };

  const children = new Map<AgentId, AgentState[]>();
  for (const a of Object.values(agents)) {
    if (a.id === root) continue;
    const anc = visibleAncestor(agents, a.id, root);
    if (isHidden(a, root)) {
      finished.set(anc, (finished.get(anc) ?? 0) + 1);
      continue;
    }
    let list = children.get(anc);
    if (!list) children.set(anc, (list = []));
    list.push(a);
  }
  for (const list of children.values()) {
    list.sort((x, y) => x.started_at - y.started_at || (x.id < y.id ? -1 : 1));
  }

  const nodes: Node[] = [];
  const rootAgent = agents[root]!;
  places.set(root, { x: 0, y: 0, radius: ROOT_RADIUS, depth: 0, parent: null });
  nodes.push({ id: root, x: 0, y: 0, box: opts.measure(rootAgent, ROOT_RADIUS, finished.get(root) ?? 0), fixed: true });

  let user: { x: number; y: number } | null = null;
  if (opts.showUser) {
    user = { x: -USER_OFFSET, y: 0 };
    nodes.push({
      id: null,
      x: user.x,
      y: 0,
      box: { w: 90, top: USER_RADIUS + 12, bottom: USER_RADIUS + 26 },
      fixed: true,
    });
  }

  const visit = (id: AgentId, depth: number, dir: number) => {
    const kids = children.get(id);
    const me = places.get(id);
    if (!kids || !me) return;
    const n = kids.length;
    const boxes = kids.map((k) => opts.measure(k, CHILD_RADIUS, finished.get(k.id) ?? 0));
    let avg = 0;
    for (const b of boxes) avg += Math.max(b.w, (b.top + b.bottom) * 0.8);
    avg /= n;
    let spread: number;
    let ring: number;
    if (depth === 0) {
      const full = Math.PI * 2 - (opts.showUser ? USER_WEDGE : 0);
      spread = Math.min(full, 0.75 * n);
      // Arc length per child ≈ one label box.
      ring = Math.max(RING_ROOT, (n * avg * 0.95) / spread);
    } else {
      spread = Math.min(Math.PI * 0.9, 0.6 * n);
      ring = Math.max(RING_CHILD, (n * avg * 0.9) / Math.max(spread, 0.6));
    }
    for (let i = 0; i < n; i++) {
      const kid = kids[i]!;
      if (places.has(kid.id)) continue; // cycle guard
      const angle = dir - spread / 2 + ((i + 0.5) / n) * spread;
      const p: Placement = {
        x: me.x + Math.cos(angle) * ring,
        y: me.y + Math.sin(angle) * ring,
        radius: CHILD_RADIUS,
        depth: depth + 1,
        parent: id,
      };
      places.set(kid.id, p);
      nodes.push({ id: kid.id, x: p.x, y: p.y, box: boxes[i]!, fixed: false });
      visit(kid.id, depth + 1, angle);
    }
  };
  visit(root, 0, 0);

  resolveCollisions(nodes);
  for (const nd of nodes) {
    if (!nd.id) continue;
    const p = places.get(nd.id);
    if (p) {
      p.x = nd.x;
      p.y = nd.y;
    }
  }
  return { places, user, finished, root };
}

/** Pushes overlapping label boxes apart along the axis of least penetration. */
function resolveCollisions(nodes: Node[]) {
  const n = nodes.length;
  for (let pass = 0; pass < PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j]!;
        if (a.fixed && b.fixed) continue;
        const ox = (a.box.w + b.box.w) / 2 + GAP - Math.abs(a.x - b.x);
        if (ox <= 0) continue;
        // Vertical overlap of [y - top, y + bottom] intervals.
        const aTop = a.y - a.box.top;
        const aBot = a.y + a.box.bottom;
        const bTop = b.y - b.box.top;
        const bBot = b.y + b.box.bottom;
        const oy = Math.min(aBot, bBot) - Math.max(aTop, bTop) + GAP;
        if (oy <= 0) continue;
        moved = true;
        const wa = a.fixed ? 0 : b.fixed ? 1 : 0.5;
        const wb = 1 - wa;
        if (ox < oy) {
          const s = a.x < b.x || (a.x === b.x && i < j) ? -1 : 1;
          a.x += s * ox * wa;
          b.x -= s * ox * wb;
        } else {
          const ac = (aTop + aBot) / 2;
          const bc = (bTop + bBot) / 2;
          const s = ac < bc || (ac === bc && i < j) ? -1 : 1;
          a.y += s * oy * wa;
          b.y -= s * oy * wb;
        }
      }
    }
    if (!moved) break;
  }
}
