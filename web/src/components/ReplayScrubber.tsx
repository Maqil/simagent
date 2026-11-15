// The timeline in replay mode: transport controls, a tick track positioned on the play
// clock (idle gaps compressed when "skip idle" is on), one thin lane per agent, a draggable
// playhead and a hover preview card showing the event at that moment.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AgentId, SessionState } from '../protocol';
import { MAIN_AGENT, USER_AGENT } from '../protocol';
import { REPLAY_SPEEDS, useStore, type ReplayData, type ReplaySpeed } from '../store';
import { countAtOrBefore } from '../replay';
import { formatClock, formatOffset } from '../format';
import { channelColor, eventColor, eventGlyph, statusColor } from '../tokens';
import { describe } from './Timeline';
import { EndIcon, MessageIcon, PauseIcon, PlayIcon, RestartIcon, StepBackIcon, StepFwdIcon } from './icons';
import { keyMoments, momentColor, momentGlyph, type Moment } from '../review';

const PAD = 10;
const TRACK_H = 34;
/** Height of the chapter-marker row above the tick track. */
const MARKS_H = 16;
const LANE_GAP = 2;
const MAX_LANES_H = 48;
/** Low-signal kinds are not drawn as ticks and are skipped by the preview. */
const HIDDEN = new Set(['usage_reported', 'model_seen']);

interface Lane {
  id: AgentId;
  first: number;
  last: number;
  /** [startIdx, endIdx] pairs while a tool ran. */
  busy: [number, number][];
}

