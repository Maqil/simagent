// Usage page data: fetch `GET /api/usage` and fold its hour buckets into everything the
// page shows. Every helper here is pure (report in, plain objects out) so the component
// can memoize one `summarize()` call per report.
//
// Dollar figures are API-equivalent: what the tokens would cost at API list prices, from
// the server's `CostBreakdown`. The 5-hour windows are estimates (the real quota is not
// on disk), so nothing here computes a "% of limit".
import type { CostBreakdown, SessionUsage, UsageBlock, UsageBucket, UsageReport } from './protocol';
import { getToken } from './connection';
import { basename } from './format';
import { modelInfo } from './replay';

export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];

const HOUR = 3_600_000;

// ---------------------------------------------------------------- fetch

export async function fetchUsage(days: number, signal?: AbortSignal): Promise<UsageReport> {
  const d = Math.max(1, Math.min(365, Math.round(days)));
  const q = new URLSearchParams({ days: String(d), token: getToken() });
  const res = await fetch(`/api/usage?${q.toString()}`, { signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
  }
  return (await res.json()) as UsageReport;
}

// ---------------------------------------------------------------- totals

export type TokenKind = 'input' | 'cache_read' | 'cache_write' | 'output';
export const TOKEN_KINDS: readonly TokenKind[] = ['input', 'cache_read', 'cache_write', 'output'];

export interface Totals {
  requests: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number;
  thinking: number;
  cost: CostBreakdown;
  /** What cache reads would have cost at full input price, minus what they did cost. */
  savings: number;
}

export function emptyTotals(): Totals {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    cache_write_1h: 0,
    thinking: 0,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    savings: 0,
  };
}

/** Savings on one bucket's cache reads. Scales the actual cache-read cost by the model's
 *  input / cache-read price ratio, so long-prompt multipliers carry over. */
export function cacheSavings(model: string, cacheReadCost: number): number {
  const info = modelInfo(model);
  if (!info || info.cache_read_per_mtok <= 0) return 0;
  return cacheReadCost * (info.input_per_mtok / info.cache_read_per_mtok - 1);
}

export function addBucket(t: Totals, b: UsageBucket): void {
  t.requests += b.requests;
  t.input += b.usage.input;
  t.output += b.usage.output;
  t.cache_read += b.usage.cache_read;
  t.cache_write += b.usage.cache_write;
  t.cache_write_1h += b.usage.cache_write_1h ?? 0;
  t.thinking += b.usage.thinking ?? 0;
  t.cost.input += b.cost.input;
  t.cost.output += b.cost.output;
  t.cost.cache_read += b.cost.cache_read;
  t.cost.cache_write += b.cost.cache_write;
  t.savings += cacheSavings(b.model, b.cost.cache_read);
}

export function addTotals(t: Totals, o: Totals): void {
  t.requests += o.requests;
  t.input += o.input;
  t.output += o.output;
  t.cache_read += o.cache_read;
  t.cache_write += o.cache_write;
  t.cache_write_1h += o.cache_write_1h;
  t.thinking += o.thinking;
  t.cost.input += o.cost.input;
  t.cost.output += o.cost.output;
  t.cost.cache_read += o.cost.cache_read;
  t.cost.cache_write += o.cost.cache_write;
  t.savings += o.savings;
}

export const tokensOf = (t: Pick<Totals, TokenKind>): number => t.input + t.output + t.cache_read + t.cache_write;
export const costOf = (c: CostBreakdown): number => c.input + c.output + c.cache_read + c.cache_write;

/** cache_read / everything that went into the prompt. 0 when there was no prompt. */
export function cacheHitRate(t: Pick<Totals, 'input' | 'cache_read' | 'cache_write'>): number {
  const prompt = t.input + t.cache_read + t.cache_write;
  return prompt > 0 ? t.cache_read / prompt : 0;
}

/** Share of `part` in `whole`, 0 when `whole` is 0. */
export const share = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

// ---------------------------------------------------------------- models

export type Family = 'opus' | 'sonnet' | 'haiku' | 'other';
export const FAMILIES: readonly Family[] = ['opus', 'sonnet', 'haiku', 'other'];
export const FAMILY_LABEL: Record<Family, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', other: 'Other' };

export function modelFamily(model: string): Family {
  const id = model.toLowerCase();
  if (id.includes('opus')) return 'opus';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('haiku')) return 'haiku';
  return 'other';
}

