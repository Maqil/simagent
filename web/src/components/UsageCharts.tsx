// Usage page charts, drawn with plain DOM (no chart library): token/cost composition,
// daily stacked bars, the current 5-hour window, recent windows, and the weekly heatmap.
import { useMemo, useState } from 'react';
import type { UsageBlock } from '../protocol';
import { formatCost, formatDuration, formatTokens } from '../format';
import {
  FAMILY_LABEL,
  TOKEN_KINDS,
  WEEKDAYS,
  costOf,
  niceTicks,
  share,
  tokensOf,
  type BlockStats,
  type DayRow,
  type Family,
  type TokenKind,
  type Totals,
} from '../usage';

// ---------------------------------------------------------------- formatting

/** Tokens, with billions (cache reads add up fast). */
export function tok(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  return formatTokens(Math.round(n));
}

export function pct(x: number): string {
  if (!(x > 0)) return '0%';
  if (x < 0.01) return '<1%';
  return `${Math.round(x * 100)}%`;
}

/** Dollars for big totals: no cents past $1,000. */
export function usd(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString()}`;
  return formatCost(n);
}

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const dayLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const shortDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function Swatch({ kind }: { kind: string }) {
  return <span className={`u-swatch u-c-${kind}`} aria-hidden />;
}

// ---------------------------------------------------------------- composition

export const KIND_LABEL: Record<TokenKind, string> = {
  input: 'Input',
  cache_read: 'Cache read',
  cache_write: 'Cache write',
  output: 'Output',
};

const KIND_HINT: Record<TokenKind, string> = {
  input: 'Prompt tokens not served from cache',
  cache_read: 'Prompt tokens re-read from cache, at a fraction of the input price',
  cache_write: 'Prompt tokens written to cache, at a premium over input',
  output: 'Text, tool calls and thinking the model wrote',
};

function StackBar({ parts, label }: { parts: { kind: TokenKind; value: number }[]; label: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  return (
    <div className="u-stack" role="img" aria-label={label}>
      {parts.map((p) =>
        p.value > 0 ? (
          <span
            key={p.kind}
            className={`u-stack__seg u-c-${p.kind}`}
            style={{ flexGrow: p.value / (total || 1) }}
            title={`${KIND_LABEL[p.kind]}: ${pct(share(p.value, total))}`}
          />
        ) : null,
      )}
    </div>
  );
}

/** "Where the tokens go" vs "where the money goes": same four kinds, same order. */
export function Composition({ totals }: { totals: Totals }) {
  const tokens = tokensOf(totals);
  const cost = costOf(totals.cost);
  const tParts = TOKEN_KINDS.map((k) => ({ kind: k, value: totals[k] }));
  const cParts = TOKEN_KINDS.map((k) => ({ kind: k, value: totals.cost[k] }));
  const readT = share(totals.cache_read, tokens);
  const readC = share(totals.cost.cache_read, cost);
  const thinking = share(totals.thinking, totals.output);
  const w1h = share(totals.cache_write_1h, totals.cache_write);

  return (
    <section className="u-panel u-comp" aria-labelledby="u-comp-h">
      <h2 id="u-comp-h" className="u-h2">
        Where the tokens go, and where the money goes
      </h2>
      {tokens > 0 && (
        <p className="u-insight">
          Cache reads are <strong>{pct(readT)}</strong> of your tokens but only <strong>{pct(readC)}</strong> of the cost.
          {totals.savings > 0 && <> Without the cache, the same work would have cost about {usd(totals.savings)} more.</>}
        </p>
      )}
      <div className="u-comp__bars">
        <div className="u-comp__row">
          <span className="u-comp__label">Tokens</span>
          <StackBar parts={tParts} label={`Token mix: ${tParts.map((p) => `${KIND_LABEL[p.kind]} ${pct(share(p.value, tokens))}`).join(', ')}`} />
          <span className="u-comp__total">{tok(tokens)}</span>
        </div>
        <div className="u-comp__row">
          <span className="u-comp__label">Cost</span>
          <StackBar parts={cParts} label={`Cost mix: ${cParts.map((p) => `${KIND_LABEL[p.kind]} ${pct(share(p.value, cost))}`).join(', ')}`} />
          <span className="u-comp__total">{usd(cost)}</span>
        </div>
      </div>
      <table className="u-table u-comp__table">
        <thead>
          <tr>
            <th scope="col">Kind</th>
            <th scope="col" className="num">Tokens</th>
            <th scope="col" className="num">Share</th>
            <th scope="col" className="num">Cost</th>
            <th scope="col" className="num">Share</th>
          </tr>
        </thead>
        <tbody>
          {TOKEN_KINDS.map((k) => (
            <tr key={k} title={KIND_HINT[k]}>
              <th scope="row">
                <Swatch kind={k} />
                {KIND_LABEL[k]}
                {k === 'output' && totals.thinking > 0 && <span className="u-sub"> {pct(thinking)} thinking</span>}
                {k === 'cache_write' && totals.cache_write_1h > 0 && <span className="u-sub"> {pct(w1h)} 1-hour</span>}
              </th>
              <td className="num">{tok(totals[k])}</td>
              <td className="num u-dim">{pct(share(totals[k], tokens))}</td>
              <td className="num">{usd(totals.cost[k])}</td>
              <td className="num u-dim">{pct(share(totals.cost[k], cost))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------- daily chart

export type Metric = 'tokens' | 'cost';

export function DailyChart({ days, families }: { days: DayRow[]; families: Family[] }) {
  const [metric, setMetric] = useState<Metric>('cost');
  const [hover, setHover] = useState<number | null>(null);
  const value = (d: DayRow) => (metric === 'cost' ? costOf(d.totals.cost) : tokensOf(d.totals));
  const fmt = metric === 'cost' ? usd : tok;

  const { ticks, max, avg, peak } = useMemo(() => {
    let peakI = -1;
    let peakV = 0;
    let sum = 0;
    days.forEach((d, i) => {
      const v = metric === 'cost' ? costOf(d.totals.cost) : tokensOf(d.totals);
      sum += v;
      if (v > peakV) {
        peakV = v;
        peakI = i;
      }
    });
    const t = niceTicks(peakV);
    return { ticks: t, max: t.at(-1) ?? 0, avg: days.length ? sum / days.length : 0, peak: peakI };
  }, [days, metric]);

  const step = Math.max(1, Math.ceil(days.length / 8));
  const hd = hover !== null ? days[hover] : undefined;
  const tickFmt = (v: number) => (metric === 'cost' ? `$${v >= 1000 ? `${v / 1000}k` : v}` : tok(v));

  return (
    <section className="u-panel u-daily" aria-labelledby="u-daily-h">
      <div className="u-panel__head">
        <h2 id="u-daily-h" className="u-h2">
          Daily {metric === 'cost' ? 'cost' : 'tokens'}
        </h2>
        <div className="u-seg" role="group" aria-label="Daily chart metric">
          {(['cost', 'tokens'] as const).map((m) => (
            <button key={m} className={`u-seg__btn${metric === m ? ' is-on' : ''}`} aria-pressed={metric === m} onClick={() => setMetric(m)}>
              {m === 'cost' ? 'Cost' : 'Tokens'}
            </button>
          ))}
        </div>
      </div>
      <p className="u-note">
        Average {fmt(avg)} a day
        {peak >= 0 && days[peak] && (
          <>
            , peak {fmt(value(days[peak]))} on {dayLabel(days[peak].startMs)}
          </>
        )}
        .
      </p>
      {families.length > 1 && (
        <ul className="u-legend" aria-label="Models">
          {families.map((f) => (
            <li key={f}>
              <Swatch kind={f} />
              {FAMILY_LABEL[f]}
            </li>
          ))}
        </ul>
      )}
      <div className="u-plot" onMouseLeave={() => setHover(null)}>
        <div className="u-plot__grid" aria-hidden>
          {ticks.map((t) => (
            <div key={t} className="u-plot__tick" style={{ bottom: `${max ? (t / max) * 100 : 0}%` }}>
              <span>{tickFmt(t)}</span>
            </div>
          ))}
          {avg > 0 && max > 0 && (
            <div className="u-plot__avg" style={{ bottom: `${(avg / max) * 100}%` }}>
              <span>avg</span>
            </div>
          )}
        </div>
        <div className="u-plot__cols" role="list" aria-label={`Daily ${metric} by model`}>
          {days.map((d, i) => {
            const total = value(d);
            return (
              <div
                key={d.key}
                role="listitem"
                className={`u-col${hover === i ? ' is-hover' : ''}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                tabIndex={0}
                aria-label={`${dayLabel(d.startMs)}: ${fmt(total)}`}
              >
                <div className="u-col__bar" style={{ height: `${max ? (total / max) * 100 : 0}%` }}>
                  {[...families].reverse().map((f) => {
                    const v = metric === 'cost' ? d.byFamily[f].cost : d.byFamily[f].tokens;
                    return v > 0 ? <span key={f} className={`u-col__seg u-c-${f}`} style={{ flexGrow: v }} /> : null;
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {hd && hover !== null && (
          <div
            className={`u-tip${hover < days.length / 2 ? ' u-tip--right' : ' u-tip--left'}`}
            style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}
            role="status"
          >
            <div className="u-tip__title">{dayLabel(hd.startMs)}</div>
            {families.map((f) => {
              const v = metric === 'cost' ? hd.byFamily[f].cost : hd.byFamily[f].tokens;
              return (
                <div key={f} className="u-tip__row">
                  <Swatch kind={f} />
                  <span>{FAMILY_LABEL[f]}</span>
                  <span className="num">{fmt(v)}</span>
                </div>
              );
            })}
            <div className="u-tip__row u-tip__total">
              <span />
              <span>Total</span>
              <span className="num">{fmt(value(hd))}</span>
            </div>
            <div className="u-tip__foot">
              {hd.totals.requests} requests, {tok(hd.totals.output)} output
            </div>
          </div>
        )}
      </div>
      <div className="u-plot__x" aria-hidden>
        {days.map((d, i) => (
          <span key={d.key} className={(i / step) % 2 === 1 ? 'u-x-minor' : undefined}>
            {i % step === 0 ? shortDay(d.startMs) : ''}
          </span>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 5-hour window

export function WindowCard({ current, blocks, now }: { current: BlockStats | null; blocks: UsageBlock[]; now: number }) {
  return (
    <section className="u-panel u-window" aria-labelledby="u-win-h">
      <div className="u-panel__head">
        <h2 id="u-win-h" className="u-h2">
          Current 5-hour window
        </h2>
        <span className="u-est" title="Windows are reconstructed from transcript timestamps. Your plan's real limits and reset times aren't stored on disk.">
          estimated
        </span>
      </div>
      {current ? <CurrentWindow s={current} /> : <p className="u-note">No window is open. One starts with your next request and runs for five hours.</p>}
      <RecentWindows blocks={blocks} now={now} />
    </section>
  );
}

function CurrentWindow({ s }: { s: BlockStats }) {
  const b = s.block;
  return (
    <>
      <div className="u-win__track" role="progressbar" aria-label="Time through the window" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.timeFrac * 100)}>
        <span className="u-win__fill" style={{ width: `${s.timeFrac * 100}%` }} />
      </div>
      <div className="u-win__times">
        <span>Started {time(b.start_ms)}</span>
        <span>
          {formatDuration(s.remainingMs)} left, ends {time(b.end_ms)}
        </span>
      </div>
      <dl className="u-win__stats">
        <div>
          <dt>So far</dt>
          <dd>{usd(s.cost)}</dd>
          <dd className="u-sub">{tok(s.tokens)} tokens, {b.requests} requests</dd>
        </div>
        <div>
          <dt>Burn rate</dt>
          <dd>{usd(s.costPerHour)}/h</dd>
          <dd className="u-sub">{tok(s.tokensPerHour)} tokens/h</dd>
        </div>
        <div>
          <dt>At this pace, by {time(b.end_ms)}</dt>
          <dd>{usd(s.projectedCost)}</dd>
          <dd className="u-sub">{tok(s.projectedTokens)} tokens</dd>
        </div>
      </dl>
    </>
  );
}

function RecentWindows({ blocks, now }: { blocks: UsageBlock[]; now: number }) {
  const recent = blocks.slice(-14);
  const [hover, setHover] = useState<number | null>(null);
  if (!recent.length) return null;
  const max = Math.max(...recent.map((b) => costOf(b.cost)), 0);
  const shown = hover !== null ? recent[hover] : undefined;
  return (
    <div className="u-recent">
      <div className="u-recent__head">
        <span className="u-h3">Recent windows</span>
        <span className="u-sub">by API-equivalent cost</span>
      </div>
      <div className="u-recent__bars" onMouseLeave={() => setHover(null)}>
        {recent.map((b, i) => {
          const c = costOf(b.cost);
          const live = b.active && now < b.end_ms;
          return (
            <button
              key={b.start_ms}
              className={`u-recent__col${live ? ' is-live' : ''}${hover === i ? ' is-hover' : ''}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${dayLabel(b.start_ms)} ${time(b.start_ms)}: ${usd(c)}`}
            >
              <span style={{ height: `${max ? Math.max(3, (c / max) * 100) : 0}%` }} />
            </button>
          );
        })}
      </div>
      <div className="u-readout" aria-live="polite">
        {shown ? (
          <>
            {dayLabel(shown.start_ms)}, {time(shown.start_ms)} to {time(shown.end_ms)}: <strong>{usd(costOf(shown.cost))}</strong>, {tok(tokensOf(shown.usage))} tokens,{' '}
            {shown.requests} requests
          </>
        ) : (
          <span className="u-dim">Hover a bar for details. The highlighted bar is the open window.</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- heatmap

type Cell = { requests: number; tokens: number; cost: number };

export function Heatmap({ heat, max }: { heat: Cell[][]; max: number }) {
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const busiest = useMemo(() => {
    let best: { d: number; h: number; v: number } | null = null;
    heat.forEach((row, d) =>
      row.forEach((c, h) => {
        if (c.requests > (best?.v ?? 0)) best = { d, h, v: c.requests };
      }),
    );
    return best as { d: number; h: number; v: number } | null;
  }, [heat]);
  const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;
  const describe = (d: number, h: number) => {
    const c = heat[d]![h]!;
    return `${WEEKDAYS[d]} ${hourLabel(h)} to ${hourLabel((h + 1) % 24)}: ${c.requests} requests, ${usd(c.cost)}`;
  };

  return (
    <section className="u-panel u-heat" aria-labelledby="u-heat-h">
      <h2 id="u-heat-h" className="u-h2">
        When you use Claude
      </h2>
      <p className="u-note">Requests by hour of day and weekday, in your local time.</p>
      <div className="u-heat__grid" onMouseLeave={() => setHover(null)} role="grid" aria-label="Requests by weekday and hour">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="u-heat__hour" aria-hidden>
            {h % 6 === 0 ? hourLabel(h) : ''}
          </span>
        ))}
        {heat.map((row, d) => (
          <div key={d} className="u-heat__row" role="row">
            <span className="u-heat__day" role="rowheader">
              {WEEKDAYS[d]}
            </span>
            {row.map((c, h) => {
              const a = max > 0 && c.requests > 0 ? 0.12 + 0.88 * (c.requests / max) : 0;
              return (
                <span
                  key={h}
                  role="gridcell"
                  className={`u-heat__cell${hover?.d === d && hover.h === h ? ' is-hover' : ''}`}
                  style={a ? { background: `rgba(102, 204, 255, ${a.toFixed(3)})` } : undefined}
                  onMouseEnter={() => setHover({ d, h })}
                  aria-label={describe(d, h)}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="u-heat__foot">
        <span className="u-readout">
          {hover ? (
            describe(hover.d, hover.h)
          ) : busiest ? (
            <>Busiest hour: {describe(busiest.d, busiest.h)}</>
          ) : (
            <span className="u-dim">No requests in this range.</span>
          )}
        </span>
        <span className="u-heat__scale" aria-hidden>
          fewer <span className="u-heat__ramp" /> more
        </span>
      </div>
    </section>
  );
}
