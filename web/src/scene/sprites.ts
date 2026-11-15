// Pre-rendered sprites. Glows and orb shading are drawn once per color into offscreen
// canvases and then blitted with drawImage: no per-frame shadowBlur, filters or gradients.

const GLOW_SIZE = 256;
const ORB_SIZE = 128;

const glowCache = new Map<string, HTMLCanvasElement>();
const orbCache = new Map<string, HTMLCanvasElement>();

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  return [c, ctx];
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Soft radial glow, transparent at the edge. Drawn at 4x the orb radius. */
export function glowSprite(hex: string): HTMLCanvasElement {
  let c = glowCache.get(hex);
  if (c) return c;
  const [canvas, ctx] = makeCanvas(GLOW_SIZE);
  const h = GLOW_SIZE / 2;
  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0, rgba(hex, 0.55));
  g.addColorStop(0.25, rgba(hex, 0.28));
  g.addColorStop(0.55, rgba(hex, 0.08));
  g.addColorStop(1, rgba(hex, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, GLOW_SIZE, GLOW_SIZE);
  glowCache.set(hex, canvas);
  c = canvas;
  return c;
}

/** Shaded sphere: dark core, colored body, specular highlight, thin bright rim. */
export function orbSprite(hex: string): HTMLCanvasElement {
  let c = orbCache.get(hex);
  if (c) return c;
  const [canvas, ctx] = makeCanvas(ORB_SIZE);
  const h = ORB_SIZE / 2;
  const r = h - 2;
  const body = ctx.createRadialGradient(h * 0.7, h * 0.6, r * 0.05, h, h, r);
  body.addColorStop(0, rgba('#ffffff', 0.9));
  body.addColorStop(0.18, rgba(hex, 0.95));
  body.addColorStop(0.7, rgba(hex, 0.45));
  body.addColorStop(1, 'rgba(5,5,16,0.9)');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(h, h, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = rgba(hex, 0.9);
  ctx.lineWidth = 2;
  ctx.stroke();
  orbCache.set(hex, canvas);
  c = canvas;
  return c;
}

/** A 1-world-unit grid tile with one dot, for a repeating pattern. */
export function dotTile(spacing: number, dot: string): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(spacing);
  ctx.fillStyle = dot;
  ctx.beginPath();
  ctx.arc(spacing / 2, spacing / 2, 1.2, 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}

export { rgba };

const dotCache = new Map<string, HTMLCanvasElement>();
const iconCache = new Map<string, HTMLCanvasElement>();
let botCanvas: HTMLCanvasElement | null = null;

export const DOT_SIZE = 32;

/** Small bright dot with a soft halo: particles and comet heads. */
export function dotSprite(hex: string): HTMLCanvasElement {
  let c = dotCache.get(hex);
  if (c) return c;
  const [canvas, ctx] = makeCanvas(DOT_SIZE);
  const h = DOT_SIZE / 2;
  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0, rgba('#ffffff', 1));
  g.addColorStop(0.16, rgba(hex, 1));
  g.addColorStop(0.4, rgba(hex, 0.35));
  g.addColorStop(1, rgba(hex, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, DOT_SIZE, DOT_SIZE);
  dotCache.set(hex, canvas);
  c = canvas;
  return c;
}

export type IconKind = 'read' | 'write' | 'search' | 'bash' | 'web' | 'agent' | 'ask' | 'other';

const ICON_SIZE = 64;

/** Round tool badge with a vector glyph per tool kind, drawn once per kind and color. */
export function toolIconSprite(kind: IconKind, hex: string): HTMLCanvasElement {
  const key = `${kind}${hex}`;
  let c = iconCache.get(key);
  if (c) return c;
  const [canvas, ctx] = makeCanvas(ICON_SIZE);
  const h = ICON_SIZE / 2;
  ctx.fillStyle = 'rgba(8,12,24,0.95)';
  ctx.beginPath();
  ctx.arc(h, h, h - 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = hex;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = hex;
  ctx.fillStyle = hex;
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (kind) {
    case 'read': {
      // Page with a folded corner and text lines.
      ctx.moveTo(22, 16);
      ctx.lineTo(37, 16);
      ctx.lineTo(43, 22);
      ctx.lineTo(43, 48);
      ctx.lineTo(22, 48);
      ctx.closePath();
      ctx.moveTo(37, 16);
      ctx.lineTo(37, 22);
      ctx.lineTo(43, 22);
      ctx.moveTo(27, 29);
      ctx.lineTo(38, 29);
      ctx.moveTo(27, 35);
      ctx.lineTo(38, 35);
      ctx.moveTo(27, 41);
      ctx.lineTo(34, 41);
      ctx.stroke();
      break;
    }
    case 'write': {
      // Pencil at 45°.
      ctx.moveTo(20, 44);
      ctx.lineTo(22, 37);
      ctx.lineTo(39, 20);
      ctx.lineTo(44, 25);
      ctx.lineTo(27, 42);
      ctx.closePath();
      ctx.moveTo(35, 24);
      ctx.lineTo(40, 29);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(18, 47);
      ctx.lineTo(30, 47);
      ctx.stroke();
      break;
    }
    case 'search': {
      ctx.arc(29, 29, 9, 0, Math.PI * 2);
      ctx.moveTo(36, 36);
      ctx.lineTo(45, 45);
      ctx.stroke();
      break;
    }
    case 'bash': {
      // Prompt chevron and underscore.
      ctx.moveTo(19, 24);
      ctx.lineTo(27, 32);
      ctx.lineTo(19, 40);
      ctx.moveTo(31, 41);
      ctx.lineTo(44, 41);
      ctx.stroke();
      break;
    }
    case 'web': {
      ctx.arc(h, h, 14, 0, Math.PI * 2);
      ctx.moveTo(h - 14, h);
      ctx.lineTo(h + 14, h);
      ctx.moveTo(h, h - 14);
      ctx.ellipse(h, h, 6.5, 14, 0, -Math.PI / 2, Math.PI * 1.5);
      ctx.stroke();
      break;
    }
    case 'agent': {
      // Four-point spark.
      ctx.moveTo(h, 15);
      ctx.quadraticCurveTo(h + 3, h - 3, 49, h);
      ctx.quadraticCurveTo(h + 3, h + 3, h, 49);
      ctx.quadraticCurveTo(h - 3, h + 3, 15, h);
      ctx.quadraticCurveTo(h - 3, h - 3, h, 15);
      ctx.fill();
      break;
    }
    case 'ask': {
      ctx.arc(h, 26, 7, Math.PI * 1.1, Math.PI * 2.4);
      ctx.lineTo(h, 37);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(h, 44, 2.4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    default: {
      for (let i = -1; i <= 1; i++) {
        ctx.moveTo(h + i * 9 + 3, h);
        ctx.arc(h + i * 9, h, 3, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }
  iconCache.set(key, canvas);
  c = canvas;
  return c;
}

/** The 12×8 pixel bot (the "you" node), crisp at 1 px per cell; scale with smoothing off. */
export function botSprite(body: string, eye: string): HTMLCanvasElement {
  if (botCanvas) return botCanvas;
  const [canvas, ctx] = makeCanvas(12);
  canvas.height = 8;
  ctx.fillStyle = body;
  ctx.fillRect(5, 0, 2, 1); // antenna
  ctx.fillRect(1, 1, 10, 6); // head/body
  ctx.fillRect(0, 3, 1, 2); // ears
  ctx.fillRect(11, 3, 1, 2);
  ctx.fillRect(2, 7, 2, 1); // feet
  ctx.fillRect(8, 7, 2, 1);
  ctx.fillStyle = eye;
  ctx.fillRect(3, 3, 2, 2);
  ctx.fillRect(7, 3, 2, 2);
  botCanvas = canvas;
  return canvas;
}