/** `claude-opus-5-5` → `Opus 5.5`; `claude-haiku-4-5-20251001` → `Haiku 4.5`. */
export function modelLabel(model: string): string {
  const parts = model
    .replace(/^claude-/i, '')
    .replace(/-\d{8}$/, '')
    .split('-')
    .filter(Boolean);
  const words = parts.filter((p) => !/^\d+$/.test(p));
  const nums = parts.filter((p) => /^\d+$/.test(p));
  if (!words.length) return model;
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return nums.length ? `${name} ${nums.join('.')}` : name;
}

// ---------------------------------------------------------------- local time

/** `YYYY-MM-DD` of the local day containing `ms`. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localMidnight(ms: number): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Monday = 0 … Sunday = 6. */
export const weekdayIndex = (ms: number): number => (new Date(ms).getDay() + 6) % 7;
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

// ---------------------------------------------------------------- summary

export interface DayRow {
  key: string;
  startMs: number;
  totals: Totals;
  byFamily: Record<Family, { tokens: number; cost: number }>;
}

export interface ModelRow {
  model: string;
  label: string;
  family: Family;
  totals: Totals;
}

export interface SessionRow {
  id: string;
  label: string;
  title: string | null;
  live: boolean;
  lastActivity: number;
  totals: Totals;
  /** Subagent part of `totals`. */
  sub: Totals;
}

export interface ProjectRow {
  key: string;
  name: string;
  cwd: string | null;
  lastActivity: number;
  totals: Totals;
  sub: Totals;
  sessions: SessionRow[];
}

export interface BlockStats {
  block: UsageBlock;
  elapsedMs: number;
  remainingMs: number;
  /** 0..1 of the way through the window, by time. */
  timeFrac: number;
  tokens: number;
  cost: number;
  tokensPerHour: number;
  costPerHour: number;
  projectedTokens: number;
  projectedCost: number;
}

export interface UsageSummary {
  totals: Totals;
  main: Totals;
  sub: Totals;
  days: DayRow[];
  /** Families with any usage, in fixed order (so colors never move). */
  families: Family[];
  models: ModelRow[];
  projects: ProjectRow[];
  sessionCount: number;
  activeDays: number;
  /** [weekday 0..6][local hour 0..23]. */
  heat: { requests: number; tokens: number; cost: number }[][];
  heatMax: number;
  current: BlockStats | null;
  /** Most recent last. */
  blocks: UsageBlock[];
}

function projectName(s: SessionUsage): string {
  if (s.cwd) return basename(s.cwd) || s.cwd;
  const parts = s.project.split('-').filter(Boolean);
  return parts.at(-1) ?? s.project;
}

export function blockStats(b: UsageBlock, now: number): BlockStats {
  const span = Math.max(1, b.end_ms - b.start_ms);
  const clampedNow = Math.min(b.end_ms, Math.max(b.start_ms, now));
  // At least a minute of elapsed time so the first request doesn't project to infinity.
  const elapsedMs = Math.max(60_000, clampedNow - b.start_ms);
  const remainingMs = Math.max(0, b.end_ms - clampedNow);
  const tokens = tokensOf(b.usage);
  const cost = costOf(b.cost);
  const hours = elapsedMs / HOUR;
  const tokensPerHour = tokens / hours;
  const costPerHour = cost / hours;
  return {
    block: b,
    elapsedMs,
    remainingMs,
    timeFrac: Math.min(1, (clampedNow - b.start_ms) / span),
    tokens,
    cost,
    tokensPerHour,
    costPerHour,
    projectedTokens: tokens + (tokensPerHour * remainingMs) / HOUR,
    projectedCost: cost + (costPerHour * remainingMs) / HOUR,
  };
}

