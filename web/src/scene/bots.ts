// Animated pixel-bot agents. Each agent is a small Claude-Code-style robot whose pose and
// props show what it is doing: thinking (eyes drift, a scan line sweeps the forehead, the
// antenna sparks when an idea lands), reading (holds a page,
// eyes scan lines), writing (pencil scribbles, sparks), searching (magnifier sweeps),
// running a command (types at a little terminal), waiting for approval (raises a hand,
// amber "!"), error (X eyes, shake), compacting (squashes), done (happy eyes, wave), idle
// (standby: slow breathing, drowsy eyes, blinking standby LED, a drifting "z").
//
// Performance: every pose frame is rasterised ONCE into a small offscreen canvas per
// (pose, frame, body colour) and then blitted with drawImage at any scale with image
// smoothing off. No per-frame paths, gradients or allocations.

import type { AgentStatus, ToolKind } from '../protocol';

/** Pixel grid size of one bot frame. */
export const BOT_W = 20;
export const BOT_H = 18;

export type Pose =
  | 'idle'
  | 'think'
  | 'read'
  | 'write'
  | 'search'
  | 'bash'
  | 'web'
  | 'agent'
  | 'ask'
  | 'error'
  | 'compact'
  | 'done';

/** Frames per pose; frame index = floor(t * FPS) % frames. */
const FRAMES: Record<Pose, number> = {
  idle: 12,
  think: 12,
  read: 8,
  write: 6,
  search: 8,
  bash: 6,
  web: 8,
  agent: 6,
  ask: 6,
  error: 4,
  compact: 6,
  done: 8,
};
/** Animation rate per pose (frames per second). */
const FPS: Record<Pose, number> = {
  idle: 3,
  think: 6,
  read: 4,
  write: 8,
  search: 5,
  bash: 7,
  web: 5,
  agent: 6,
  ask: 3,
  error: 12,
  compact: 5,
  done: 4,
};

/** Picks the pose from the agent's status and the kind of its newest running tool. */
export function poseFor(status: AgentStatus, tool: ToolKind | null): Pose {
  switch (status) {
    case 'thinking':
      return 'think';
    case 'tool':
      switch (tool) {
        case 'read':
          return 'read';
        case 'write':
          return 'write';
        case 'search':
          return 'search';
        case 'bash':
          return 'bash';
        case 'web':
          return 'web';
        case 'agent':
          return 'agent';
        case 'ask':
          return 'ask';
        default:
          return 'bash';
      }
    case 'awaiting_permission':
      return 'ask';
    case 'error':
      return 'error';
    case 'compacting':
      return 'compact';
    case 'done':
      return 'done';
    default:
      return 'idle';
  }
}

/** Whether a pose animates (idle still blinks, but slowly). */
export function poseFps(p: Pose): number {
  return FPS[p];
}

export function frameOf(p: Pose, t: number): number {
  return Math.floor(t * FPS[p]) % FRAMES[p];
}

// ---------------------------------------------------------------- palette

