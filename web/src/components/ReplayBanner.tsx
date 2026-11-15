// Replay mode chrome: the banner across the top, the playback clock and the keyboard map.
import { useEffect } from 'react';
import { useStore } from '../store';
import { formatClock } from '../format';

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Drives playback with requestAnimationFrame while playing; idle otherwise. */
export function useReplayClock(): void {
  const playing = useStore((s) => s.replay?.playing ?? false);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      // Clamp so a background tab doesn't jump minutes ahead on return.
      const dt = Math.min(250, now - last);
      last = now;
      useStore.getState().replayTick(dt);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
}

/** Space play/pause · ←/→ step · Shift+←/→ previous/next message · Esc exit. */
export function useReplayKeys(): void {
  const active = useStore((s) => s.replay !== null);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const st = useStore.getState();
      const r = st.replay;
      if (!r || st.browserOpen) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          // At the end, Space starts over, like the Play button.
          if (!r.playing && r.cursor >= r.stored.length) st.replaySeek(0);
          st.replaySetPlaying(!r.playing);
          break;
        case 'ArrowRight':
          e.preventDefault();
          st.replaySetPlaying(false);
          if (e.shiftKey) st.replayJumpMessage(1);
          else st.replayStep(1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          st.replaySetPlaying(false);
          if (e.shiftKey) st.replayJumpMessage(-1);
          else st.replayStep(-1);
          break;
        case 'Home':
          e.preventDefault();
          st.replaySeek(0);
          break;
        case 'End':
          e.preventDefault();
          st.replaySeek(r.stored.length);
          break;
        case 'Escape':
          st.exitReplay();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}

export function ReplayBanner() {
  const id = useStore((s) => s.replay?.id ?? null);
  const title = useStore((s) => s.replay?.title ?? null);
  const cwd = useStore((s) => s.replay?.state.cwd ?? null);
  const startedAt = useStore((s) => s.replay?.timeline.events[0]?.at ?? null);
  const exit = useStore((s) => s.exitReplay);
  if (!id) return null;
  const date =
    startedAt !== null
      ? `${new Date(startedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${formatClock(startedAt)}`
      : '';
  return (
    <div className="replay-banner" role="status">
      <span className="replay-banner__tag">Replay</span>
      <span className="replay-banner__title">{title ?? cwd ?? id.slice(0, 8)}</span>
      {date && <span className="replay-banner__date mono">{date}</span>}
      <span className="replay-banner__keys muted">
        <kbd>Space</kbd> play · <kbd>←</kbd>
        <kbd>→</kbd> step · <kbd>⇧→</kbd> next message
      </span>
      <button className="btn btn--small replay-banner__exit" onClick={exit} title="Exit replay (Esc)">
        ✕ Exit to live
      </button>
    </div>
  );
}

/** Shown while a replay loads or after it failed. */
export function ReplayStatusBar() {
  const status = useStore((s) => s.replayStatus);
  if (!status.loading && !status.error) return null;
  return (
    <div className={`banner${status.error ? '' : ' banner--info'}`}>
      {status.error ? `Replay failed: ${status.error}` : `Loading replay ${status.loading?.slice(0, 8)}…`}
    </div>
  );
}
