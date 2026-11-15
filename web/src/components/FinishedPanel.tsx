// "Finished": every subagent whose status is `done`, newest first. The scene no longer
// draws them, so this is where their history lives. Click one to drill into its events.
import { useMemo, useState } from 'react';
import type { AgentId, AgentState, SessionState } from '../protocol';
import { MAIN_AGENT } from '../protocol';
import { useSessionEvents, useStore, type StoredEvent } from '../store';
import { formatCost, formatDuration, formatTokens } from '../format';
import { channelColor } from '../tokens';
import { ActivityRow, Expandable } from './ActivityPanel';

/** Finished subagents of a session, most recently finished first. */
export function finishedAgents(session: SessionState): AgentState[] {
  return Object.values(session.agents)
    .filter((a) => a.id !== MAIN_AGENT && a.status === 'done')
    .sort((a, b) => b.last_activity - a.last_activity);
}

interface Handoffs {
  dispatch: StoredEvent | null;
  result: StoredEvent | null;
}

/** First dispatch to, and last result from, every agent. */
function handoffs(events: StoredEvent[]): Map<AgentId, Handoffs> {
  const map = new Map<AgentId, Handoffs>();
  const get = (id: AgentId) => {
    let h = map.get(id);
    if (!h) map.set(id, (h = { dispatch: null, result: null }));
    return h;
  };
  for (const se of events) {
    const ev = se.ev;
    if (ev.type !== 'message_sent') continue;
    if (ev.channel === 'dispatch') {
      const h = get(ev.to);
      h.dispatch ??= se;
    } else if (ev.channel === 'result') {
      get(ev.from).result = se;
    }
  }
  return map;
}

const firstLine = (se: StoredEvent | null): string | null => {
  if (!se || se.ev.type !== 'message_sent') return null;
  return se.ev.text.split('\n').find((l) => l.trim())?.trim() ?? null;
};

export function FinishedPanel({ session }: { session: SessionState }) {
  const events = useSessionEvents(session.id);
  const [open, setOpen] = useState<AgentId | null>(null);
  const agents = useMemo(() => finishedAgents(session), [session]);
  const hand = useMemo(() => handoffs(events), [events]);

  const current = open ? session.agents[open] : undefined;
  if (current && current.status === 'done') {
    return (
      <AgentHistory
        agent={current}
        session={session}
        events={events}
        hand={hand.get(current.id) ?? { dispatch: null, result: null }}
        onBack={() => setOpen(null)}
      />
    );
  }

  if (!agents.length) {
    return <div className="panel-empty">No finished subagents yet.</div>;
  }

  return (
    <div className="finished">
      {agents.map((a) => {
        const h = hand.get(a.id);
        const dispatch = firstLine(h?.dispatch ?? null);
        const result = firstLine(h?.result ?? null);
        const tokens = a.usage.input + a.usage.output + a.usage.cache_read + a.usage.cache_write;
        return (
          <button key={a.id} className="fin-card" onClick={() => setOpen(a.id)}>
            <div className="fin-card__head">
              <span className="fin-card__check" aria-hidden>
                ✓
              </span>
              <span className="fin-card__name">{a.name}</span>
              {a.agent_type && <span className="fin-card__type">{a.agent_type}</span>}
              <span className="fin-card__cost mono">{formatCost(a.cost_usd)}</span>
            </div>
            <div className="fin-card__meta mono">
              <span>{a.model ?? '—'}</span>
              <span>{formatDuration(a.last_activity - a.started_at)}</span>
              <span>
                {a.tool_calls} tools
                {a.tool_errors > 0 && <span className="err"> · {a.tool_errors} err</span>}
              </span>
              <span>{formatTokens(tokens)} tok</span>
            </div>
            {dispatch && (
              <div className="fin-card__line" style={{ ['--chan' as string]: channelColor.dispatch }}>
                <span className="chan">dispatch</span> <span className="fin-card__text">{dispatch}</span>
              </div>
            )}
            {result && (
              <div className="fin-card__line" style={{ ['--chan' as string]: channelColor.result }}>
                <span className="chan">result</span> <span className="fin-card__text">{result}</span>
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

function AgentHistory({
  agent,
  session,
  events,
  hand,
  onBack,
}: {
  agent: AgentState;
  session: SessionState;
  events: StoredEvent[];
  hand: Handoffs;
  onBack: () => void;
}) {
  const focusSeq = useStore((s) => s.focusSeq);
  const rows = useMemo(
    () =>
      events.filter((se) => {
        if (se === hand.dispatch || se === hand.result) return false;
        const ev = se.ev;
        if (ev.type === 'message_sent') return ev.from === agent.id || ev.to === agent.id;
        return ev.agent === agent.id;
      }),
    [events, agent.id, hand],
  );
  const text = (se: StoredEvent | null) => (se && se.ev.type === 'message_sent' ? se.ev.text : null);
  const dispatch = text(hand.dispatch);
  const result = text(hand.result);
  const parent = agent.parent ? (session.agents[agent.parent]?.name ?? agent.parent) : null;

  return (
    <div className="fin-history">
      <div className="fin-history__bar">
        <button className="btn btn--small" onClick={onBack}>
          ← Back
        </button>
        <span className="fin-history__name">{agent.name}</span>
        <span className="muted small mono">
          {formatDuration(agent.last_activity - agent.started_at)} · {formatCost(agent.cost_usd)}
        </span>
      </div>
      <div className="activity">
        {dispatch !== null && (
          <section className="handoff" style={{ ['--chan' as string]: channelColor.dispatch }}>
            <div className="handoff__label">
              <span className="chan">dispatch</span>
              {parent && <span className="muted small"> from {parent}</span>}
            </div>
            <Expandable text={dispatch} lines={8} mono={false} />
          </section>
        )}
        {rows.map((se) => (
          <ActivityRow
            key={se.seq}
            se={se}
            agentName={session.agents[se.ev.agent]?.name ?? se.ev.agent}
            focused={se.seq === focusSeq}
          />
        ))}
        {result !== null && (
          <section className="handoff" style={{ ['--chan' as string]: channelColor.result }}>
            <div className="handoff__label">
              <span className="chan">result</span>
              {parent && <span className="muted small"> to {parent}</span>}
            </div>
            <Expandable text={result} lines={8} mono={false} />
          </section>
        )}
      </div>
    </div>
  );
}