export function summarize(report: UsageReport, now: number = Date.now()): UsageSummary {
  const totals = emptyTotals();
  const main = emptyTotals();
  const sub = emptyTotals();
  const models = new Map<string, ModelRow>();
  const projects = new Map<string, ProjectRow>();
  const dayMap = new Map<string, DayRow>();
  const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ requests: 0, tokens: 0, cost: 0 })));
  const famSeen = new Set<Family>();

  // Every local day in range, so empty days show as gaps instead of vanishing.
  const days: DayRow[] = [];
  const end = localMidnight(Math.max(report.generated_ms, report.since_ms));
  for (const d = localMidnight(report.since_ms); d <= end; d.setDate(d.getDate() + 1)) {
    const row: DayRow = {
      key: localDayKey(d.getTime()),
      startMs: d.getTime(),
      totals: emptyTotals(),
      byFamily: { opus: { tokens: 0, cost: 0 }, sonnet: { tokens: 0, cost: 0 }, haiku: { tokens: 0, cost: 0 }, other: { tokens: 0, cost: 0 } },
    };
    days.push(row);
    dayMap.set(row.key, row);
  }

  for (const s of report.sessions) {
    const st = emptyTotals();
    const ss = emptyTotals();
    for (const b of s.buckets) {
      addBucket(totals, b);
      addBucket(st, b);
      addBucket(b.subagent ? sub : main, b);
      if (b.subagent) addBucket(ss, b);

      let m = models.get(b.model);
      if (!m) models.set(b.model, (m = { model: b.model, label: modelLabel(b.model), family: modelFamily(b.model), totals: emptyTotals() }));
      addBucket(m.totals, b);

      const fam = modelFamily(b.model);
      const tok = tokensOf(b.usage);
      const usd = costOf(b.cost);
      if (tok > 0) famSeen.add(fam);
      const day = dayMap.get(localDayKey(b.hour_ms));
      if (day) {
        addBucket(day.totals, b);
        day.byFamily[fam].tokens += tok;
        day.byFamily[fam].cost += usd;
      }
      const cell = heat[weekdayIndex(b.hour_ms)]![new Date(b.hour_ms).getHours()]!;
      cell.requests += b.requests;
      cell.tokens += tok;
      cell.cost += usd;
    }

    const row: SessionRow = {
      id: s.id,
      label: s.title ?? (s.cwd ? basename(s.cwd) : s.id.slice(0, 8)),
      title: s.title,
      live: s.live,
      lastActivity: s.last_activity_ms,
      totals: st,
      sub: ss,
    };
    let p = projects.get(s.project);
    if (!p) {
      p = { key: s.project, name: projectName(s), cwd: s.cwd, lastActivity: 0, totals: emptyTotals(), sub: emptyTotals(), sessions: [] };
      projects.set(s.project, p);
    }
    p.sessions.push(row);
    p.lastActivity = Math.max(p.lastActivity, s.last_activity_ms);
    p.cwd ??= s.cwd;
    addTotals(p.totals, st);
    addTotals(p.sub, ss);
  }

  let heatMax = 0;
  for (const row of heat) for (const c of row) heatMax = Math.max(heatMax, c.requests);

  const blocks = [...report.blocks].sort((a, b) => a.start_ms - b.start_ms);
  const active = [...blocks].reverse().find((b) => b.active && now < b.end_ms) ?? null;

  return {
    totals,
    main,
    sub,
    days,
    families: FAMILIES.filter((f) => famSeen.has(f)),
    models: [...models.values()]
      .filter((m) => tokensOf(m.totals) > 0)
      .sort((a, b) => costOf(b.totals.cost) - costOf(a.totals.cost)),
    projects: [...projects.values()].filter((p) => tokensOf(p.totals) > 0),
    sessionCount: report.sessions.filter((s) => s.buckets.length > 0).length,
    activeDays: days.filter((d) => d.totals.requests > 0).length,
    heat,
    heatMax,
    current: active ? blockStats(active, now) : null,
    blocks,
  };
}

// ---------------------------------------------------------------- sorting

export type SortKey = 'cost' | 'tokens' | 'last';

export function sortValue(r: { totals: Totals; lastActivity: number }, key: SortKey): number {
  if (key === 'cost') return costOf(r.totals.cost);
  if (key === 'tokens') return tokensOf(r.totals);
  return r.lastActivity;
}

export function sortProjects(list: readonly ProjectRow[], key: SortKey): ProjectRow[] {
  const by = <T extends { totals: Totals; lastActivity: number }>(a: T, b: T) => sortValue(b, key) - sortValue(a, key);
  return [...list].sort(by).map((p) => ({ ...p, sessions: [...p.sessions].sort(by) }));
}

// ---------------------------------------------------------------- axis

/** A round axis maximum >= `v` (1, 2, 2.5, 5 × 10^n) and its tick values (incl. 0). */
export function niceTicks(v: number, count = 4): number[] {
  if (!(v > 0)) return [0];
  const raw = v / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((s) => s * mag >= raw) ?? 10) * mag;
  const n = Math.ceil(v / step);
  return Array.from({ length: n + 1 }, (_, i) => i * step);
}
