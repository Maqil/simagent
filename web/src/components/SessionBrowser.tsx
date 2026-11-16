// Session browser (History, ⌘K): every transcript on disk, searchable; pick one to replay.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '../protocol';
import { useStore } from '../store';
import { basename, formatAgo, formatBytes } from '../format';

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; list: SessionSummary[] };

function label(s: SessionSummary): string {
  return s.title ?? (s.cwd ? basename(s.cwd) : s.id.slice(0, 8));
}

/** Claude Code encodes the cwd as the project dir name (`/` → `-`); show it readably. */
function projectName(s: SessionSummary): string {
  if (s.cwd) return basename(s.cwd);
  const parts = s.project.split('-').filter(Boolean);
  return parts.at(-1) ?? s.project;
}

export function SessionBrowser() {
  const open = useStore((s) => s.browserOpen);
  const setOpen = useStore((s) => s.setBrowserOpen);
  // ⌘K / Ctrl+K toggles the browser from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useStore.getState().browserOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
  return open ? <BrowserDialog onClose={() => setOpen(false)} /> : null;
}

function BrowserDialog({ onClose }: { onClose: () => void }) {
  const source = useStore((s) => s.replaySource);
  const openReplay = useStore((s) => s.openReplay);
  const openLive = useStore((s) => s.openLive);
  // The scripted demo has no server to load sessions from, so it can only replay.
  const canOpenLive = useStore((s) => s.connection !== 'demo');
  const loaded = useStore((s) => s.sessions);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let alive = true;
    source
      .list()
      .then((list) => alive && setLoad({ kind: 'ok', list: [...list].sort((a, b) => b.modified_ms - a.modified_ms) }))
      .catch((e: unknown) => alive && setLoad({ kind: 'error', message: e instanceof Error ? e.message : String(e) }));
    inputRef.current?.focus();
    return () => {
      alive = false;
    };
  }, [source]);

  const filtered = useMemo(() => {
    if (load.kind !== 'ok') return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return load.list;
    return load.list.filter((s) => {
      const hay = `${s.title ?? ''} ${s.cwd ?? ''} ${s.project} ${s.id}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [load, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const replay = (s: SessionSummary) => void openReplay(s.id, { title: s.title, autoplay: true });
  /** Default action: open live as a tab (replay when there is no server, e.g. the demo). */
  const pick = (s: SessionSummary) => (canOpenLive ? openLive(s.id) : replay(s));

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(filtered.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      const s = filtered[active];
      if (s) (e.shiftKey ? replay : pick)(s);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="browser" role="dialog" aria-label="Session history" onKeyDown={onKey}>
        <div className="browser__head">
          <span className="browser__title">History</span>
          <input
            ref={inputRef}
            className="input browser__search"
            placeholder="Search title, folder, project or id…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search sessions"
          />
          <button className="iconbtn" onClick={onClose} aria-label="Close" title="Close (Esc)">
            ✕
          </button>
        </div>
        {load.kind === 'loading' && <div className="panel-empty">Loading sessions…</div>}
        {load.kind === 'error' && <div className="panel-empty err">Could not list sessions: {load.message}</div>}
        {load.kind === 'ok' && (
          <ul className="browser__list" ref={listRef} role="listbox">
            {!filtered.length && <li className="panel-empty">No sessions match “{query}”.</li>}
            {filtered.map((s, i) => (
              <li key={s.id} data-i={i} role="option" aria-selected={i === active} className="session-item" onMouseEnter={() => setActive(i)}>
                <button
                  className={`session-row${i === active ? ' session-row--active' : ''}`}
                  onClick={() => pick(s)}
                  title={`${canOpenLive ? (loaded[s.id] ? 'Switch to this tab' : 'Open live as a tab') : 'Replay'}\n${s.cwd ?? s.project}\n${s.id}`}
                >
                  <span className="session-row__main">
                    <span className="session-row__title">
                      {s.live && <span className="live-badge">live</span>}
                      {label(s)}
                    </span>
                    <span className="session-row__sub mono">
                      {projectName(s)}
                      {s.cwd && s.title ? <span className="muted"> · {s.cwd}</span> : null}
                    </span>
                  </span>
                  <span className="session-row__meta mono">
                    <span>{formatAgo(s.modified_ms)}</span>
                    <span className="muted">{formatBytes(s.size_bytes)}</span>
                    {s.subagents > 0 && <span className="session-row__subs">⑂ {s.subagents}</span>}
                  </span>
                </button>
                {canOpenLive && (
                  <button className="btn btn--small session-item__replay" onClick={() => replay(s)} title="Replay from the start (⇧↵)">
                    Replay
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="browser__foot muted small">
          <kbd>↑</kbd>
          <kbd>↓</kbd> choose · <kbd>↵</kbd> {canOpenLive ? 'open' : 'replay'}
          {canOpenLive && (
            <>
              {' '}· <kbd>⇧↵</kbd> replay
            </>
          )}{' '}
          · <kbd>Esc</kbd> close · <kbd>⌘K</kbd> toggle
        </div>
      </div>
    </div>
  );
}
