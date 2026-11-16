// Usage: tokens, output, API-equivalent cost and activity across every session on disk.
// Data comes from `GET /api/usage?days=N` (or a synthetic report in demo mode), folded by
// `summarize()` in ../usage.ts. Polls every 60s while open; Esc closes.
import { useCallback, useEffect, useMemo, useState } from 'react';
import './usage.css';
import type { UsageReport } from '../protocol';
import { useStore } from '../store';
import { formatAgo } from '../format';
import { RANGES, cacheHitRate, costOf, fetchUsage, share, summarize, tokensOf, type RangeDays, type SessionRow, type UsageSummary } from '../usage';
import { demoUsageReport } from '../usageDemo';
import { Composition, DailyChart, Heatmap, WindowCard, pct, tok, usd } from './UsageCharts';
import { ModelTable, ProjectTable } from './UsageTables';

const POLL_MS = 60_000;
const RANGE_KEY = 'simagent.usage.days';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; report: UsageReport; at: number; error: string | null };

function loadRange(): RangeDays {
  try {
    const v = Number(localStorage.getItem(RANGE_KEY));
    return (RANGES as readonly number[]).includes(v) ? (v as RangeDays) : 30;
  } catch {
    return 30;
  }
}

function saveRange(d: RangeDays): void {
  try {
    localStorage.setItem(RANGE_KEY, String(d));
  } catch {
    // Storage unavailable (private window): the range just isn't remembered.
  }
}

/** Fetches the report for `days`, refreshing every minute; keeps the last good report on error. */
function useUsageReport(days: RangeDays, demo: boolean) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const retry = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    let ctrl: AbortController | null = null;
    setLoad((l) => (l.kind === 'ok' ? l : { kind: 'loading' }));
    const run = async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const report = demo ? demoUsageReport(days) : await fetchUsage(days, ctrl.signal);
        if (alive) setLoad({ kind: 'ok', report, at: Date.now(), error: null });
      } catch (e) {
        if (!alive || (e instanceof DOMException && e.name === 'AbortError')) return;
        const message = e instanceof Error ? e.message : String(e);
        setLoad((l) => (l.kind === 'ok' ? { ...l, error: message } : { kind: 'error', message }));
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), POLL_MS);
    return () => {
      alive = false;
      ctrl?.abort();
      window.clearInterval(timer);
    };
  }, [days, demo, nonce]);

  return { load, retry };
}

