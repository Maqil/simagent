// "Latest" button for scrolling lists: appears when you scroll up, counts what arrived
// since, and scrolls back to the bottom on click. Shared by Messages, Activity and Review.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Distance from the bottom (px) that still counts as "at the bottom". */
const NEAR_BOTTOM = 40;

export interface StickToBottom {
  /** Attach to the scrolling element's `onScroll`. */
  onScroll: () => void;
  /** Scrolls to the bottom and hides the button. */
  jumpToEnd: (smooth?: boolean) => void;
  /** Whether the user is at the bottom (sticky follow is on). */
  atBottom: RefObject<boolean>;
  showJump: boolean;
  unread: number;
}

/**
 * Keeps `scroller` pinned to the bottom as `count` grows, unless the user scrolled up.
 * `follow` forces pinning (replay follows the playhead). `resetKey` resets on session change.
 */
export function useStickToBottom(
  scroller: RefObject<HTMLElement | null>,
  count: number,
  resetKey: string,
  follow = false,
): StickToBottom {
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [unread, setUnread] = useState(0);
  const prev = useRef(count);
  /** While a smooth jump runs, its own scroll events must not re-show the button. */
  const jumping = useRef(0);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    if (performance.now() < jumping.current) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    atBottom.current = bottom;
    setShowJump(!bottom);
    if (bottom) setUnread(0);
  }, [scroller]);

  const jumpToEnd = useCallback(
    (smooth = true) => {
      const el = scroller.current;
      if (!el) return;
      // Lists with lazily sized rows (content-visibility) grow while we scroll, so the
      // bottom moves. Glide most of the way, then re-pin to the true bottom each frame
      // until the height stops changing.
      const until = performance.now() + (smooth ? 900 : 300);
      jumping.current = until;
      if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      else el.scrollTop = el.scrollHeight;
      let lastH = -1;
      const settle = () => {
        const now = performance.now();
        if (!smooth || now > until - 400) el.scrollTop = el.scrollHeight;
        if (now < until || el.scrollHeight !== lastH) {
          lastH = el.scrollHeight;
          if (now < until + 1000) requestAnimationFrame(settle);
        }
      };
      requestAnimationFrame(settle);
      atBottom.current = true;
      setShowJump(false);
      setUnread(0);
    },
    [scroller],
  );

  useLayoutEffect(() => {
    const el = scroller.current;
    const added = count - prev.current;
    prev.current = count;
    if (el && (atBottom.current || follow)) el.scrollTop = el.scrollHeight;
    else if (added > 0) setUnread((n) => n + added);
  }, [count, follow, scroller]);

  useEffect(() => {
    atBottom.current = true;
    setShowJump(false);
    setUnread(0);
    prev.current = count;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    // Only on session change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  return { onScroll, jumpToEnd, atBottom, showJump, unread };
}

export function JumpToEnd({ stick, bottom = 14 }: { stick: StickToBottom; bottom?: number }) {
  if (!stick.showJump) return null;
  return (
    <button
      className="jump-end"
      style={{ bottom }}
      onClick={() => stick.jumpToEnd()}
      title="Jump to the latest"
      aria-label="Jump to latest"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
        <path d="M12 4v14M5 12l7 7 7-7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {stick.unread > 0 ? `${stick.unread} new` : 'Latest'}
    </button>
  );
}
