import { useEffect, useRef } from 'react';
import { createSceneRenderer, type SceneRenderer } from '../scene';
import type { AgentEvent, SessionState } from '../protocol';
import { useStore } from '../store';

/** New tail events beyond this count are treated as a seek (no flight for old ones). */
const SEEK_BATCH = 30;

interface Props {
  session: SessionState | null;
  /**
   * Events for transient effects. Only the new tail is pushed; when `resetKey` changes
   * (new session, backward seek) effects are cleared and the whole list replays instantly.
   */
  events?: { list: AgentEvent[]; resetKey: string };
}

/** Hosts the scene canvas. The renderer is imperative; React only feeds it state. */
export function Scene({ session, events }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  const pushed = useRef<{ key: string | null; count: number; last: AgentEvent | null }>({
    key: null,
    count: 0,
    last: null,
  });
  const selectAgent = useStore((s) => s.selectAgent);
  const selectedAgent = useStore((s) => s.selectedAgent);
  const speed = useStore((s) => (s.replay ? s.replay.speed : 1));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = createSceneRenderer(canvas, {
      onSelectAgent: (id) => selectAgent(id),
      onShowFinished: () => useStore.getState().setPanelTab('finished'),
    });
    rendererRef.current = r;
    pushed.current = { key: null, count: 0, last: null };
    const ro = new ResizeObserver(() => r.resize());
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      r.destroy();
      rendererRef.current = null;
    };
  }, [selectAgent]);

  // State first, then the events that led to it, so effects find their agents.
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.setState(session);
    if (!events) return;
    const p = pushed.current;
    const list = events.list;
    const n = list.length;
    if (p.key !== events.resetKey) {
      if (p.key !== null) r.clearEffects();
      p.key = events.resetKey;
      if (n) r.pushEvents(list, { instant: true });
    } else if (n && list[n - 1] !== p.last) {
      // Usually only a tail was appended (diff by count); a capped list that dropped its
      // head, or a merged history, is found again by the last event pushed.
      let from = n > p.count && list[p.count - 1] === p.last ? p.count : -1;
      if (from < 0 && p.last) from = list.lastIndexOf(p.last) + 1;
      if (from > 0) {
        const tail = list.slice(from);
        r.pushEvents(tail, { instant: tail.length > SEEK_BATCH });
      } else {
        r.clearEffects();
        r.pushEvents(list, { instant: true });
      }
    }
    p.count = n;
    p.last = n ? list[n - 1]! : null;
  }, [session, events]);

  useEffect(() => {
    rendererRef.current?.setTimeScale?.(speed);
  }, [speed]);

  useEffect(() => {
    rendererRef.current?.setSelected?.(selectedAgent);
  }, [selectedAgent]);

  return (
    <div className="scene">
      <canvas ref={canvasRef} className="scene__canvas" aria-label="Agent scene" />
      <div className="scene__hint">drag to pan · wheel to zoom · double-click to fit</div>
    </div>
  );
}
