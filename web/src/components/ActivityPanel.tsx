import { Markdown } from './Markdown';
import { memo, useEffect, useRef, useState } from 'react';
import { JumpToEnd, useStickToBottom } from './JumpToEnd';
import type { AgentEvent, SessionState } from '../protocol';
import { useSessionEvents, useStore, type StoredEvent } from '../store';
import { formatClock, formatDuration, formatTokens, prettyJson } from '../format';
import { channelColor, eventColor, eventGlyph } from '../tokens';

/** Rows rendered at most; older events stay in the store for the timeline. */
export const MAX_ROWS = 2000;
const PREVIEW_LINES = 3;

interface Props {
  session: SessionState;
}

export function ActivityPanel({ session }: Props) {
  const all = useSessionEvents(session.id);
  const focusSeq = useStore((s) => s.focusSeq);
  const replaying = useStore((s) => s.replay !== null);
  const rows = all.length > MAX_ROWS ? all.slice(all.length - MAX_ROWS) : all;
  const scroller = useRef<HTMLDivElement>(null);
  // Stick to the bottom when new rows arrive, unless the user scrolled up. In replay the
  // list follows the playhead, so it always sticks.
  const stick = useStickToBottom(scroller, all.length, session.id, replaying);
  const { onScroll, atBottom } = stick;

  useEffect(() => {
    if (focusSeq === null) return;
    const row = scroller.current?.querySelector<HTMLElement>(`[data-seq="${focusSeq}"]`);
    if (row) {
      atBottom.current = false;
      row.scrollIntoView({ block: 'center' });
    }
  }, [focusSeq]);

  if (!rows.length) {
    return (
      <div className="panel-empty">
        {replaying ? 'Press play (Space) to start the replay.' : 'No events yet for this session.'}
      </div>
    );
  }

  return (
    <div className="scroll-host">
    <div className="activity" ref={scroller} onScroll={onScroll}>
      {all.length > MAX_ROWS && (
        <div className="activity__cap">Showing the last {MAX_ROWS} of {all.length} events</div>
      )}
      {rows.map((se) => (
        <ActivityRow
          key={se.seq}
          se={se}
          agentName={session.agents[se.ev.agent]?.name ?? se.ev.agent}
          focused={se.seq === focusSeq}
        />
      ))}
    </div>
    <JumpToEnd stick={stick} />
    </div>
  );
}

export const ActivityRow = memo(function ActivityRow({
  se,
  agentName,
  focused,
}: {
  se: StoredEvent;
  agentName: string;
  focused: boolean;
}) {
  const ev = se.ev;
  const c = eventColor(ev);
  return (
    <div
      className={`row row--${ev.type}${focused ? ' row--focused' : ''}`}
      data-seq={se.seq}
      style={{ ['--kind' as string]: c }}
    >
      <span className="row__time">{formatClock(ev.at)}</span>
      <span className="row__glyph" style={{ color: c }} aria-hidden>
        {eventGlyph(ev)}
      </span>
      <span className="row__agent" title={ev.agent}>
        {agentName}
      </span>
      <div className="row__body">
        <RowBody ev={ev} />
      </div>
    </div>
  );
});

export function Expandable({ text, lines = PREVIEW_LINES, mono = true }: { text: string; lines?: number; mono?: boolean }) {
  const [open, setOpen] = useState(false);
  const all = text.split('\n');
  const long = all.length > lines || text.length > 400;
  const shown = open || !long ? text : all.slice(0, lines).join('\n').slice(0, 400);
  return (
    <div className="expandable">
      <pre className={mono ? 'pre mono' : 'pre prose'}>{shown}</pre>
      {long && (
        <button className="link" onClick={() => setOpen((o) => !o)}>
          {open ? 'show less' : `show all (${all.length} lines)`}
        </button>
      )}
    </div>
  );
}

function Collapsed({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return <span className="muted">{label} (redacted)</span>;
  return (
    <div>
      <button className="link" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <pre className="pre prose dim">{text}</pre>}
    </div>
  );
}

