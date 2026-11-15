import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionState } from '../protocol';
import { PlayIcon } from './icons';
import { useStore, type StoredEvent } from '../store';
import { formatClock } from '../format';
import { eventColor } from '../tokens';
import { ReplayScrubber } from './ReplayScrubber';

const EMPTY: StoredEvent[] = [];
/** One tick per this many pixels at most; denser events collapse into the bin. */
const BIN_PX = 3;
/** Low-signal kinds are not drawn as ticks. */
const HIDDEN = new Set(['usage_reported', 'model_seen']);

interface Bin {
  x: number;
  first: StoredEvent;
  count: number;
  color: string;
}

export function Timeline({ session }: { session: SessionState }) {
  const replaying = useStore((s) => s.replay !== null && s.replay.id === session.id);
  return replaying ? <ReplayScrubber session={session} /> : <LiveTimeline session={session} />;
}

function LiveTimeline({ session }: { session: SessionState }) {
  const events = useStore((s) => s.events[session.id] ?? EMPTY);
  const focusEvent = useStore((s) => s.focusEvent);
  const focusSeq = useStore((s) => s.focusSeq);
  const openReplay = useStore((s) => s.openReplay);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<Bin | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const visible = useMemo(() => events.filter((e) => !HIDDEN.has(e.ev.type)), [events]);
  const t0 = visible[0]?.ev.at ?? session.started_at;
  const t1 = Math.max(visible.at(-1)?.ev.at ?? session.last_activity, t0 + 1000);

  const bins = useMemo(() => {
    const pad = 8;
    const span = Math.max(1, width - pad * 2);
    const map = new Map<number, Bin>();
    for (const se of visible) {
      const x = pad + ((se.ev.at - t0) / (t1 - t0)) * span;
      const key = Math.round(x / BIN_PX);
      const b = map.get(key);
      if (b) {
        b.count += 1;
        // Errors and permission requests win the bin color.
        const c = eventColor(se.ev);
        if (se.ev.type === 'error' || se.ev.type === 'permission_requested' || (se.ev.type === 'tool_finished' && se.ev.is_error)) b.color = c;
      } else {
        map.set(key, { x: key * BIN_PX, first: se, count: 1, color: eventColor(se.ev) });
      }
    }
    return [...map.values()];
  }, [visible, width, t0, t1]);

  const replayButton = (
    <button
      className="timeline__replay"
      onClick={() => void openReplay(session.id, { title: session.title, autoplay: true })}
      disabled={!visible.length}
      title="Replay this session from the start"
      aria-label="Replay this session"
    >
      <span className="timeline__play" aria-hidden>
        <PlayIcon size={13} />
      </span>
      Replay
    </button>
  );

  if (!visible.length)
    return (
      <div className="timeline-bar">
        {replayButton}
        <div className="timeline timeline--empty" ref={ref} />
      </div>
    );

  return (
    <div className="timeline-bar">
    {replayButton}
    <div className="timeline" ref={ref} onMouseLeave={() => setHover(null)}>
      <span className="timeline__label timeline__label--l">{formatClock(t0)}</span>
      <span className="timeline__label timeline__label--r">{formatClock(t1)}</span>
      {bins.map((b) => (
        <button
          key={b.x}
          className={`tick${b.first.seq === focusSeq ? ' tick--focused' : ''}`}
          style={{ left: b.x, background: b.color, height: Math.min(26, 10 + b.count * 2) }}
          onMouseEnter={() => setHover(b)}
          onClick={() => focusEvent(b.first.seq)}
          aria-label={`${b.first.ev.type} at ${formatClock(b.first.ev.at)}`}
        />
      ))}
      {hover && (
        <div className="timeline__tip" style={{ left: Math.min(Math.max(hover.x, 80), width - 80) }}>
          <span className="mono">{formatClock(hover.first.ev.at)}</span>{' '}
          {session.agents[hover.first.ev.agent]?.name ?? hover.first.ev.agent} · {describe(hover.first)}
          {hover.count > 1 && <span className="muted"> (+{hover.count - 1})</span>}
        </div>
      )}
    </div>
    </div>
  );
}

export function describe(se: StoredEvent): string {
  const ev = se.ev;
  switch (ev.type) {
    case 'tool_started':
      return `${ev.name} ${ev.summary}`.slice(0, 80);
    case 'tool_finished':
      return ev.is_error ? 'tool error' : 'tool ok';
    case 'permission_requested':
      return `permission: ${ev.tool_name}`;
    case 'user_prompt':
    case 'assistant_text':
    case 'thinking':
      return ev.text.replace(/\s+/g, ' ').slice(0, 80);
    case 'message_sent':
      return `${ev.channel}: ${ev.text.replace(/\s+/g, ' ').slice(0, 70)}`;
    case 'subagent_spawned':
      return `spawned ${ev.description ?? ev.agent_type ?? ev.child}`;
    case 'notification':
    case 'error':
      return ev.message.replace(/\s+/g, ' ').slice(0, 80);
    default:
      return ev.type.replace(/_/g, ' ');
  }
}
