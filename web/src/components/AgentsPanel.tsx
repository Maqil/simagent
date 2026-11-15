import type { AgentId, AgentState, SessionState } from '../protocol';
import { MAIN_AGENT } from '../protocol';
import { useStore } from '../store';
import { formatCost, formatDuration, formatTokens } from '../format';
import { statusColor, statusLabel } from '../tokens';

interface Props {
  session: SessionState;
}

export function AgentsPanel({ session }: Props) {
  const selected = useStore((s) => s.selectedAgent);
  const selectAgent = useStore((s) => s.selectAgent);
  const setPanelTab = useStore((s) => s.setPanelTab);
  const agents = Object.values(session.agents);
  const byParent = new Map<AgentId | null, AgentState[]>();
  for (const a of agents) {
    const p = a.parent && session.agents[a.parent] ? a.parent : null;
    let list = byParent.get(p);
    if (!list) byParent.set(p, (list = []));
    list.push(a);
  }
  for (const list of byParent.values()) list.sort((x, y) => x.started_at - y.started_at);

  const seen = new Set<AgentId>();
  const renderNode = (a: AgentState, depth: number) => {
    if (seen.has(a.id)) return null;
    seen.add(a.id);
    const kids = byParent.get(a.id) ?? [];
    return (
      <li key={a.id}>
        <AgentCard
          agent={a}
          depth={depth}
          selected={a.id === selected}
          onSelect={() => selectAgent(a.id === selected ? null : a.id)}
        />
        {kids.length > 0 && <ul className="tree">{kids.map((k) => renderNode(k, depth + 1))}</ul>}
      </li>
    );
  };

  const done = agents.filter((a) => a.status === 'done' && a.id !== MAIN_AGENT).sort((x, y) => y.last_activity - x.last_activity);
  const doneIds = new Set(done.map((a) => a.id));
  // Finished subagents are listed apart; their still-running children re-root under the tree.
  for (const id of doneIds) seen.add(id);
  const roots = [
    ...(byParent.get(null) ?? []),
    ...done.flatMap((d) => (byParent.get(d.id) ?? []).filter((k) => !doneIds.has(k.id))),
  ];
  const active = agents.length - done.length;

  return (
    <div className="agents">
      <div className="agents__summary">
        <span>
          {active} active · {done.length} finished
        </span>
        <span>{formatCost(session.cost_usd)}</span>
        <span>{session.event_count} events</span>
      </div>
      <h3 className="agents__section">Active</h3>
      <ul className="tree tree--root">{roots.map((a) => renderNode(a, 0))}</ul>
      {done.length > 0 && (
        <>
          <h3 className="agents__section agents__section--done">
            Finished <span className="muted">({done.length})</span>
            <button className="link small" onClick={() => setPanelTab('finished')}>
              history →
            </button>
          </h3>
          <ul className="tree tree--root tree--done">
            {done.map((a) => (
              <li key={a.id}>
                <AgentCard
                  agent={a}
                  depth={0}
                  selected={a.id === selected}
                  onSelect={() => selectAgent(a.id === selected ? null : a.id)}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function AgentCard({
  agent: a,
  selected,
  onSelect,
}: {
  agent: AgentState;
  depth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const frac = a.context_window > 0 ? Math.min(1, a.context_tokens / a.context_window) : 0;
  return (
    <div className={`agent-card${selected ? ' agent-card--selected' : ''}`}>
      <button className="agent-card__head" onClick={onSelect}>
        <span className="dot" style={{ background: statusColor[a.status] }} />
        <span className="agent-card__name">{a.name}</span>
        <span className="agent-card__status" style={{ color: statusColor[a.status] }}>
          {statusLabel[a.status]}
        </span>
      </button>
      <div className="ctxbar" title={`context ${formatTokens(a.context_tokens)} / ${formatTokens(a.context_window)}`}>
        <div className="ctxbar__fill" style={{ width: `${frac * 100}%` }} />
      </div>
      <dl className="kv">
        <dt>model</dt>
        <dd className="mono">{a.model ?? '—'}</dd>
        {a.agent_type && (
          <>
            <dt>type</dt>
            <dd>{a.agent_type}</dd>
          </>
        )}
        <dt>context</dt>
        <dd className="mono">
          {formatTokens(a.context_tokens)} / {formatTokens(a.context_window)}
        </dd>
        <dt>tokens</dt>
        <dd className="mono">
          in {formatTokens(a.usage.input)} · out {formatTokens(a.usage.output)} · cache{' '}
          {formatTokens(a.usage.cache_read + a.usage.cache_write)}
        </dd>
        <dt>cost</dt>
        <dd className="mono">{formatCost(a.cost_usd)}</dd>
        <dt>tools</dt>
        <dd className="mono">
          {a.tool_calls} calls
          {a.tool_errors > 0 && <span className="err"> · {a.tool_errors} errors</span>}
        </dd>
        <dt>age</dt>
        <dd className="mono">{formatDuration(a.last_activity - a.started_at)}</dd>
      </dl>
      {selected && a.active_tools.length > 0 && (
        <ul className="active-tools">
          {a.active_tools.map((t) => (
            <li key={t.tool_use_id} className="mono">
              <b>{t.name}</b> {t.summary}
            </li>
          ))}
        </ul>
      )}
      {selected && <div className="mono muted small">id {a.id}</div>}
    </div>
  );
}