/** Re-renders every `ms` so "updated 20s ago" and the window countdown move. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function UsagePage() {
  const setView = useStore((s) => s.setView);
  const openReplay = useStore((s) => s.openReplay);
  const demo = useStore((s) => s.connection === 'demo');
  const [days, setDays] = useState<RangeDays>(loadRange);
  const { load, retry } = useUsageReport(days, demo);
  const now = useNow(15_000);
  const close = useCallback(() => setView('live'), [setView]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The History dialog handles its own Esc.
      if (e.key === 'Escape' && !e.defaultPrevented && !useStore.getState().browserOpen) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const report = load.kind === 'ok' ? load.report : null;
  // Re-fold when the report changes, and once a minute so the open window's countdown moves.
  const minute = Math.floor(now / 60_000);
  const sum = useMemo(() => (report ? summarize(report, Math.max(minute * 60_000, report.generated_ms)) : null), [report, minute]);

  const pickRange = (d: RangeDays) => {
    setDays(d);
    saveRange(d);
  };
  const onOpen = (s: SessionRow) => {
    setView('live');
    void openReplay(s.id, { title: s.title, autoplay: true });
  };

  return (
    <div className="usage" role="region" aria-label="Usage">
      <div className="usage__inner">
        <header className="u-head">
          <div className="u-head__title">
            <h1 className="u-h1">Usage</h1>
            <p className="u-lede">
              Every Claude Code session on this machine over the last {days} days. Dollar amounts are <strong>API-equivalent</strong>: what these tokens would
              cost at API list prices. A Pro or Max plan doesn't bill per token.
            </p>
          </div>
          <div className="u-head__tools">
            <div className="u-seg" role="group" aria-label="Range">
              {RANGES.map((d) => (
                <button key={d} className={`u-seg__btn${days === d ? ' is-on' : ''}`} aria-pressed={days === d} onClick={() => pickRange(d)}>
                  {d}d
                </button>
              ))}
            </div>
            {load.kind === 'ok' && (
              <span className="u-sub" title={new Date(load.at).toLocaleString()}>
                Updated {formatAgo(load.at, now)}
                {demo && ', demo data'}
              </span>
            )}
            <button className="iconbtn" onClick={close} aria-label="Close usage" title="Back to live view (Esc)">
              ✕
            </button>
          </div>
        </header>

        {load.kind === 'loading' && <div className="u-state">Reading transcripts…</div>}
        {load.kind === 'error' && (
          <div className="u-state u-state--err" role="alert">
            <p>Couldn't load usage: {load.message}</p>
            <p className="u-sub">Usage needs the simagent server. Check that it is running, then retry.</p>
            <button className="btn btn--small" onClick={retry}>
              Retry
            </button>
          </div>
        )}
        {load.kind === 'ok' && load.error && (
          <div className="u-stale" role="status">
            Refresh failed ({load.error}). Showing data from {formatAgo(load.at, now)}.{' '}
            <button className="link" onClick={retry}>
              Retry
            </button>
          </div>
        )}

        {sum && tokensOf(sum.totals) === 0 && (
          <div className="u-state">
            <p>No usage in the last {days} days.</p>
            <p className="u-sub">Usage is read from Claude Code transcripts in ~/.claude/projects. Run a session and it shows up here within a minute.</p>
          </div>
        )}

        {sum && tokensOf(sum.totals) > 0 && (
          <>
            <Kpis sum={sum} />
            <div className="u-grid">
              <div className="u-grid__main">
                <Composition totals={sum.totals} />
                <DailyChart days={sum.days} families={sum.families} />
              </div>
              <div className="u-grid__side">
                <WindowCard current={sum.current} blocks={sum.blocks} now={now} />
                <Heatmap heat={sum.heat} max={sum.heatMax} />
              </div>
            </div>
            <ModelTable models={sum.models} />
            <ProjectTable projects={sum.projects} now={now} onOpen={onOpen} />
          </>
        )}
      </div>
    </div>
  );
}

function Kpis({ sum }: { sum: UsageSummary }) {
  const t = sum.totals;
  const days = Math.max(1, sum.days.length);
  const tokens = tokensOf(t);
  const cost = costOf(t.cost);
  const tiles: { label: string; value: string; sub: string; title?: string }[] = [
    { label: 'Tokens', value: tok(tokens), sub: `${tok(tokens / days)} a day on average` },
    {
      label: 'Output',
      value: tok(t.output),
      sub: t.thinking > 0 ? `${pct(share(t.thinking, t.output))} of it thinking` : 'Text, tool calls and thinking',
    },
    { label: 'API-equivalent cost', value: usd(cost), sub: `${usd(cost / days)} a day on average`, title: 'At API list prices. Not what your plan bills.' },
    {
      label: 'Cache hit rate',
      value: pct(cacheHitRate(t)),
      sub: t.savings > 0 ? `saved about ${usd(t.savings)}` : 'of prompt tokens came from cache',
      title: 'Cache reads / (input + cache reads + cache writes). Savings compare cache reads with full input price.',
    },
    { label: 'Requests', value: t.requests.toLocaleString(), sub: `${pct(share(sum.sub.requests, t.requests))} from subagents` },
    { label: 'Active days', value: `${sum.activeDays} of ${sum.days.length}`, sub: `${sum.sessionCount} session${sum.sessionCount === 1 ? '' : 's'}` },
  ];
  return (
    <dl className="u-kpis">
      {tiles.map((k) => (
        <div key={k.label} className="u-kpi" title={k.title}>
          <dt>{k.label}</dt>
          <dd className="u-kpi__value">{k.value}</dd>
          <dd className="u-kpi__sub">{k.sub}</dd>
        </div>
      ))}
    </dl>
  );
}