export function RowBody({ ev }: { ev: AgentEvent }) {
  switch (ev.type) {
    case 'user_prompt':
      return <Markdown text={ev.text} className="md--bright" />;
    case 'assistant_text':
      return <Markdown text={ev.text} />;
    case 'thinking':
      return <Collapsed label="thinking" text={ev.text} />;
    case 'tool_started':
      return (
        <ToolStarted name={ev.name} summary={ev.summary} input={prettyJson(ev.input)} />
      );
    case 'tool_finished':
      return (
        <div>
          <span className={ev.is_error ? 'err' : 'ok'}>{ev.is_error ? 'error' : 'ok'}</span>
          {ev.duration_ms !== null && <span className="muted"> · {formatDuration(ev.duration_ms)}</span>}
          {ev.output && <Expandable text={ev.output} />}
        </div>
      );
    case 'session_started':
      return (
        <span className="muted">
          session started{ev.cwd ? ` in ${ev.cwd}` : ''}
          {ev.git_branch ? ` (${ev.git_branch})` : ''}
          {ev.version ? ` · Claude Code ${ev.version}` : ''}
        </span>
      );
    case 'title':
      return <span>title: <b>{ev.title}</b></span>;
    case 'model_seen':
      return <span className="muted">model {ev.model}</span>;
    case 'usage_reported': {
      const u = ev.usage;
      return (
        <span className="muted">
          usage {ev.model}: in {formatTokens(u.input)} · out {formatTokens(u.output)} · cache r{' '}
          {formatTokens(u.cache_read)} / w {formatTokens(u.cache_write)}
        </span>
      );
    }
    case 'subagent_spawned':
      return (
        <span>
          spawned <b>{ev.description ?? ev.agent_type ?? ev.child}</b>
          {ev.agent_type && <span className="muted"> ({ev.agent_type})</span>}
        </span>
      );
    case 'subagent_finished':
      return <span>subagent <code>{ev.child}</code> finished</span>;
    case 'permission_requested':
      return (
        <div>
          <span className="warn">permission requested: {ev.tool_name}</span>
          <Expandable text={prettyJson(ev.input)} />
        </div>
      );
    case 'permission_resolved': {
      const r = ev.resolution;
      if (r.outcome === 'fell_back') return <span className="muted">permission fell back to the terminal</span>;
      return r.decision.behavior === 'allow' ? (
        <span className="ok">allowed{r.decision.updated_input !== undefined ? ' (edited input)' : ''}</span>
      ) : (
        <span className="err">denied: {r.decision.message}</span>
      );
    }
    case 'compacted':
      return (
        <span>
          context compacted{ev.trigger ? ` (${ev.trigger})` : ''}
          {ev.pre_tokens !== null ? ` · was ${formatTokens(ev.pre_tokens)} tokens` : ''}
        </span>
      );
    case 'turn_ended':
      return (
        <span className="muted">
          turn ended{ev.duration_ms !== null ? ` · ${formatDuration(ev.duration_ms)}` : ''}
        </span>
      );
    case 'notification':
      return <pre className="pre prose">{ev.message}</pre>;
    case 'error':
      return <pre className="pre prose err">{ev.message}</pre>;
    case 'message_sent':
      return (
        <div>
          <span className="msg-route">
            <span className="chan" style={{ ['--chan' as string]: channelColor[ev.channel] }}>
              {ev.channel}
            </span>{' '}
            <span className="mono dim">
              {ev.from} → {ev.to}
            </span>
          </span>
          <Expandable text={ev.text} mono={false} />
        </div>
      );
    default: {
      const unknown = ev as { type?: string };
      return <span className="muted">{String(unknown.type ?? 'event')}</span>;
    }
  }
}

function ToolStarted({ name, summary, input }: { name: string; summary: string; input: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="link tool-head" onClick={() => setOpen((o) => !o)} title="Show input">
        <b>{name}</b> <span className="mono dim">{summary}</span>
      </button>
      {open && <pre className="pre mono dim">{input}</pre>}
    </div>
  );
}
