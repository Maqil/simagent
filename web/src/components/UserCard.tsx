import { useMemo, useState } from 'react';
import type { SessionState } from '../protocol';
import { USER_AGENT } from '../protocol';
import { useSessionEvents, useStore } from '../store';
import { formatClock } from '../format';
import { Mascot } from './Mascot';

/** Max earlier prompts listed under the latest one. */
const EARLIER = 5;

/** First non-blank line, so prompts that start with a pasted block still read well. */
function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '(empty)';
}

interface Prompt {
  seq: number;
  at: number;
  text: string;
}

/**
 * Card shown when the "you" node is selected in the scene: your latest prompt in full,
 * plus a few earlier ones. In replay it follows the playhead.
 */
export function UserCard({ session }: { session: SessionState }) {
  const selected = useStore((s) => s.selectedAgent);
  const selectAgent = useStore((s) => s.selectAgent);
  const setPanelTab = useStore((s) => s.setPanelTab);
  const events = useSessionEvents(session.id);
  const [expanded, setExpanded] = useState(false);

  const prompts = useMemo<Prompt[]>(() => {
    if (selected !== USER_AGENT) return [];
    const out: Prompt[] = [];
    for (const { seq, ev } of events) {
      if (ev.type === 'message_sent' && ev.from === USER_AGENT && ev.channel === 'prompt') {
        out.push({ seq, at: ev.at, text: ev.text });
      }
    }
    return out.reverse();
  }, [events, selected]);

  if (selected !== USER_AGENT) return null;
  const [last, ...earlier] = prompts;
  const long = last ? last.text.split('\n').length > 12 || last.text.length > 900 : false;

  return (
    <div className="user-card" role="dialog" aria-label="Your last prompt">
      <div className="user-card__head">
        <Mascot blinking={false} scale={2} />
        <span className="user-card__title">You</span>
        <span className="muted small">
          {prompts.length} prompt{prompts.length === 1 ? '' : 's'}
        </span>
        <button className="user-card__close" aria-label="Close" onClick={() => selectAgent(null)}>
          ×
        </button>
      </div>
      {last ? (
        <>
          <div className="user-card__label small muted">
            Last prompt · {formatClock(last.at)}
          </div>
          <div className={`user-card__text${long && !expanded ? ' user-card__text--clamp' : ''}`}>
            {last.text}
          </div>
          <div className="user-card__actions">
            {long && (
              <button className="link small" onClick={() => setExpanded((v) => !v)}>
                {expanded ? 'show less' : 'show all'}
              </button>
            )}
            <button className="link small" onClick={() => setPanelTab('messages')}>
              open in Messages
            </button>
          </div>
          {earlier.length > 0 && (
            <div className="user-card__earlier">
              <div className="small muted">Earlier</div>
              {earlier.slice(0, EARLIER).map((p) => (
                <div key={p.seq} className="user-card__row small" title={p.text}>
                  <span className="mono muted">{formatClock(p.at)}</span>
                  <span className="user-card__snippet">{firstLine(p.text)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="muted small">No prompts in this session yet.</div>
      )}
    </div>
  );
}