/** One lane per agent: its lifetime (first → last event) and its tool spans. */
function buildLanes(events: readonly AgentEvent[]): Lane[] {
  const lanes = new Map<AgentId, Lane>();
  const open = new Map<string, number>();
  const lane = (id: AgentId, i: number) => {
    let l = lanes.get(id);
    if (!l) lanes.set(id, (l = { id, first: i, last: i, busy: [] }));
    l.last = i;
    return l;
  };
  events.forEach((e, i) => {
    if (e.agent === USER_AGENT) return;
    const l = lane(e.agent, i);
    if (e.type === 'subagent_spawned') lane(e.child, i);
    if (e.type === 'subagent_finished') lane(e.child, i);
    if (e.type === 'tool_started') open.set(`${e.agent}\u0000${e.tool_use_id}`, i);
    if (e.type === 'tool_finished') {
      const k = `${e.agent}\u0000${e.tool_use_id}`;
      const s = open.get(k);
      if (s !== undefined) {
        l.busy.push([s, i]);
        open.delete(k);
      }
    }
  });
  const out = [...lanes.values()];
  out.sort((a, b) => (a.id === MAIN_AGENT ? -1 : b.id === MAIN_AGENT ? 1 : a.first - b.first));
  return out;
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function ReplayScrubber({ session }: { session: SessionState }) {
  const replay = useStore((s) => s.replay);
  if (!replay) return null;
  return <Scrubber replay={replay} session={session} />;
}

function Scrubber({ replay: r, session }: { replay: ReplayData; session: SessionState }) {
  const st = useStore.getState();
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = useWidth(trackRef);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const drag = useRef<{ wasPlaying: boolean } | null>(null);

  const events = r.timeline.events;
  const end = Math.max(1, r.clock[r.clock.length - 1] ?? 0);
  const span = Math.max(1, width - PAD * 2);
  const xOf = (t: number) => PAD + (t / end) * span;
  const tOf = (x: number) => Math.max(0, Math.min(end, ((x - PAD) / span) * end));

  const lanes = useMemo(() => buildLanes(events), [events]);
  // Names come from the fully folded state, so lanes are labelled before an agent spawns.
  const names = useMemo(() => r.timeline.stateAt(events.length).agents, [r.timeline, events.length]);
  const laneH = lanes.length ? Math.max(2, Math.min(6, Math.floor(MAX_LANES_H / lanes.length) - LANE_GAP)) : 0;
  const moments = useMemo(() => keyMoments(events, names), [events, names]);
  const lanesH = lanes.length * (laneH + LANE_GAP);
  const height = MARKS_H + TRACK_H + lanesH + 8;

  // Ticks and lanes are drawn once per layout change, not per playhead move.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    g.translate(0, MARKS_H);
    g.fillStyle = 'rgba(102,204,255,0.10)';
    g.fillRect(PAD, TRACK_H / 2, span, 1);
    const x = (i: number) => PAD + ((r.clock[i] ?? 0) / end) * span;
    // Regular ticks first, then message ticks on top.
    for (let pass = 0; pass < 2; pass++) {
      events.forEach((e, i) => {
        if (HIDDEN.has(e.type)) return;
        const isMsg = e.type === 'message_sent';
        if ((pass === 1) !== isMsg) return;
        if (isMsg) {
          g.fillStyle = channelColor[e.channel] ?? '#66ccff';
          g.fillRect(x(i) - 1, 2, 2, TRACK_H - 4);
        } else {
          g.globalAlpha = 0.7;
          g.fillStyle = eventColor(e);
          const h = e.type === 'error' || e.type === 'permission_requested' ? 14 : 8;
          g.fillRect(x(i) - 0.5, TRACK_H / 2 - h / 2, 1, h);
          g.globalAlpha = 1;
        }
      });
    }
    lanes.forEach((l, k) => {
      const y = TRACK_H + 3 + k * (laneH + LANE_GAP);
      const col = l.id === MAIN_AGENT ? statusColor.thinking : '#cc88ff';
      g.globalAlpha = 0.28;
      g.fillStyle = col;
      g.fillRect(x(l.first), y, Math.max(2, x(l.last) - x(l.first)), laneH);
      g.globalAlpha = 0.95;
      g.fillStyle = statusColor.tool;
      for (const [a, b] of l.busy) g.fillRect(x(a), y, Math.max(1.5, x(b) - x(a)), laneH);
      g.globalAlpha = 1;
    });
  }, [events, r.clock, end, width, height, span, lanes, laneH]);

  // Preview: nearest visible event to the hovered time.
  const preview = useMemo(() => {
    if (hoverX === null || !events.length) return null;
    const t = tOf(hoverX);
    let i = Math.max(0, countAtOrBefore(r.clock, t) - 1);
    const next = i + 1 < events.length && Math.abs((r.clock[i + 1] ?? 0) - t) < Math.abs((r.clock[i] ?? 0) - t);
    if (next) i += 1;
    // Step over hidden kinds to the closest meaningful event.
    for (let d = 0; d < 40; d++) {
      const a = events[i + d];
      if (a && !HIDDEN.has(a.type)) return { i: i + d, ev: a };
      const b = events[i - d];
      if (b && !HIDDEN.has(b.type)) return { i: i - d, ev: b };
    }
    return { i, ev: events[i]! };
  }, [hoverX, events, r.clock, end, span]);

  const seekX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    st.replaySeekTime(tOf(clientX - el.getBoundingClientRect().left));
  };
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { wasPlaying: r.playing };
    if (r.playing) st.replaySetPlaying(false);
    seekX(e.clientX);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = trackRef.current;
    if (el) setHoverX(e.clientX - el.getBoundingClientRect().left);
    if (drag.current) seekX(e.clientX);
  };
  const onUp = () => {
    if (!drag.current) return;
    if (drag.current.wasPlaying) useStore.getState().replaySetPlaying(true);
    drag.current = null;
  };

  const head = xOf(r.playT);
  const current = r.cursor > 0 ? events[r.cursor - 1] : undefined;
  const t0 = events[0]?.at ?? session.started_at;
  const atWall = current?.at ?? t0;

  return (
    <div className="scrub">
      <div className="scrub__controls">
        <div className="player" role="group" aria-label="Playback">
          <button className="pbtn" onClick={() => st.replaySeek(0)} title="Back to start (Home)" aria-label="Back to start">
            <RestartIcon />
          </button>
          <button className="pbtn" onClick={() => st.replayJumpMessage(-1)} title="Previous message (Shift+←)" aria-label="Previous message">
            <MessageIcon dir={-1} />
          </button>
          <button className="pbtn" onClick={() => st.replayStep(-1)} title="Previous event (←)" aria-label="Previous event">
            <StepBackIcon />
          </button>
          <button
            className={`pbtn pbtn--play${r.playing ? ' pbtn--playing' : ''}`}
            onClick={() => {
              // At the end, Play starts over instead of doing nothing.
              if (!r.playing && r.cursor >= events.length) st.replaySeek(0);
              st.replaySetPlaying(!r.playing);
            }}
            title={r.playing ? 'Pause (Space)' : 'Play (Space)'}
            aria-label={r.playing ? 'Pause' : 'Play'}
          >
            {r.playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
          </button>
          <button className="pbtn" onClick={() => st.replayStep(1)} title="Next event (→)" aria-label="Next event">
            <StepFwdIcon />
          </button>
          <button className="pbtn" onClick={() => st.replayJumpMessage(1)} title="Next message (Shift+→)" aria-label="Next message">
            <MessageIcon dir={1} />
          </button>
          <button className="pbtn" onClick={() => st.replaySeek(events.length)} title="Jump to end (End)" aria-label="Jump to end">
            <EndIcon />
          </button>
        </div>
        <span className="scrub__time mono" title={formatClock(atWall)}>
          {formatOffset(atWall - t0)}
          <span className="muted"> / {formatOffset((events[events.length - 1]?.at ?? t0) - t0)}</span>
        </span>
        <div className="speeds" role="radiogroup" aria-label="Playback speed">
          {REPLAY_SPEEDS.map((sp) => (
            <button
              key={sp}
              role="radio"
              aria-checked={r.speed === sp}
              className={`speed${r.speed === sp ? ' speed--on' : ''}`}
              onClick={() => st.replaySetSpeed(sp as ReplaySpeed)}
            >
              {sp}×
            </button>
          ))}
        </div>
        <label className="scrub__skip" title="Compress idle gaps longer than 3s to 0.5s">
          <input type="checkbox" checked={r.skipIdle} onChange={(e) => st.replaySetSkipIdle(e.target.checked)} />
          skip idle
        </label>
        <span className="scrub__pos mono muted">
          event {r.cursor}/{events.length}
        </span>
      </div>
      <div
        className="scrub__track"
        ref={trackRef}
        style={{ height }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setHoverX(null)}
        role="slider"
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={events.length}
        aria-valuenow={r.cursor}
        tabIndex={0}
      >
        <canvas ref={canvasRef} className="scrub__canvas" style={{ width, height }} />
        <div className="scrub__marks" style={{ height: MARKS_H }}>
          {moments
            .filter((m) => m.kind !== 'turn_end' && m.kind !== 'finish')
            .map((m: Moment) => (
              <span
                key={m.index}
                className="mark"
                style={{ left: xOf(r.clock[m.index] ?? 0), ['--mark' as string]: momentColor[m.kind] }}
                title={`${m.title}${m.detail ? ` — ${m.detail}` : ''}`}
              >
                {momentGlyph[m.kind]}
              </span>
            ))}
        </div>
        <div className="scrub__played" style={{ width: Math.max(0, head - PAD), left: PAD, top: MARKS_H + TRACK_H / 2 - 1 }} />
        <div className="scrub__head" style={{ left: head }}>
          <span className="scrub__knob" style={{ top: MARKS_H + TRACK_H / 2 - 7 }} />
        </div>
        {hoverX !== null && <div className="scrub__ghost" style={{ left: hoverX }} />}
        {preview && hoverX !== null && (
          <PreviewCard
            ev={preview.ev}
            index={preview.i}
            names={names}
            t0={t0}
            left={Math.min(Math.max(hoverX, 150), width - 150)}
          />
        )}
      </div>
    </div>
  );
}

