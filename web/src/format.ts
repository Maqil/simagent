import type { AgentStatus, JsonValue, SessionState } from './protocol';

export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export function sessionLabel(s: SessionState): string {
  if (s.title) return s.title;
  if (s.cwd) return basename(s.cwd) || s.cwd;
  return s.id.slice(0, 8);
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Status priority for summarizing a whole session in one dot. */
const priority: Record<AgentStatus, number> = {
  awaiting_permission: 6,
  error: 5,
  tool: 4,
  thinking: 3,
  compacting: 2,
  idle: 1,
  done: 0,
};

export function sessionStatus(s: SessionState): AgentStatus {
  if (s.pending.length > 0) return 'awaiting_permission';
  let best: AgentStatus = 'idle';
  let bestP = -1;
  for (const a of Object.values(s.agents)) {
    const p = priority[a.status] ?? 0;
    if (p > bestP) {
      bestP = p;
      best = a.status;
    }
  }
  return best;
}

export function isBusy(status: AgentStatus): boolean {
  return (
    status === 'thinking' ||
    status === 'tool' ||
    status === 'awaiting_permission' ||
    status === 'compacting'
  );
}

export function prettyJson(v: JsonValue): string {
  try {
    return JSON.stringify(v, null, 2) ?? 'null';
  } catch {
    return String(v);
  }
}

export function getString(v: JsonValue | undefined, key: string): string | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const x = v[key];
    if (typeof x === 'string') return x;
  }
  return null;
}

/** Offset from a session's start, e.g. `+2:05` or `+1:02:05`. */
export function formatOffset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (x: number) => String(x).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `+${h}:${p(m)}:${p(s % 60)}` : `+${m}:${p(s % 60)}`;
}

/** "just now", "5m ago", "3h ago", "2d ago", then a date. */
export function formatAgo(ms: number, now: number = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
