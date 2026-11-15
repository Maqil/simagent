// Review tab: a session summary plus every key moment (prompts, subagents, results,
// approvals, errors, compaction) as a clickable list. In replay it seeks; live it starts
// a replay of the session at that moment.
import { useMemo, useRef, useState } from 'react';
import { JumpToEnd, useStickToBottom } from './JumpToEnd';
import type { AgentEvent, SessionState } from '../protocol';
import { useStore } from '../store';
import { keyMoments, momentColor, momentGlyph, type Moment, type MomentKind } from '../review';
import { formatCost, formatDuration, formatOffset, formatTokens } from '../format';
import { PlayIcon } from './icons';

const FILTERS: { id: 'all' | MomentKind[]; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: ['prompt', 'result'], label: 'Conversation' },
  { id: ['spawn', 'finish', 'result'], label: 'Agents' },
  { id: ['permission'], label: 'Approvals' },
  { id: ['error', 'tool_error'], label: 'Problems' },
];

export function ReviewPanel({ session }: { session: SessionState }) {
  const replay = useStore((s) => (s.replay && s.replay.id === session.id ? s.replay : null));
  const liveEvents = useStore((s) => s.events[session.id]);
  const openReplay = useStore((s) => s.openReplay);
  const startReplay = useStore((s) => s.startReplay);
  const [filter, setFilter] = useState(0);

  // Review always covers the whole session, even when the playhead is earlier.
  const events: readonly AgentEvent[] = useMemo(
    () => (replay ? replay.timeline.events : (liveEvents ?? []).map((se) => se.ev)),
    [replay, liveEvents],
  );
  const full = useMemo(() => (replay ? replay.timeline.stateAt(events.length) : session), [replay, events.length, session]);
  const moments = useMemo(() => keyMoments(events, full.agents), [events, full.agents]);
  const f = FILTERS[filter]!.id;
  const shown = f === 'all' ? moments : moments.filter((m) => f.includes(m.kind));
  const t0 = events[0]?.at ?? session.started_at;
  const tEnd = events[events.length - 1]?.at ?? session.last_activity;

  const stats = useMemo(() => {
    let tools = 0;
    let errors = 0;
    let prompts = 0;
    let approvals = 0;
    for (const e of events) {
      if (e.type === 'tool_started') tools++;
      else if (e.type === 'tool_finished' && e.is_error) errors++;
      else if (e.type === 'message_sent' && e.channel === 'prompt') prompts++;
      else if (e.type === 'permission_requested') approvals++;
    }
    const usage = Object.values(full.agents).reduce((n, a) => n + a.usage.input + a.usage.output + a.usage.cache_read + a.usage.cache_write, 0);
    return { tools, errors, prompts, approvals, usage, agents: Object.keys(full.agents).length - 1 };
  }, [events, full]);

  const jump = (m: Moment) => {
    const st = useStore.getState();
    if (replay) {
      st.replaySetPlaying(false);
      st.replaySeek(m.index + 1);
      return;
    }
    // Live: open a replay of this session paused at the moment.
    const list = (liveEvents ?? []).map((se) => se.ev);
    const seek = () => {
      const r = useStore.getState();
      r.replaySeek(m.index + 1);
      r.setPanelTab('review');
    };
    if (list.length) {
      startReplay(session.id, list, { title: session.title, autoplay: false });
      seek();
    } else {
      void openReplay(session.id, { title: session.title, autoplay: false }).then(seek);
    }
  };

  const cursor = replay?.cursor ?? Infinity;
  const list = useRef<HTMLOListElement>(null);
  // Live: follow new moments. Replay: the list is fixed, so only the button helps.
  const stick = useStickToBottom(list, shown.length, `${session.id}:${filter}`, false);

  return (
    <div className="review">
      <div className="review__summary">
        <div className="review__row">
          <span className="review__stat"><b>{formatDuration(Math.max(0, tEnd - t0))}</b> long</span>
          <span className="review__stat"><b>{formatCost(full.cost_usd)}</b></span>
          <span className="review__stat"><b>{formatTokens(stats.usage)}</b> tokens</span>
        </div>
        <div className="review__row muted small">
          {stats.prompts} prompt{stats.prompts === 1 ? '' : 's'} · {stats.agents} subagent{stats.agents === 1 ? '' : 's'} ·{' '}
          {stats.tools} tool calls · {stats.errors} failed · {stats.approvals} approval{stats.approvals === 1 ? '' : 's'}
        </div>
        {!replay && (
          <button
            className="btn btn--small review__replay"
            onClick={() => void openReplay(session.id, { title: session.title, autoplay: true })}
            disabled={!events.length}
          >
            <PlayIcon size={12} /> Replay from start
          </button>
        )}
      </div>
      <div className="review__filters" role="group" aria-label="Filter moments">
        {FILTERS.map((x, i) => (
          <button key={x.label} className={`fchip${filter === i ? ' fchip--on' : ''}`} onClick={() => setFilter(i)}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="scroll-host">
      <ol className="moments" ref={list} onScroll={stick.onScroll}>
        {shown.length === 0 && <li className="panel-empty">No moments here yet.</li>}
        {shown.map((m) => {
          const past = m.index < cursor;
          const here = replay && m.index === cursor - 1;
          return (
            <li key={m.index}>
              <button
                className={`moment${past ? '' : ' moment--future'}${here ? ' moment--here' : ''}`}
                style={{ ['--mark' as string]: momentColor[m.kind] }}
                onClick={() => jump(m)}
                title="Jump here"
              >
                <span className="moment__glyph">{momentGlyph[m.kind]}</span>
                <span className="moment__body">
                  <span className="moment__title">{m.title}</span>
                  {m.detail && <span className="moment__detail">{m.detail}</span>}
                </span>
                <span className="moment__time mono">{formatOffset(m.at - t0)}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <JumpToEnd stick={stick} />
      </div>
    </div>
  );
}
