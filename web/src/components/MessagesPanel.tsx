// "Messages": the session as a conversation. Every `message_sent` (human prompts, dispatches,
// results, SendMessage, notifications) plus the main agent's visible replies, as chat bubbles.
import { Markdown } from './Markdown';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentId, MessageChannel, SessionState } from '../protocol';
import { MAIN_AGENT, USER_AGENT } from '../protocol';
import { useSessionEvents, useStore, type StoredEvent } from '../store';
import { formatClock, formatOffset } from '../format';
import { channelColor, color } from '../tokens';
import { Composer } from './Composer';
import { JumpToEnd, useStickToBottom } from './JumpToEnd';

/** Lines shown before a long bubble collapses. */
const COLLAPSED_LINES = 8;

export function participantName(session: SessionState, id: AgentId): string {
  if (id === USER_AGENT) return 'You';
  return session.agents[id]?.name ?? id;
}

interface Bubble {
  se: StoredEvent;
  from: AgentId;
  to: AgentId | null;
  /** `null` for a main-agent reply (assistant_text). */
  channel: MessageChannel | null;
  text: string;
}

function toBubble(se: StoredEvent): Bubble | null {
  const ev = se.ev;
  if (ev.type === 'message_sent') return { se, from: ev.from, to: ev.to, channel: ev.channel, text: ev.text };
  if (ev.type === 'assistant_text' && ev.agent === MAIN_AGENT && ev.text.trim()) {
    return { se, from: MAIN_AGENT, to: null, channel: null, text: ev.text };
  }
  return null;
}

export function MessagesPanel({ session }: { session: SessionState }) {
  const events = useSessionEvents(session.id);
  // Primitive selectors: the replay object changes every frame while playing.
  const replayId = useStore((s) => s.replay?.id ?? null);
  const seqBase = useStore((s) => s.replay?.seqBase ?? 0);
  const replaying = replayId === session.id;
  const selectAgent = useStore((s) => s.selectAgent);
  const replaySeek = useStore((s) => s.replaySeek);
  const [filter, setFilter] = useState<Set<AgentId>>(() => new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const drive = useStore((s) => s.drive[session.id]);

  const bubbles = useMemo(() => {
    const out: Bubble[] = [];
    for (const se of events) {
      const b = toBubble(se);
      if (b) out.push(b);
    }
    return out;
  }, [events]);

  const participants = useMemo(() => {
    const seen = new Map<AgentId, number>();
    for (const b of bubbles) {
      seen.set(b.from, (seen.get(b.from) ?? 0) + 1);
      if (b.to) seen.set(b.to, (seen.get(b.to) ?? 0) + 1);
    }
    return [...seen.keys()];
  }, [bubbles]);

  const shown = filter.size
    ? bubbles.filter((b) => filter.has(b.from) || (b.to !== null && filter.has(b.to)))
    : bubbles;

  useEffect(() => setFilter(new Set()), [session.id]);

  const stick = useStickToBottom(scroller, shown.length, session.id, replaying);
  const { onScroll, jumpToEnd } = stick;
  // Sending a message always brings you to the bottom to see the reply.
  useEffect(() => {
    if (drive?.phase === 'sending') jumpToEnd(false);
  }, [drive?.phase, drive?.sentAt]);

  // The sent text shows as a pending bubble until the transcript echoes the prompt.
  const pending =
    drive && (drive.phase === 'sending' || drive.phase === 'running') &&
    !bubbles.some((b) => b.channel === 'prompt' && b.se.ev.at >= drive.sentAt - 2000 && b.text.trim() === drive.text)
      ? drive
      : null;

  const toggle = (id: AgentId) =>
    setFilter((f) => {
      const next = new Set(f);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onPick = (b: Bubble) => {
    const agent = b.from === USER_AGENT ? (b.to ?? MAIN_AGENT) : b.from;
    selectAgent(session.agents[agent] ? agent : MAIN_AGENT, { keepTab: true });
    if (replaying) replaySeek(b.se.seq - seqBase + 1);
  };

  return (
    <div className="messages">
      {participants.length > 1 && (
        <div className="messages__filters" role="group" aria-label="Filter by agent">
          {participants.map((id) => (
            <button
              key={id}
              className={`fchip${filter.has(id) ? ' fchip--on' : ''}`}
              aria-pressed={filter.has(id)}
              onClick={() => toggle(id)}
              title={id}
            >
              {participantName(session, id)}
            </button>
          ))}
          {filter.size > 0 && (
            <button className="link small" onClick={() => setFilter(new Set())}>
              clear
            </button>
          )}
        </div>
      )}
      <div className="messages__list" ref={scroller} onScroll={onScroll}>
        {!shown.length && (
          <div className="panel-empty">
            {bubbles.length ? 'No messages match the filter.' : 'No messages yet. Prompts, dispatches and results show up here.'}
          </div>
        )}
        {shown.map((b) => (
          <MessageBubble key={b.se.seq} b={b} session={session} onPick={onPick} />
        ))}
        {pending && (
          <div className="bubble bubble--right bubble--pending" style={{ ['--chan' as string]: channelColor.prompt }}>
            <div className="bubble__head">
              <span className="bubble__from">You</span>
              <span className="bubble__arrow" aria-hidden>→</span>
              <span className="bubble__to">main</span>
              <span className="chan">{pending.phase === 'sending' ? 'sending' : 'sent'}</span>
            </div>
            <div className="bubble__body">
              <Markdown text={pending.text} />
            </div>
          </div>
        )}
        {drive?.phase === 'running' && (
          <div className="typing" aria-live="polite">
            <span /><span /><span /> main is working
          </div>
        )}
      </div>
      <JumpToEnd stick={stick} bottom={replaying ? 14 : 118} />
      {!replaying && <Composer session={session} />}
    </div>
  );
}

const MessageBubble = memo(function MessageBubble({
  b,
  session,
  onPick,
}: {
  b: Bubble;
  session: SessionState;
  onPick: (b: Bubble) => void;
}) {
  const [open, setOpen] = useState(false);
  const lines = b.text.split('\n');
  const long = lines.length > COLLAPSED_LINES || b.text.length > 900;
  const text = open || !long ? b.text : lines.slice(0, COLLAPSED_LINES).join('\n').slice(0, 900);
  const fromUser = b.from === USER_AGENT;
  const tint = b.channel ? channelColor[b.channel] : color.holoBase;
  const side = fromUser ? 'bubble--right' : b.channel === null ? 'bubble--reply' : '';

  return (
    <div className={`bubble ${side}`} style={{ ['--chan' as string]: tint }}>
      <button className="bubble__head" onClick={() => onPick(b)} title="Show in scene">
        <span className="bubble__from">{participantName(session, b.from)}</span>
        {b.to !== null && (
          <>
            <span className="bubble__arrow" aria-hidden>
              →
            </span>
            <span className="bubble__to">{participantName(session, b.to)}</span>
          </>
        )}
        <span className="chan">{b.channel ?? 'reply'}</span>
        <span className="bubble__time" title={`${formatClock(b.se.ev.at)} · ${new Date(b.se.ev.at).toLocaleString()}`}>
          {formatOffset(b.se.ev.at - session.started_at)}
        </span>
      </button>
      <div className="bubble__body" onClick={() => onPick(b)}>
        <Markdown text={text} />
      </div>
      {long && (
        <button className="link small bubble__more" onClick={() => setOpen((o) => !o)}>
          {open ? 'show less' : `show all (${lines.length} lines)`}
        </button>
      )}
    </div>
  );
});
