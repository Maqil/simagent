// Chat box under Messages: continue the session from the browser. Sends a `prompt`; the
// server runs one headless `claude -p --resume` turn and the transcript tailer streams the
// reply back into the conversation. Approvals during the turn use the normal approval card.
import { useEffect, useRef, useState } from 'react';
import type { SessionState } from '../protocol';
import { useStore } from '../store';
import { sessionStatus, isBusy } from '../format';

const DRAFT_KEY = (id: string) => `simagent.draft.${id}`;

function loadDraft(id: string): string {
  try {
    return sessionStorage.getItem(DRAFT_KEY(id)) ?? '';
  } catch {
    return '';
  }
}

export function Composer({ session }: { session: SessionState }) {
  const connection = useStore((s) => s.connection);
  const drive = useStore((s) => s.drive[session.id]);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const interruptTurn = useStore((s) => s.interruptTurn);
  const [text, setText] = useState(() => loadDraft(session.id));
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setText(loadDraft(session.id)), [session.id]);
  useEffect(() => {
    try {
      if (text) sessionStorage.setItem(DRAFT_KEY(session.id), text);
      else sessionStorage.removeItem(DRAFT_KEY(session.id));
    } catch {
      /* storage unavailable */
    }
  }, [text, session.id]);
  // Grow with content up to a limit.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [text]);

  const driving = drive?.phase === 'sending' || drive?.phase === 'running';
  // A session busy in a terminal would get a second writer; warn instead of blocking.
  const busyElsewhere = !driving && isBusy(sessionStatus(session));
  const offline = connection !== 'live';
  const canSend = !offline && !driving && text.trim() !== '';

  const send = () => {
    if (!canSend) return;
    sendPrompt(session.id, text);
    setText('');
  };

  return (
    <div className="composer">
      {drive && drive.phase === 'failed' && (
        <div className="composer__note composer__note--error" role="alert">
          Couldn't continue the session: {drive.detail}
        </div>
      )}
      {drive && drive.phase === 'interrupted' && <div className="composer__note">Turn interrupted.</div>}
      {busyElsewhere && (
        <div className="composer__note composer__note--warn">
          This session looks busy (maybe in a terminal). Sending now starts a second turn on it.
        </div>
      )}
      <div className={`composer__box${driving ? ' composer__box--busy' : ''}`}>
        <textarea
          ref={box}
          className="composer__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            offline
              ? 'Connect to the simagent server to chat…'
              : driving
                ? 'Claude is working… you can type your next message'
                : `Message ${session.title ?? 'this session'}…`
          }
          rows={1}
          aria-label="Message the session"
        />
        {driving ? (
          <button className="composer__btn composer__btn--stop" onClick={() => interruptTurn(session.id)} title="Stop this turn">
            <span className="composer__stop" aria-hidden /> Stop
          </button>
        ) : (
          <button className="composer__btn" onClick={send} disabled={!canSend} title="Send (Enter) · new line (Shift+Enter)">
            Send
          </button>
        )}
      </div>
      <div className="composer__hint muted">
        {driving ? (
          <>
            <span className="composer__dot" /> running in {session.cwd ?? 'the session folder'} · approvals appear here
          </>
        ) : (
          <>Enter to send · Shift+Enter for a new line · continues this session with Claude Code</>
        )}
      </div>
    </div>
  );
}