function PreviewCard({
  ev,
  index,
  names,
  t0,
  left,
}: {
  ev: AgentEvent;
  index: number;
  names: SessionState['agents'];
  t0: number;
  left: number;
}) {
  const name = (id: AgentId) => (id === USER_AGENT ? 'You' : (names[id]?.name ?? id));
  const c = eventColor(ev);
  const text =
    ev.type === 'message_sent'
      ? ev.text
      : ev.type === 'assistant_text' || ev.type === 'user_prompt' || ev.type === 'thinking'
        ? ev.text
        : describe({ seq: index, ev });
  return (
    <div className="preview" style={{ left, ['--kind' as string]: c }}>
      <div className="preview__head">
        <span className="preview__glyph" style={{ color: c }}>
          {eventGlyph(ev)}
        </span>
        <span className="preview__kind">{ev.type === 'message_sent' ? ev.channel : ev.type.replace(/_/g, ' ')}</span>
        <span className="preview__agent">
          {ev.type === 'message_sent' ? `${name(ev.from)} → ${name(ev.to)}` : name(ev.agent)}
        </span>
        <span className="preview__time mono">
          {formatOffset(ev.at - t0)} · {formatClock(ev.at)}
        </span>
      </div>
      {text && <div className="preview__text">{text.slice(0, 280)}</div>}
      <div className="preview__foot muted">event {index + 1} · click to seek</div>
    </div>
  );
}
