import { useEffect, useMemo, useRef, useState } from 'react';
import type { JsonValue } from '../protocol';
import { useStore, pendingQueue } from '../store';
import { formatDuration, getString, prettyJson, sessionLabel } from '../format';

const DEFAULT_DENY = 'Denied from simagent';

type Mode = { kind: 'view' } | { kind: 'edit'; text: string; error: string | null } | { kind: 'deny'; message: string };

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Shows the oldest pending permission request across all sessions. */
export function ApprovalCard() {
  const sessions = useStore((s) => s.sessions);
  const decided = useStore((s) => s.decided);
  const decide = useStore((s) => s.decide);
  const selectSession = useStore((s) => s.selectSession);
  // Request ids hidden with the close button. Local only: no decision is sent, so Claude
  // Code keeps (or falls back to) its own terminal prompt for them.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const queue = useMemo(
    () => pendingQueue(sessions, decided).filter((q) => !dismissed.has(q.pending.request_id)),
    [sessions, decided, dismissed],
  );
  const head = queue[0];
  const requestId = head?.pending.request_id;
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const now = useNow(1000);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const denyRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMode({ kind: 'view' }), [requestId]);
  useEffect(() => {
    if (mode.kind === 'edit') areaRef.current?.focus();
    if (mode.kind === 'deny') denyRef.current?.select();
  }, [mode.kind]);

  const allow = (updated?: JsonValue) => {
    if (!requestId) return;
    decide(requestId, updated === undefined ? { behavior: 'allow' } : { behavior: 'allow', updated_input: updated });
  };
  const deny = (message: string) => {
    if (!requestId) return;
    decide(requestId, { behavior: 'deny', message: message.trim() || DEFAULT_DENY });
  };
  const startEdit = () => {
    if (head) setMode({ kind: 'edit', text: prettyJson(head.pending.input), error: null });
  };
  const dismiss = () => {
    if (!requestId) return;
    setDismissed((prev) => new Set(prev).add(requestId));
  };
  const saveEdit = () => {
    if (mode.kind !== 'edit') return;
    try {
      allow(JSON.parse(mode.text) as JsonValue);
    } catch (e) {
      setMode({ ...mode, error: e instanceof Error ? e.message : 'Invalid JSON' });
    }
  };

  // Keyboard: A / D / E when not typing. Inside the editors: Cmd/Ctrl+Enter confirms, Esc cancels.
  // Esc in view mode hides the card (same as the close button).
  const handlers = useRef({ allow, startEdit, setMode, dismiss });
  handlers.current = { allow, startEdit, setMode, dismiss };
  useEffect(() => {
    if (!requestId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (mode.kind !== 'view') {
        if (e.key === 'Escape') handlers.current.setMode({ kind: 'view' });
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        handlers.current.dismiss();
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'a') {
        e.preventDefault();
        handlers.current.allow();
      } else if (k === 'd') {
        e.preventDefault();
        handlers.current.setMode({ kind: 'deny', message: DEFAULT_DENY });
      } else if (k === 'e') {
        e.preventDefault();
        handlers.current.startEdit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestId, mode.kind]);

  if (!head) return null;
  const { session, pending } = head;
  const agent = session.agents[pending.agent];
  const command = pending.tool_name === 'Bash' ? getString(pending.input, 'command') : null;
  const description = getString(pending.input, 'description');

  return (
    <div className="approval" role="dialog" aria-label="Permission request">
      <div className="approval__head">
        <span className="approval__tag">Permission</span>
        <span className="approval__tool">{pending.tool_name}</span>
        <span className="approval__wait">waiting {formatDuration(now - pending.requested_at)}</span>
        {queue.length > 1 && <span className="badge">+{queue.length - 1}</span>}
        <button
          className="approval__close"
          onClick={dismiss}
          aria-label="Dismiss"
          title="Hide this card (answer in the terminal)"
        >
          ×
        </button>
      </div>
      <div className="approval__meta">
        <button className="link" onClick={() => selectSession(session.id)}>
          {sessionLabel(session)}
        </button>
        <span className="muted"> · {agent?.name ?? pending.agent}</span>
      </div>

      {mode.kind === 'edit' ? (
        <div className="approval__edit">
          <textarea
            ref={areaRef}
            className="mono"
            spellCheck={false}
            value={mode.text}
            onChange={(e) => setMode({ kind: 'edit', text: e.target.value, error: null })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit();
              if (e.key === 'Escape') setMode({ kind: 'view' });
            }}
            rows={Math.min(16, mode.text.split('\n').length + 1)}
          />
          {mode.error && <div className="err small">Invalid JSON: {mode.error}</div>}
          <div className="approval__actions">
            <button className="btn btn--allow" onClick={saveEdit}>
              Save &amp; Allow <kbd>⌘↵</kbd>
            </button>
            <button className="btn" onClick={() => setMode({ kind: 'view' })}>
              Cancel <kbd>Esc</kbd>
            </button>
          </div>
        </div>
      ) : mode.kind === 'deny' ? (
        <div className="approval__edit">
          <label className="small muted" htmlFor="deny-msg">
            Message shown to Claude
          </label>
          <input
            id="deny-msg"
            ref={denyRef}
            className="input"
            value={mode.message}
            onChange={(e) => setMode({ kind: 'deny', message: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') deny(mode.message);
              if (e.key === 'Escape') setMode({ kind: 'view' });
            }}
          />
          <div className="approval__actions">
            <button className="btn btn--deny" onClick={() => deny(mode.message)}>
              Deny <kbd>↵</kbd>
            </button>
            <button className="btn" onClick={() => setMode({ kind: 'view' })}>
              Cancel <kbd>Esc</kbd>
            </button>
          </div>
        </div>
      ) : (
        <>
          {command !== null ? (
            <div className="approval__cmd">
              {description && <div className="muted small">{description}</div>}
              <pre className="mono">{command}</pre>
            </div>
          ) : (
            <pre className="approval__input mono">{prettyJson(pending.input)}</pre>
          )}
          <div className="approval__actions">
            <button className="btn btn--allow" onClick={() => allow()}>
              Allow <kbd>A</kbd>
            </button>
            <button className="btn btn--deny" onClick={() => setMode({ kind: 'deny', message: DEFAULT_DENY })}>
              Deny <kbd>D</kbd>
            </button>
            <button className="btn" onClick={startEdit}>
              Edit <kbd>E</kbd>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
