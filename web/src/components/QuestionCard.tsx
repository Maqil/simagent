// The question card: when Claude calls `AskUserQuestion`, its options travel out of the
// asking bot toward "you" and wait halfway as a list. The card is plain DOM (text stays in
// the DOM) laid over the canvas; the scene tells us when to move it via `onViewChanged`.
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { USER_AGENT } from '../protocol';
import type { Anchor, SceneRenderer } from '../scene';
import type { OpenQuestion } from '../scene/questions';

/** Matches the `qcard-out` animation in styles.css. */
const LEAVE_MS = 350;
/** Gap between the bot's edge and the card when "you" is not on screen. */
const ABOVE_GAP = 12;

interface Props {
  /** The question waiting for an answer, or `null` when nothing is being asked. */
  question: OpenQuestion | null;
  renderer: RefObject<SceneRenderer | null>;
  /** Slot the scene calls after every redrawn frame; the card puts its reposition here. */
  viewHook: RefObject<(() => void) | null>;
}

/** A `style` holding one CSS custom property, which React's `CSSProperties` does not list. */
function cssVar(name: '--i' | '--n', v: number): CSSProperties {
  return { [name]: v } as CSSProperties;
}

export function QuestionCard({ question, renderer, viewHook }: Props) {
  // The last question shown, kept while it fades out after being answered.
  const [shown, setShown] = useState<OpenQuestion | null>(question);
  if (question && question.toolUseId !== shown?.toolUseId) {
    // Adjusting state during render (React's "store info from previous renders" pattern):
    // React re-renders right away, before committing, so no stale frame is painted.
    setShown(question);
  }
  const leaving = question === null && shown !== null;

  useLayoutEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setShown(null), LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);

  const cardRef = useRef<HTMLDivElement>(null);
  // Allocated once and reused on every frame: anchorOf writes into them.
  const bot = useRef<Anchor>({ x: 0, y: 0, r: 0 });
  const you = useRef<Anchor>({ x: 0, y: 0, r: 0 });
  // Read at render time so React's className and the per-frame toggle agree.
  const above = useRef(false);

  const id = shown?.toolUseId ?? null;
  useLayoutEffect(() => {
    if (!shown) return;
    const agent = shown.agent;
    const place = (setFrom: boolean) => {
      const el = cardRef.current;
      const r = renderer.current;
      if (!el || !r?.anchorOf) return;
      const b = bot.current;
      if (!r.anchorOf(agent, b)) {
        el.style.visibility = 'hidden';
        return;
      }
      el.style.visibility = '';
      const hasYou = r.anchorOf(USER_AGENT, you.current);
      const x = hasYou ? (b.x + you.current.x) / 2 : b.x;
      const y = hasYou ? (b.y + you.current.y) / 2 : b.y - b.r - ABOVE_GAP;
      if (above.current === hasYou) {
        above.current = !hasYou;
        el.classList.toggle('qcard--above', !hasYou);
      }
      el.style.transform = `translate(${x}px, ${y}px)`;
      if (setFrom) {
        // The items start at the bot: its offset from the card's centre.
        const h = (el.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
        const cy = hasYou ? y : y - h / 2;
        el.style.setProperty('--from-x', `${b.x - x}px`);
        el.style.setProperty('--from-y', `${b.y - cy}px`);
      }
    };
    place(true);
    viewHook.current = () => place(false);
    return () => {
      viewHook.current = null;
    };
    // `shown` only changes identity together with its toolUseId (see above).
  }, [id, renderer, viewHook]);

  if (!shown) return null;

  let i = 0;
  // Item count, so the glow can start once the last item has arrived.
  const total = shown.items.reduce((n, q) => n + 1 + q.options.length, 1);
  const cls = `qcard${above.current ? ' qcard--above' : ''}${leaving ? ' qcard--leaving' : ''}`;
  return (
    <div key={shown.toolUseId} ref={cardRef} className={cls} aria-live="polite">
      <div className="qcard__inner">
        <div className="qcard__body" style={cssVar('--n', total)}>
          {shown.items.map((item, qi) => (
            <div className="qcard__q" key={qi}>
              <div className="qcard__head" style={cssVar('--i', i++)}>
                <span className="qcard__glyph" aria-hidden="true">
                  ?
                </span>
                {item.header && <span className="qcard__chip">{item.header}</span>}
                <span className="qcard__text">{item.question}</span>
              </div>
              <ul className="qcard__opts">
                {item.options.map((label, oi) => (
                  <li className="qcard__opt" key={oi} style={cssVar('--i', i++)}>
                    <span className="qcard__dot" aria-hidden="true" />
                    <span className="qcard__label">{label}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="qcard__wait" style={cssVar('--i', i++)}>
            waiting for you
            <span className="qcard__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
