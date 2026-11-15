# Visual identity

Our own design tokens. They keep the look the user built in an earlier prototype:
a dark holographic control room with orb agents, a pixel-bot mascot and playful lifecycle
animations. The tokens are re-specified here and become the single source for both CSS
variables (`web/`) and WGSL uniforms (`sim-render`). All code is original.

## Color tokens
| Token | Value | Use |
|---|---|---|
| `bg.void` | `#050510` | Page and scene background |
| `bg.grid` | `#0d0d1f` | Dot grid / starfield base |
| `holo.base` | `#66ccff` | Primary accent, links, focus |
| `holo.bright` | `#aaeeff` | Primary text on dark |
| `holo.hot` | `#ffffff` | Glow cores, highlights |
| `text.dim` | `#6aa9cf` | Secondary text (~8:1 contrast on void) |
| `text.muted` | `#4f8fb3` | Tertiary text (~5.7:1, still WCAG AA) |
| `mascot.body` | `#d97757` | Pixel-bot body |
| `mascot.eye` | `#0b0d14` | Pixel-bot eyes |
| `edge.dispatch` | `#cc88ff` | Parent → subagent launch |
| `edge.return` | `#66ffaa` | Subagent → parent return |
| `live` | `#ff4444` | Live indicator dot |

### Agent state colors
Every `SessionState` variant maps to exactly one color; the mapping is an exhaustive `match`
in Rust so a new state cannot ship without a color.

| State | Color | Motion |
|---|---|---|
| Idle | `#7f9cc4` (desaturated steel blue) | still |
| Thinking | `#66ccff` | orbit pulse, rotating sheen |
| Tool | `#ffbb44` | orbiting particles, tool-specific visual |
| AwaitingPermission | `#ffaa33` | amber halo, slow ripple |
| Compacting | `#cc88ff` | inward swirl |
| Done | `#66ffaa` | settle, then death scene for subagents |
| Error | `#ff5566` | short shake, red rim |

### Context breakdown
system `#555577` · user `#66ccff` · tool results `#ffbb44` · reasoning `#cc88ff` · subagents `#66ffaa`.

### Glass chrome
Panels are dark glass: background `rgba(8,12,24,0.94)` for floating windows, borders
`rgba(100,200,255,0.15)`, highlights `rgba(100,200,255,0.08)`. Holo tints use one base color
at fixed alphas (3, 5, 10 %) rather than scattered literals.

## Typography
Sans: Geist, falling back to system UI. Mono: Geist Mono, falling back to SF Mono and Menlo.
In the scene, labels are rendered with glyphon using the same families.

## Shapes and motifs
- **Orb agents:** a sphere with a soft contact shadow, an outer state ring, and a gentle
  rotating sheen while active. In WebGPU this is one instanced SDF quad per agent, with the
  glow done in the shader instead of canvas blur.
- **Title pill:** the full agent name in a rounded pill above the orb with a state dot.
  Wraps to two lines, never truncates. Context bar sits under it.
- **Pixel-bot mascot:** a 12×8 pixel grid with two eyes, rendered crisp (no smoothing).
  Eyes blink when thinking; the bot does small read, write, search, run and sleep actions.
- **Death scene for finished subagents:** flash and shockwave ring, then a ghost bot floats
  up and fades with sparkles, then a tombstone with "RIP", flowers and the name rises.
  Honours `prefers-reduced-motion` by jumping to the final frame.
- **Dot grid background**, rendered as a starfield layer in Phase 5.
- **Floating windows:** panels can be moved, resized and maximized, with thin themed scrollbars.

## Rules
- Glow, blur and gradients are computed in shaders, never by full-screen canvas filters.
- Animations are time-based (seconds since a state change), so render-on-demand can pause cleanly.
- Every animation has a reduced-motion variant.
