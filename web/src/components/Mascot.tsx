// 12×8 pixel bot, drawn as crisp SVG rects. Eyes blink while any agent is thinking.
interface Props {
  blinking: boolean;
  scale?: number;
}

export function Mascot({ blinking, scale = 3 }: Props) {
  return (
    <svg
      className={`mascot${blinking ? ' mascot--blink' : ''}`}
      width={12 * scale}
      height={8 * scale}
      viewBox="0 0 12 8"
      shapeRendering="crispEdges"
      role="img"
      aria-label="simagent bot"
    >
      {/* antenna */}
      <rect x="5" y="0" width="2" height="1" fill="var(--mascot-body)" />
      {/* head/body */}
      <rect x="1" y="1" width="10" height="6" fill="var(--mascot-body)" />
      {/* ears */}
      <rect x="0" y="3" width="1" height="2" fill="var(--mascot-body)" />
      <rect x="11" y="3" width="1" height="2" fill="var(--mascot-body)" />
      {/* feet */}
      <rect x="2" y="7" width="2" height="1" fill="var(--mascot-body)" />
      <rect x="8" y="7" width="2" height="1" fill="var(--mascot-body)" />
      {/* eyes */}
      <g className="mascot__eyes">
        <rect x="3" y="3" width="2" height="2" fill="var(--mascot-eye)" />
        <rect x="7" y="3" width="2" height="2" fill="var(--mascot-eye)" />
      </g>
    </svg>
  );
}
