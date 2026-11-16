// Usage page tables: per model, and per project with expandable sessions.
import { Fragment, useMemo, useState } from 'react';
import { formatAgo } from '../format';
import { cacheHitRate, costOf, share, sortProjects, tokensOf, type ModelRow, type ProjectRow, type SessionRow, type SortKey } from '../usage';
import { Swatch, pct, tok, usd } from './UsageCharts';

export function ModelTable({ models }: { models: ModelRow[] }) {
  const total = models.reduce((a, m) => a + costOf(m.totals.cost), 0);
  return (
    <section className="u-panel" aria-labelledby="u-models-h">
      <h2 id="u-models-h" className="u-h2">
        By model
      </h2>
      <div className="u-scroll">
        <table className="u-table">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" className="num">Requests</th>
              <th scope="col" className="num">Input</th>
              <th scope="col" className="num">Output</th>
              <th scope="col" className="num">Cache read</th>
              <th scope="col" className="num">Cache write</th>
              <th scope="col" className="num">Cost</th>
              <th scope="col" className="u-share-col">Share of cost</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => {
              const c = costOf(m.totals.cost);
              const s = share(c, total);
              return (
                <tr key={m.model}>
                  <th scope="row" title={m.model}>
                    <Swatch kind={m.family} />
                    {m.label}
                  </th>
                  <td className="num">{m.totals.requests.toLocaleString()}</td>
                  <td className="num">{tok(m.totals.input)}</td>
                  <td className="num">{tok(m.totals.output)}</td>
                  <td className="num">{tok(m.totals.cache_read)}</td>
                  <td className="num">{tok(m.totals.cache_write)}</td>
                  <td className="num">{usd(c)}</td>
                  <td className="u-share-col">
                    <span className="u-meter" aria-hidden>
                      <span className={`u-c-${m.family}`} style={{ width: `${s * 100}%` }} />
                    </span>
                    <span className="num">{pct(s)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Cells({ r, now }: { r: { totals: ProjectRow['totals']; sub: ProjectRow['sub']; lastActivity: number }; now: number }) {
  const c = costOf(r.totals.cost);
  return (
    <>
      <td className="num">{usd(c)}</td>
      <td className="num">{tok(tokensOf(r.totals))}</td>
      <td className="num">{pct(cacheHitRate(r.totals))}</td>
      <td className="num">{pct(share(costOf(r.sub.cost), c))}</td>
      <td className="num u-dim">{formatAgo(r.lastActivity, now)}</td>
    </>
  );
}

export function ProjectTable({ projects, now, onOpen }: { projects: ProjectRow[]; now: number; onOpen: (s: SessionRow) => void }) {
  const [sort, setSort] = useState<SortKey>('cost');
  const sorted = useMemo(() => sortProjects(projects, sort), [projects, sort]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // The top project starts expanded until the user toggles something.
  const isOpen = (key: string, i: number) => open[key] ?? (Object.keys(open).length === 0 && i === 0);
  const toggle = (key: string, i: number) => setOpen((o) => ({ ...o, [key]: !isOpen(key, i) }));

  const head = (key: SortKey | null, label: string, title?: string) => (
    <th scope="col" className="num" aria-sort={key && sort === key ? 'descending' : undefined} title={title}>
      {key ? (
        <button className={`u-sort${sort === key ? ' is-on' : ''}`} onClick={() => setSort(key)}>
          {label}
          <span aria-hidden>{sort === key ? ' ▾' : ''}</span>
        </button>
      ) : (
        label
      )}
    </th>
  );

  return (
    <section className="u-panel" aria-labelledby="u-proj-h">
      <div className="u-panel__head">
        <h2 id="u-proj-h" className="u-h2">
          By project and session
        </h2>
        <span className="u-sub">Click a session to replay it.</span>
      </div>
      <div className="u-scroll">
        <table className="u-table u-proj">
          <thead>
            <tr>
              <th scope="col">Project / session</th>
              {head('cost', 'Cost')}
              {head('tokens', 'Tokens')}
              {head(null, 'Cache hit', 'Cache reads as a share of all prompt tokens')}
              {head(null, 'Subagents', 'Share of cost spent by subagents')}
              {head('last', 'Last active')}
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => {
              const expanded = isOpen(p.key, i);
              return (
                <Fragment key={p.key}>
                  <tr className="u-proj__row">
                    <th scope="row">
                      <button className="u-proj__toggle" aria-expanded={expanded} onClick={() => toggle(p.key, i)} title={p.cwd ?? p.key}>
                        <span className={`u-chev${expanded ? ' is-open' : ''}`} aria-hidden>
                          ▸
                        </span>
                        <span className="u-proj__name">{p.name}</span>
                        <span className="u-sub">
                          {p.sessions.length} session{p.sessions.length === 1 ? '' : 's'}
                        </span>
                      </button>
                    </th>
                    <Cells r={p} now={now} />
                  </tr>
                  {expanded &&
                    p.sessions.map((s) => (
                      <tr key={s.id} className="u-sess">
                        <th scope="row">
                          <button className="u-sess__btn" onClick={() => onOpen(s)} title={`Replay ${s.label}\n${s.id}`}>
                            {s.live && <span className="live-badge">live</span>}
                            <span className="u-sess__title">{s.label}</span>
                          </button>
                        </th>
                        <Cells r={s} now={now} />
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
