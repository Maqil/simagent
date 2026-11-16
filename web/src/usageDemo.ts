// Synthetic `UsageReport` for demo mode (`?demo=…`), so the Usage page can be seen without a
// server. Deterministic (seeded) so the numbers don't jump on every 60s refresh, except for
// the live session's current hour, which grows with the clock.
import type { CostBreakdown, SessionUsage, Usage, UsageBlock, UsageBucket, UsageReport } from './protocol';
import { costBreakdown } from './replay';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BLOCK = 5 * HOUR;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROJECTS = [
  { cwd: '/Users/demo/projects/orbital', weight: 0.55 },
  { cwd: '/Users/demo/projects/orbital-auth', weight: 0.3 },
  { cwd: '/Users/demo/projects/docs-site', weight: 0.15 },
] as const;

/** The first title belongs to the live session. */
const TITLES = [
  'Fix flaky HTTP client timeout test',
  'Add retry budget to the uploader',
  'Refactor session store into slices',
  'Migrate auth tokens to rotating keys',
  'Write OAuth device-flow handler',
  'Investigate slow cold start',
  'Docs: rewrite the quickstart',
  'Add rate limiter middleware',
  'Port parser to streaming reads',
  'Review PR: telemetry batching',
  'Bump dependencies and fix breakage',
  'Profile render loop allocations',
  'Design schema for audit log',
  'Add snapshot tests for config loader',
  'Clean up feature flags',
] as const;

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';

function bucket(
  rnd: () => number,
  hour_ms: number,
  model: string,
  subagent: boolean,
  requests: number,
  context: number,
): UsageBucket {
  // One average request, priced alone (long-prompt multipliers apply per request), then scaled.
  const per: Usage = {
    input: Math.round(4 + rnd() * 30),
    output: Math.round((subagent ? 250 : 450) + rnd() * 900),
    cache_read: Math.round(context * (0.75 + rnd() * 0.5)),
    cache_write: Math.round(1500 + rnd() * 4500),
  };
  per.cache_write_1h = Math.round(per.cache_write * (0.85 + rnd() * 0.15));
  per.thinking = Math.round(per.output * (0.2 + rnd() * 0.25));
  const c = costBreakdown(model, per);
  const scale = (u: Usage): Usage => ({
    input: u.input * requests,
    output: u.output * requests,
    cache_read: u.cache_read * requests,
    cache_write: u.cache_write * requests,
    cache_write_1h: (u.cache_write_1h ?? 0) * requests,
    thinking: (u.thinking ?? 0) * requests,
  });
  const cost: CostBreakdown = {
    input: c.input * requests,
    output: c.output * requests,
    cache_read: c.cache_read * requests,
    cache_write: c.cache_write * requests,
  };
  return { hour_ms, model, subagent, requests, usage: scale(per), cost };
}

function pick<T>(rnd: () => number, list: readonly T[]): T {
  return list[Math.floor(rnd() * list.length) % list.length]!;
}

function pickProject(rnd: () => number): string {
  let r = rnd();
  for (const p of PROJECTS) {
    if ((r -= p.weight) <= 0) return p.cwd;
  }
  return PROJECTS[0].cwd;
}

/** Local start hour for a session: mornings and afternoons, some evenings. */
function startHour(rnd: () => number): number {
  const r = rnd();
  if (r < 0.4) return 9 + Math.floor(rnd() * 3);
  if (r < 0.8) return 13 + Math.floor(rnd() * 4);
  return 19 + Math.floor(rnd() * 3);
}

function sessionBuckets(rnd: () => number, startMs: number, hours: number, now: number, mainModel: string): UsageBucket[] {
  const out: UsageBucket[] = [];
  let context = 25_000 + rnd() * 20_000;
  for (let h = 0; h < hours; h++) {
    const hour_ms = Math.floor((startMs + h * HOUR) / HOUR) * HOUR;
    if (hour_ms > now) break;
    // The current hour is only partly done.
    const frac = hour_ms + HOUR > now ? Math.max(0.1, (now - hour_ms) / HOUR) : 1;
    const req = (n: number) => Math.max(1, Math.round(n * frac));
    out.push(bucket(rnd, hour_ms, mainModel, false, req(15 + rnd() * 55), context));
    if (rnd() < 0.45) out.push(bucket(rnd, hour_ms, SONNET, true, req(4 + rnd() * 26), 18_000 + rnd() * 25_000));
    if (rnd() < 0.15) out.push(bucket(rnd, hour_ms, HAIKU, true, req(3 + rnd() * 12), 8_000 + rnd() * 10_000));
    context = Math.min(160_000, context + 15_000 + rnd() * 30_000);
  }
  return out;
}

