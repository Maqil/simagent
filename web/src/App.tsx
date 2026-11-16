import { useEffect, useMemo } from 'react';
import type { AgentEvent, SessionState } from './protocol';
import { useStore, type StoredEvent } from './store';
import { connect } from './connection';
import { demoMode, startDemo, startReplayDemo } from './demo';
import { TopBar } from './components/TopBar';
import { Scene } from './components/Scene';
import { SidePanel } from './components/SidePanel';
import { Timeline } from './components/Timeline';
import { ApprovalCard } from './components/ApprovalCard';
import { EmptyState } from './components/EmptyState';
import { SessionBrowser } from './components/SessionBrowser';
import { UserCard } from './components/UserCard';
import { UsagePage } from './components/UsagePage';
import { ReplayBanner, ReplayStatusBar, useReplayClock, useReplayKeys } from './components/ReplayBanner';

const NO_EVENTS: StoredEvent[] = [];

/** What the scene animates from: new tail events, cleared whenever `resetKey` changes. */
export interface SceneEvents {
  list: AgentEvent[];
  resetKey: string;
}

export function App() {
  useEffect(() => {
    // `?view=usage` opens the Usage page directly (bookmarkable).
    if (new URLSearchParams(window.location.search).get('view') === 'usage') useStore.getState().setView('usage');
    const mode = demoMode();
    if (mode === 'replay') return startReplayDemo();
    if (mode === 'live') return startDemo();
    const stop = connect();
    // `?replay=<session id>` opens that session in replay mode (bookmarkable).
    // `&seek=0.5` starts paused at that fraction of the events.
    const q = new URLSearchParams(window.location.search);
    const replayId = q.get('replay');
    if (replayId) {
      const seek = Number(q.get('seek'));
      void useStore
        .getState()
        .openReplay(replayId, { autoplay: !(seek > 0) })
        .then(() => {
          const st = useStore.getState();
          if (seek > 0 && st.replay) {
            st.replaySeek(Math.round(st.replay.stored.length * Math.min(1, seek)));
          }
        });
    }
    return stop;
  }, []);
  useReplayClock();
  useReplayKeys();

  // Narrow selectors: the replay object itself changes every frame while playing, but
  // `state`/`visibleEvents` only change when the playhead crosses an event.
  const replayId = useStore((s) => s.replay?.id ?? null);
  const replayState = useStore((s) => s.replay?.state ?? null);
  const replayEvents = useStore((s) => s.replay?.visibleEvents ?? null);
  const seekCounter = useStore((s) => s.replay?.seekCounter ?? 0);
  const liveSession = useStore((s) => (s.selectedSession ? (s.sessions[s.selectedSession] ?? null) : null));
  const liveStored = useStore((s) => (s.selectedSession ? (s.events[s.selectedSession] ?? NO_EVENTS) : NO_EVENTS));
  const warning = useStore((s) => s.protocolWarning);
  const view = useStore((s) => s.view);

  // In replay the playhead state replaces the live one everywhere.
  const session: SessionState | null = replayId ? replayState : liveSession;
  const liveList = useMemo(() => liveStored.map((se) => se.ev), [liveStored]);
  const events = useMemo<SceneEvents | undefined>(() => {
    if (!session) return undefined;
    if (replayId && replayEvents) return { list: replayEvents, resetKey: `replay:${replayId}:${seekCounter}` };
    return { list: liveList, resetKey: session.id };
  }, [session, replayId, replayEvents, seekCounter, liveList]);
  // Spread so this compiles both before and after Scene declares its optional `events` prop.
  const sceneProps = { session, events };

  return (
    <div className={`app${replayId ? ' app--replay' : ''}`}>
      <TopBar />
      <ReplayBanner />
      <ReplayStatusBar />
      {warning && <div className="banner">{warning}</div>}
      {view === 'usage' ? (
        <UsagePage />
      ) : session ? (
        <main className="main">
          <div className="center">
            <div className="scene-wrap">
              <Scene {...sceneProps} />
              <UserCard session={session} />
            </div>
            <Timeline session={session} />
          </div>
          <SidePanel session={session} />
        </main>
      ) : (
        <EmptyState />
      )}
      {/* Replay is read-only: no approvals. */}
      {!replayId && <ApprovalCard />}
      <SessionBrowser />
    </div>
  );
}