interface Palette {
  body: string;
  shade: string;
  light: string;
  eye: string;
  screen: string;
  paper: string;
  ink: string;
  metal: string;
  accent: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(hex: string, to: string, k: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(to);
  const c = a.map((v, i) => Math.round(v + (b[i]! - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function palette(body: string, accent: string): Palette {
  return {
    body,
    shade: mix(body, '#000000', 0.32),
    light: mix(body, '#ffffff', 0.35),
    eye: '#0b0d14',
    screen: '#0e1a24',
    paper: '#e8eef6',
    ink: '#5b6b80',
    metal: '#b8c4d4',
    accent,
  };
}

// ---------------------------------------------------------------- drawing

type Px = (x: number, y: number, w: number, h: number, c: string) => void;

/** Body: rounded head with ears and antenna, a small torso and two feet. `dy` bobs. */
function drawBody(px: Px, p: Palette, dy: number, squash = 0) {
  const top = 3 + dy + squash;
  const h = 9 - squash;
  // antenna
  px(9, top - 2, 2, 1, p.shade);
  px(9.5, top - 3, 1, 1, p.accent);
  // head
  px(4, top, 12, h, p.body);
  px(4, top, 12, 1, p.light);
  px(4, top + h - 1, 12, 1, p.shade);
  px(3, top + 1, 1, h - 2, p.body);
  px(16, top + 1, 1, h - 2, p.shade);
  // ears
  px(2, top + 3, 1, 3, p.shade);
  px(17, top + 3, 1, 3, p.shade);
  // torso
  px(6, top + h, 8, 3 - Math.min(2, squash), p.shade);
  // feet
  px(6, 16, 3, 1, p.shade);
  px(11, 16, 3, 1, p.shade);
}

type Eyes = 'open' | 'blink' | 'left' | 'right' | 'up' | 'down' | 'x' | 'happy' | 'wide' | 'squint';

function drawEyes(px: Px, p: Palette, dy: number, kind: Eyes, squash = 0) {
  const y = 6 + dy + squash;
  const L = 7;
  const R = 11;
  switch (kind) {
    case 'blink':
      px(L, y + 1, 2, 1, p.eye);
      px(R, y + 1, 2, 1, p.eye);
      break;
    case 'left':
      px(L - 1, y, 2, 2, p.eye);
      px(R - 1, y, 2, 2, p.eye);
      break;
    case 'right':
      px(L + 1, y, 2, 2, p.eye);
      px(R + 1, y, 2, 2, p.eye);
      break;
    case 'up':
      px(L, y - 1, 2, 2, p.eye);
      px(R, y - 1, 2, 2, p.eye);
      break;
    case 'down':
      px(L, y + 1, 2, 2, p.eye);
      px(R, y + 1, 2, 2, p.eye);
      break;
    case 'x':
      for (const ex of [L, R]) {
        px(ex - 0.5, y - 0.5, 1, 1, p.eye);
        px(ex + 1.5, y - 0.5, 1, 1, p.eye);
        px(ex + 0.5, y + 0.5, 1, 1, p.eye);
        px(ex - 0.5, y + 1.5, 1, 1, p.eye);
        px(ex + 1.5, y + 1.5, 1, 1, p.eye);
      }
      break;
    case 'happy':
      for (const ex of [L, R]) {
        px(ex - 0.5, y + 1, 1, 1, p.eye);
        px(ex + 0.5, y, 1, 1, p.eye);
        px(ex + 1.5, y + 1, 1, 1, p.eye);
      }
      break;
    case 'wide':
      px(L - 0.5, y - 0.5, 3, 3, p.eye);
      px(R - 0.5, y - 0.5, 3, 3, p.eye);
      px(L + 0.5, y - 0.5, 1, 1, '#ffffff');
      px(R + 0.5, y - 0.5, 1, 1, '#ffffff');
      break;
    case 'squint':
      px(L, y + 0.5, 2, 1, p.eye);
      px(R, y + 0.5, 2, 1, p.eye);
      break;
    default:
      px(L, y, 2, 2, p.eye);
      px(R, y, 2, 2, p.eye);
  }
}

/** Arms: left/right hand positions relative to the torso. */
function arm(px: Px, p: Palette, side: -1 | 1, hx: number, hy: number) {
  const sx = side < 0 ? 5 : 14;
  const sy = 13;
  // two-segment arm from shoulder toward the hand
  px((sx + hx) / 2, (sy + hy) / 2, 1, 1, p.shade);
  px(hx, hy, 1.5, 1.5, p.body);
}

function drawPose(px: Px, p: Palette, pose: Pose, f: number) {
  const bob = (n: number) => (Math.floor(f / n) % 2 === 0 ? 0 : 1);
  switch (pose) {
    case 'idle': {
      // Standby: a slow breath (rises a quarter cell), drowsy eyes, a standby LED that
      // blinks on the antenna and a little "z" that drifts up and fades.
      const dy = [0, 0, 0.25, 0.5, 0.5, 0.5, 0.25, 0, 0, 0, 0, 0][f]!;
      const lids: Eyes[] = ['open', 'open', 'squint', 'squint', 'squint', 'blink', 'squint', 'squint', 'squint', 'blink', 'open', 'open'];
      drawBody(px, p, dy);
      if (f % 6 >= 3) px(9.5, dy, 1, 1, p.shade); // LED off
      drawEyes(px, p, dy, lids[f]!);
      arm(px, p, -1, 3, 14);
      arm(px, p, 1, 16, 14);
      if (f >= 4) {
        const k = f - 4; // 0..7
        const zx = 16.5 + k * 0.15;
        const zy = 1.6 - k * 0.2;
        const a = k < 5 ? 0.85 : 0.85 - (k - 4) * 0.25;
        const z = `rgba(207,230,255,${a.toFixed(2)})`;
        px(zx, zy, 2.25, 0.75, z);
        px(zx + 0.75, zy + 0.75, 0.75, 0.75, z);
        px(zx, zy + 1.5, 2.25, 0.75, z);
      }
      break;
    }
    case 'think': {
      // Pondering: eyes drift up and around, a scan line sweeps the forehead (processing),
      // a finger taps the chin, and the antenna sparks when an idea lands ("aha" eyes).
      const look: Eyes[] = ['up', 'up', 'left', 'left', 'up', 'right', 'right', 'up', 'squint', 'squint', 'wide', 'up'];
      drawBody(px, p, 0);
      drawEyes(px, p, 0, look[f]!);
      const sx = 5 + (f % 6) * 1.5;
      px(sx - 1, 4, 1, 0.5, p.light);
      px(sx, 4, 2, 0.5, p.accent);
      arm(px, p, -1, 3, 14);
      arm(px, p, 1, 12, f % 2 === 0 ? 12 : 11.5);
      if (f >= 9) {
        const k = f - 9; // 0..2: spark bursts outward
        px(9.5, 0, 1, 1, '#ffffff');
        px(8 - k * 0.75, 0.25 + k * 0.25, 0.75, 0.75, p.accent);
        px(11.25 + k * 0.75, 0.25 + k * 0.25, 0.75, 0.75, p.accent);
        if (k > 0) px(9.625, 1.5 + k * 0.25, 0.75, 0.5, '#ffffff');
      }
      break;
    }
    case 'read': {
      // Holds a page in both hands; eyes scan line by line.
      drawBody(px, p, 0);
      const scan: Eyes[] = ['left', 'open', 'right', 'down', 'left', 'open', 'right', 'blink'];
      drawEyes(px, p, 0, scan[f]!);
      const lift = f % 4 === 3 ? -1 : 0;
      px(5, 11 + lift, 10, 6, p.paper);
      px(5, 11 + lift, 10, 1, '#ffffff');
      for (let i = 0; i < 3; i++) px(6.5, 13 + lift + i * 1.3, i === 2 ? 4 : 7, 0.6, p.ink);
      // highlight the line being read
      const line = f % 3;
      px(6, 12.6 + lift + line * 1.3, 8, 1, 'rgba(102,204,255,0.45)');
      arm(px, p, -1, 4, 13 + lift);
      arm(px, p, 1, 15, 13 + lift);
      break;
    }
    case 'write': {
      // Scribbles on a pad; pencil moves, ink grows.
      drawBody(px, p, 0);
      drawEyes(px, p, 0, f % 3 === 0 ? 'down' : 'squint');
      px(4, 13, 9, 4, p.paper);
      const done = 1 + (f % 6);
      for (let i = 0; i < done; i++) px(5 + i * 1.2, 14 + (i % 2) * 0.6, 1, 0.6, p.ink);
      const hx = 5 + done * 1.2;
      // pencil
      px(hx, 12, 1, 3, '#ffbb44');
      px(hx, 15, 1, 1, p.eye);
      arm(px, p, -1, 4, 15);
      arm(px, p, 1, hx + 1, 13);
      break;
    }
    case 'search': {
      // Sweeps a magnifier left and right.
      drawBody(px, p, 0);
      const sweep = [-3, -2, 0, 2, 3, 2, 0, -2][f]!;
      drawEyes(px, p, 0, sweep < 0 ? 'left' : sweep > 0 ? 'right' : 'wide');
      const cx = 10 + sweep;
      const cy = 13;
      px(cx - 2, cy - 2, 4, 1, p.metal);
      px(cx - 2, cy + 1, 4, 1, p.metal);
      px(cx - 2, cy - 1, 1, 2, p.metal);
      px(cx + 1, cy - 1, 1, 2, p.metal);
      px(cx - 1, cy - 1, 2, 2, 'rgba(170,238,255,0.55)');
      px(cx + 2, cy + 2, 1, 1, p.metal);
      px(cx + 3, cy + 3, 1, 1, p.metal);
      arm(px, p, 1, cx + 3, cy + 3);
      arm(px, p, -1, 3, 14);
      break;
    }
    case 'bash': {
      // Types at a tiny terminal with a blinking cursor and scrolling output.
      drawBody(px, p, 0);
      drawEyes(px, p, 0, 'down');
      px(3, 12, 14, 6, p.screen);
      px(3, 12, 14, 1, '#1d3446');
      const lines = 1 + (f % 3);
      for (let i = 0; i < lines; i++) px(4, 13.3 + i * 1.3, 3 + ((i * 5 + f) % 7), 0.7, '#66ffaa');
      if (f % 2 === 0) px(4 + ((f * 3) % 9), 13.3 + lines * 1.3, 1, 0.8, '#ffffff');
      const tap = f % 2;
      arm(px, p, -1, 6, 12 - tap);
      arm(px, p, 1, 13, 11 + tap);
      break;
    }
    case 'web': {
      // A small globe spins between its hands.
      drawBody(px, p, 0);
      drawEyes(px, p, 0, f % 4 === 0 ? 'up' : 'open');
      const cx = 10;
      const cy = 14;
      px(cx - 2, cy - 2, 4, 4, '#2a6c9c');
      px(cx - 3, cy - 1, 1, 2, '#2a6c9c');
      px(cx + 2, cy - 1, 1, 2, '#2a6c9c');
      const m = (f % 4) - 1.5;
      px(cx + m - 0.5, cy - 2, 1, 4, '#66ffaa');
      px(cx - 3, cy - 0.3, 6, 0.6, 'rgba(170,238,255,0.6)');
      arm(px, p, -1, cx - 4, cy);
      arm(px, p, 1, cx + 3, cy);
      break;
    }
    case 'agent': {
      // Throws a spark: dispatching a subagent.
      drawBody(px, p, 0);
      drawEyes(px, p, 0, 'right');
      const k = f / 5;
      arm(px, p, -1, 3, 14);
      arm(px, p, 1, 16, 12 - Math.round(k * 3));
      px(17 + k * 2, 10 - k * 3, 1.5, 1.5, '#cc88ff');
      px(16.5 + k * 2, 11 - k * 3, 1, 1, 'rgba(204,136,255,0.5)');
      break;
    }
    case 'ask': {
      // Raises a hand and waits; hand waves slightly.
      drawBody(px, p, 0);
      drawEyes(px, p, 0, f % 3 === 0 ? 'wide' : 'open');
      const wave = f % 2;
      arm(px, p, -1, 3, 14);
      px(15, 6 - wave, 1.5, 1.5, p.body);
      px(15, 8 - wave, 1, 3, p.shade);
      break;
    }
    case 'error': {
      const shake = [0, -1, 1, 0][f]!;
      const off = (x: number, y: number, w: number, h: number, c: string) => px(x + shake, y, w, h, c);
      drawBody(off, p, 0);
      drawEyes(off, p, 0, 'x');
      arm(off, p, -1, 3, 12);
      arm(off, p, 1, 16, 12);
      // smoke puff
      px(15 + shake, 1 + (f % 2), 1, 1, 'rgba(255,85,102,0.7)');
      break;
    }
    case 'compact': {
      // Squashes down and springs back while packing context.
      const sq = [0, 1, 2, 3, 2, 1][f]!;
      drawBody(px, p, 0, sq);
      drawEyes(px, p, 0, sq > 1 ? 'squint' : 'open', sq);
      arm(px, p, -1, 3, 14);
      arm(px, p, 1, 16, 14);
      break;
    }
    case 'done': {
      const dy = bob(2) * 0.5;
      drawBody(px, p, dy);
      drawEyes(px, p, dy, 'happy');
      // waves
      const up = f % 4 < 2;
      arm(px, p, -1, 3, 14);
      px(16, up ? 6 : 7, 1.5, 1.5, p.body);
      px(15.5, up ? 8 : 9, 1, 3, p.shade);
      break;
    }
  }
}

// ---------------------------------------------------------------- cache

const SCALE = 4; // raster each pixel cell as 4×4 so half-cells stay crisp
const cache = new Map<string, HTMLCanvasElement>();

/** One rasterised frame. Cached by pose, frame and colours; cheap to blit. */
export function botFrame(pose: Pose, frame: number, body: string, accent: string): HTMLCanvasElement {
  const key = `${pose}|${frame}|${body}|${accent}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = BOT_W * SCALE;
  c.height = BOT_H * SCALE;
  const g = c.getContext('2d');
  if (g) {
    const pal = palette(body, accent);
    const px: Px = (x, y, w, h, col) => {
      g.fillStyle = col;
      g.fillRect(Math.round(x * SCALE), Math.round(y * SCALE), Math.max(1, Math.round(w * SCALE)), Math.max(1, Math.round(h * SCALE)));
    };
    drawPose(px, pal, pose, frame);
  }
  cache.set(key, c);
  return c;
}

/** Warms the cache for a colour so the first animated frames don't hitch. */
export function prewarm(body: string, accent: string): void {
  for (const pose of Object.keys(FRAMES) as Pose[]) {
    for (let f = 0; f < FRAMES[pose]; f++) botFrame(pose, f, body, accent);
  }
}
