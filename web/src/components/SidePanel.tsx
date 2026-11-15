import { useCallback, useMemo, useRef, useState } from 'react';
import type { SessionState } from '../protocol';
import { useStore, type PanelTab } from '../store';
import { ActivityPanel } from './ActivityPanel';
import { AgentsPanel } from './AgentsPanel';
import { FilesPanel } from './FilesPanel';
import { MessagesPanel } from './MessagesPanel';
import { ReviewPanel } from './ReviewPanel';
import { FinishedPanel, finishedAgents } from './FinishedPanel';

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'review', label: 'Review' },
  { id: 'messages', label: 'Messages' },
  { id: 'activity', label: 'Activity' },
  { id: 'finished', label: 'Finished' },
  { id: 'agents', label: 'Agents' },
  { id: 'files', label: 'Files' },
];

const WIDTH_KEY = 'simagent.panelWidth';

function initialWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    if (v >= 280 && v <= 1200) return v;
  } catch {
    /* storage unavailable */
  }
  return 420;
}

export function SidePanel({ session }: { session: SessionState }) {
  const tab = useStore((s) => s.panelTab);
  const setTab = useStore((s) => s.setPanelTab);
  const [width, setWidth] = useState(initialWidth);
  const finishedCount = useMemo(() => finishedAgents(session).length, [session]);
  const drag = useRef<{ x: number; w: number } | null>(null);

  const onDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, w: width };
    },
    [width],
  );
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const max = Math.max(320, window.innerWidth - 320);
    setWidth(Math.round(Math.min(max, Math.max(280, drag.current.w + drag.current.x - e.clientX))));
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <aside className="side" style={{ width }}>
      <div
        className="side__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      <div className="side__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`side__tab${tab === t.id ? ' side__tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'finished' && finishedCount > 0 && <span className="side__count">{finishedCount}</span>}
          </button>
        ))}
      </div>
      <div className="side__body">
        {tab === 'review' && <ReviewPanel session={session} />}
        {tab === 'messages' && <MessagesPanel session={session} />}
        {tab === 'activity' && <ActivityPanel session={session} />}
        {tab === 'finished' && <FinishedPanel session={session} />}
        {tab === 'agents' && <AgentsPanel session={session} />}
        {tab === 'files' && <FilesPanel session={session} />}
      </div>
    </aside>
  );
}
