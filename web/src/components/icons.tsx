// Small inline SVG icons for the replay player. Stroke/fill use currentColor so buttons
// control their colour; all are 16×16 on a 24-unit grid.
import type { ReactElement } from 'react';

type IconProps = { size?: number; title?: string };

function svg(children: ReactElement | ReactElement[], { size = 16, title }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

export const PlayIcon = (p: IconProps) => svg(<path d="M8 5.2v13.6a1 1 0 0 0 1.5.86l11-6.8a1 1 0 0 0 0-1.72l-11-6.8A1 1 0 0 0 8 5.2z" />, p);

export const PauseIcon = (p: IconProps) =>
  svg(
    [<rect key="a" x="6" y="4.5" width="4.2" height="15" rx="1.2" />, <rect key="b" x="13.8" y="4.5" width="4.2" height="15" rx="1.2" />],
    p,
  );

/** Back to start: bar + double triangle. */
export const RestartIcon = (p: IconProps) =>
  svg([<rect key="b" x="4" y="5" width="2.4" height="14" rx="1" />, <path key="t" d="M19 6.2v11.6a.9.9 0 0 1-1.4.75L9.3 12.75a.9.9 0 0 1 0-1.5l8.3-5.8A.9.9 0 0 1 19 6.2z" />], p);

/** Jump to end. */
export const EndIcon = (p: IconProps) =>
  svg([<path key="t" d="M5 6.2v11.6a.9.9 0 0 0 1.4.75l8.3-5.8a.9.9 0 0 0 0-1.5l-8.3-5.8A.9.9 0 0 0 5 6.2z" />, <rect key="b" x="17.6" y="5" width="2.4" height="14" rx="1" />], p);

/** Step back one event. */
export const StepBackIcon = (p: IconProps) =>
  svg([<path key="a" d="M12 6.5v11a.8.8 0 0 1-1.25.66L3.6 12.66a.8.8 0 0 1 0-1.32l7.15-5.5A.8.8 0 0 1 12 6.5z" />, <path key="b" d="M21 6.5v11a.8.8 0 0 1-1.25.66l-7.15-5.5a.8.8 0 0 1 0-1.32l7.15-5.5A.8.8 0 0 1 21 6.5z" />], p);

/** Step forward one event. */
export const StepFwdIcon = (p: IconProps) =>
  svg([<path key="a" d="M3 6.5v11a.8.8 0 0 0 1.25.66l7.15-5.5a.8.8 0 0 0 0-1.32L4.25 5.84A.8.8 0 0 0 3 6.5z" />, <path key="b" d="M12 6.5v11a.8.8 0 0 0 1.25.66l7.15-5.5a.8.8 0 0 0 0-1.32l-7.15-5.5A.8.8 0 0 0 12 6.5z" />], p);

/** Speech bubble with an arrow: previous/next message. */
export const MessageIcon = ({ dir, ...p }: IconProps & { dir: 1 | -1 }) =>
  svg(
    [
      <path key="b" d="M4 5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.5 3v-3H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" opacity="0.85" />,
      <path
        key="a"
        d={dir === 1 ? 'M18.5 8.5l3.5 3.5-3.5 3.5' : 'M22 8.5L18.5 12l3.5 3.5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />,
    ],
    p,
  );

/** Circular arrow, used for the Replay button. */
export const ReplayIcon = (p: IconProps) =>
  svg(
    [
      <path key="c" d="M12 4a8 8 0 1 1-7.6 5.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />,
      <path key="h" d="M3 4.5v5h5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />,
      <path key="p" d="M10.2 9.2v5.6l4.6-2.8z" />,
    ],
    p,
  );
