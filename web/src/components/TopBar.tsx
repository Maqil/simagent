import { useMemo } from 'react';
import { useStore, pendingQueue, openSessions, tabSessions } from '../store';
import { formatCost, sessionLabel, sessionStatus } from '../format';
import { statusColor } from '../tokens';
import { Mascot } from './Mascot';
import { ChartIcon } from './icons';

const connLabel = {
  connecting: 'connecting',
  live: 'live',
  reconnecting: 'reconnecting',
  demo: 'demo',
} as const;

export function TopBar() {
  const sessions = useStore((s) => s.sessions);
  const decided = useStore((s) => s.decided);
  const selected = useStore((s) => s.selectedSession);
  const connection = useStore((s) => s.connection);
  const retryInMs = useStore((s) => s.retryInMs);
  const selectSession = useStore((s) => s.selectSession);
  const replayId = useStore((s) => s.replay?.id ?? null);
  const exitReplay = useStore((s) => s.exitReplay);
  const openReplay = useStore((s) => s.openReplay);
  const setBrowserOpen = useStore((s) => s.setBrowserOpen);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);

  const closed = useStore((s) => s.closed);
  const closeSession = useStore((s) => s.closeSession);
  const list = useMemo(() => openSessions(sessions, closed), [sessions, closed]);
  const { tabs, hidden } = useMemo(() => tabSessions(list, selected, decided), [list, selected, decided]);
  const pendingCount = useMemo(() => pendingQueue(sessions, decided).length, [sessions, decided]);
  const thinking = useMemo(
    () => list.some((s) => Object.values(s.agents).some((a) => a.status === 'thinking')),
    [list],
  );

  const connTitle =
    connection === 'reconnecting' && retryInMs !== null
      ? `reconnecting in ${Math.ceil(retryInMs / 1000)}s`
      : connLabel[connection];

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <Mascot blinking={thinking} />
        <span className="topbar__name">simagent</span>
        <span className={`conn conn--${connection}`} title={connTitle}>
          <span className="conn__dot" />
          <span className="conn__label">{connLabel[connection]}</span>
        </span>
      </div>
      <nav className="tabs" role="tablist" aria-label="Sessions">
        {tabs.map((s) => {
          const st = sessionStatus(s);
          const pending = s.pending.filter((p) => !decided[p.request_id]).length;
          const active = replayId === null && s.id === selected;
          const replaying = replayId === s.id;
          return (
            <div key={s.id} className={`tab${active ? ' tab--active' : ''}${replaying ? ' tab--replay' : ''}`}>
              <button
                role="tab"
                aria-selected={active}
                className="tab__main"
                onClick={() => {
                  if (replayId) exitReplay();
                  setView('live');
                  selectSession(s.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void openReplay(s.id, { title: s.title, autoplay: true });
                }}
                title={`${sessionLabel(s)}${s.cwd ? `\n${s.cwd}` : ''}${s.git_branch ? ` (${s.git_branch})` : ''}\nRight-click to replay from the start`}
              >
                <span className="dot" style={{ background: statusColor[st] }} />
                <span className="tab__label">{sessionLabel(s)}</span>
                <span className="tab__cost">{formatCost(s.cost_usd)}</span>
                {pending > 0 && <span className="badge">{pending}</span>}
              </button>
              <button
                className="tab__close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeSession(s.id);
                }}
                title="Close tab (reopens when the session is active again; History has all sessions)"
                aria-label={`Close ${sessionLabel(s)}`}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          );
        })}
        {hidden > 0 && (
          <button
            className="tab tab--more"
            onClick={() => setBrowserOpen(true)}
            title={`${hidden} more open session${hidden === 1 ? '' : 's'}: open History to switch`}
          >
            +{hidden}
          </button>
        )}
      </nav>
      <div className="topbar__right">
        <button className="btn btn--small history-btn" onClick={() => setBrowserOpen(true)} title="Browse and replay past sessions (⌘K)">
          History <kbd>⌘K</kbd>
        </button>
        <button
          className={`btn btn--small usage-btn${view === 'usage' ? ' is-on' : ''}`}
          onClick={() => setView(view === 'usage' ? 'live' : 'usage')}
          aria-pressed={view === 'usage'}
          title="Tokens, output and API-equivalent cost across all sessions"
        >
          <ChartIcon size={13} /> Usage
        </button>
        {pendingCount > 0 && (
          <span className="pending-pill" title="Pending permission requests">
            <span className="badge">{pendingCount}</span> awaiting approval
          </span>
        )}
      </div>
    </header>
  );
}
