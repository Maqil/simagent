// `/?gallery=bots`: every bot pose, animated, for both bot colours. A visual test bench
// for the scene's agent sprites (no server needed).
import { useEffect, useRef } from 'react';
import { BOT_H, BOT_W, botFrame, frameOf, type Pose } from '../scene/bots';
import { color, statusColor } from '../tokens';

const POSES: { pose: Pose; label: string; ring: string }[] = [
  { pose: 'idle', label: 'idle', ring: statusColor.idle },
  { pose: 'think', label: 'thinking', ring: statusColor.thinking },
  { pose: 'read', label: 'Read', ring: statusColor.tool },
  { pose: 'write', label: 'Write / Edit', ring: statusColor.tool },
  { pose: 'search', label: 'Grep / Glob', ring: statusColor.tool },
  { pose: 'bash', label: 'Bash', ring: statusColor.tool },
  { pose: 'web', label: 'WebFetch', ring: statusColor.tool },
  { pose: 'agent', label: 'Agent (dispatch)', ring: statusColor.tool },
  { pose: 'ask', label: 'awaiting approval', ring: statusColor.awaiting_permission },
  { pose: 'compact', label: 'compacting', ring: statusColor.compacting },
  { pose: 'error', label: 'error', ring: statusColor.error },
  { pose: 'done', label: 'done', ring: statusColor.done },
];
const BODIES = [
  { body: color.mascotBody, name: 'orchestrator' },
  { body: '#8fb4d8', name: 'subagent' },
];
const CELL = 150;
const R = 46;

export function BotGallery() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    const dpr = window.devicePixelRatio || 1;
    const w = POSES.length * CELL;
    const h = BODIES.length * CELL + 30;
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    let raf = 0;
    const t0 = performance.now();
    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#050510';
      g.fillRect(0, 0, w, h);
      g.font = '12px ui-sans-serif, system-ui';
      g.textAlign = 'center';
      POSES.forEach((p, i) => {
        g.fillStyle = '#aaeeff';
        g.fillText(p.label, i * CELL + CELL / 2, 18);
        BODIES.forEach((b, j) => {
          const x = i * CELL + CELL / 2;
          const y = 30 + j * CELL + CELL / 2;
          g.fillStyle = 'rgba(8,12,24,0.88)';
          g.beginPath();
          g.arc(x, y, R, 0, Math.PI * 2);
          g.fill();
          g.strokeStyle = p.ring;
          g.lineWidth = 2;
          g.stroke();
          const img = botFrame(p.pose, frameOf(p.pose, t), b.body, p.ring);
          const bw = R * 1.55;
          const bh = (bw * BOT_H) / BOT_W;
          g.imageSmoothingEnabled = false;
          g.drawImage(img, x - bw / 2, y - bh / 2, bw, bh);
        });
      });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div style={{ padding: 20, background: '#050510', minHeight: '100vh', overflow: 'auto' }}>
      <h2 style={{ color: '#aaeeff', font: '600 16px ui-sans-serif', margin: '0 0 12px' }}>
        simagent · bot poses (top: orchestrator, bottom: subagent)
      </h2>
      <canvas ref={ref} />
    </div>
  );
}