/** Estimated 5-hour windows over every bucket (same rule as the server: a window opens at
 *  the hour of the first request after the previous one closed). */
function blocksOf(sessions: SessionUsage[], now: number): UsageBlock[] {
  const all = sessions.flatMap((s) => s.buckets.map((b) => ({ b, last: Math.min(now, s.last_activity_ms, b.hour_ms + HOUR - 1) })));
  all.sort((x, y) => x.b.hour_ms - y.b.hour_ms);
  const blocks: UsageBlock[] = [];
  let cur: UsageBlock | null = null;
  for (const { b, last } of all) {
    if (!cur || b.hour_ms >= cur.end_ms) {
      cur = {
        start_ms: b.hour_ms,
        end_ms: b.hour_ms + BLOCK,
        last_activity_ms: b.hour_ms,
        active: false,
        requests: 0,
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0, thinking: 0 },
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      };
      blocks.push(cur);
    }
    cur.last_activity_ms = Math.max(cur.last_activity_ms, last);
    cur.requests += b.requests;
    const u = cur.usage;
    u.input += b.usage.input;
    u.output += b.usage.output;
    u.cache_read += b.usage.cache_read;
    u.cache_write += b.usage.cache_write;
    u.cache_write_1h = (u.cache_write_1h ?? 0) + (b.usage.cache_write_1h ?? 0);
    u.thinking = (u.thinking ?? 0) + (b.usage.thinking ?? 0);
    cur.cost.input += b.cost.input;
    cur.cost.output += b.cost.output;
    cur.cost.cache_read += b.cost.cache_read;
    cur.cost.cache_write += b.cost.cache_write;
  }
  for (const b of blocks) b.active = now < b.end_ms;
  return blocks;
}

/** A realistic report for the last `days` days ending at `now`. */
export function demoUsageReport(days: number, now: number = Date.now()): UsageReport {
  const span = Math.max(1, Math.min(365, Math.round(days)));
  const since = now - span * DAY;
  const rnd = mulberry32(0x5eed);
  const sessions: SessionUsage[] = [];

  // About 0.4 sessions a day over the last 120 days, more on weekdays.
  for (let d = 120; d >= 1; d--) {
    const dayStart = new Date(now - d * DAY);
    dayStart.setHours(0, 0, 0, 0);
    const weekend = dayStart.getDay() === 0 || dayStart.getDay() === 6;
    const n = rnd() < (weekend ? 0.12 : 0.42) ? (rnd() < 0.25 ? 2 : 1) : 0;
    for (let k = 0; k < n; k++) {
      const start = dayStart.getTime() + startHour(rnd) * HOUR + Math.floor(rnd() * 50) * 60_000;
      const hours = 1 + Math.floor(rnd() * 4);
      const cwd = pickProject(rnd);
      const main = rnd() < 0.85 ? OPUS : SONNET;
      const buckets = sessionBuckets(rnd, start, hours, now, main);
      if (!buckets.length) continue;
      const last = Math.min(now - 60_000, buckets.at(-1)!.hour_ms + Math.floor((0.3 + rnd() * 0.65) * HOUR));
      sessions.push({
        id: `demo-${(sessions.length + 1).toString(16).padStart(4, '0')}-${Math.floor(rnd() * 0xffffff).toString(16)}`,
        project: cwd.replace(/\//g, '-'),
        cwd,
        title: pick(rnd, TITLES.slice(1)),
        live: false,
        last_activity_ms: last,
        buckets,
      });
    }
  }

  // The live session: started ~2.5h ago and still going, so there is an active window.
  const liveStart = now - 2.5 * HOUR;
  sessions.push({
    id: 'demo-5e1f-4c2a-9b7d-orbital',
    project: '-Users-demo-projects-orbital',
    cwd: '/Users/demo/projects/orbital',
    title: 'Fix flaky HTTP client timeout test',
    live: true,
    last_activity_ms: now - 2 * 60_000,
    buckets: sessionBuckets(mulberry32(0x11fe), liveStart, 4, now, OPUS),
  });

  // Keep only what falls in range, most recently active first.
  const inRange = sessions
    .map((s) => ({ ...s, buckets: s.buckets.filter((b) => b.hour_ms + HOUR > since) }))
    .filter((s) => s.buckets.length > 0)
    .sort((a, b) => b.last_activity_ms - a.last_activity_ms);

  return { generated_ms: now, since_ms: since, sessions: inRange, blocks: blocksOf(inRange, now) };
}
