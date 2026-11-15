# Lessons from an earlier prototype

The user built an earlier TypeScript prototype (Canvas 2D) before starting this
project. We read it for behaviour and visuals only; simagent shares no code with it.
Each lesson below becomes a requirement or a warning for our own design.

## Data sources
| Earlier prototype | Lesson for simagent |
|---|---|
| Tails `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`; rescans every 1s, `fs.watch` plus a 3s poll fallback | Use `notify` with a poll fallback, but async and event-driven, not a blocking scan loop |
| Session is "active" if touched in the last 10 min; inactive after 5 min idle; evicted after 30 min | Keep these as configurable thresholds in sim-core, with time passed in as data |
| Subagents in `<uuid>/subagents/`, including workflows | Discovery must watch the subagent dir and attach children to the parent tree |
| Handles partial last lines and file relocation for worktrees | Tailer buffers incomplete lines; session identity is the uuid, not the path |
| Hook server on 127.0.0.1: SessionStart, PreToolUse, PostToolUse, SubagentStart/Stop, Stop | Same hooks plus `PermissionRequest`, which the prototype lacked, so we can actually decide |
| Permission prompts *guessed* after a tool is pending 5s | Replace the guess with the real `PermissionRequest` hook; keep the heuristic only for sessions without hooks |
| Transcript record types: user, assistant, system (compact_boundary, turn_duration, stop_hook_summary), progress, cost-state, ai-title, permission-mode | Parser must handle all of these and skip unknown types with a log line |
| Content blocks: text, thinking, tool_use, tool_result | Map to Event variants; pair tool_use and tool_result by `ToolUseId` |

## Event kinds (inspiration for `sim_core::Event`)
agent_spawn, agent_complete, agent_idle, message, context_update, model_detected,
tool_call_start/end, subagent_dispatch/return, permission_requested, permission_decision,
error, session_stats, turn_complete, compaction.

Lesson: the prototype used a string `type` and an untyped `payload: Record<string, unknown>`
with many optional fields. We use a Rust enum with one typed struct per variant, so
"optional field may be missing" becomes `Option<T>` checked by the compiler.

## State rules
- Agent states: idle, thinking, tool_calling, complete, error, paused, waiting_permission.
  Ours: Idle / Thinking / Tool / AwaitingPermission / Compacting / Done / Error.
- A message moves the agent to thinking; an idle event moves tool or waiting agents back to idle.
- Finished subagents fade out and are removed; we keep them in history and show the death scene.
- Cost uses a per-model-family table (context size and rates); ours is a typed table in sim-core.

## UI panels worth having
Session tabs, message feed, chat input, timeline, metrics, history browser, debug log,
file attention, agent detail card, command palette, top bar, control bar, minimap, and
movable/resizable windows.

## Performance problems to avoid
These come from reading the code, not from profiling.

| Problem in the prototype | Our approach |
|---|---|
| Full-screen `ctx.filter = blur()` bloom plus a canvas copy every frame | Glow in the fragment shader via SDF falloff; optional half-resolution bloom pass |
| `shadowBlur` and new radial gradients per agent per frame | One instanced draw for all agents; no per-frame allocation |
| Two separate `requestAnimationFrame` loops | One loop in sim-render, idle when nothing animates |
| Copying all Maps on every event | State lives in Rust; the UI receives small deltas |
| Synchronous `readdirSync`/`readSync` scans every second, worse in all-projects mode | Async discovery driven by filesystem events |
| Rendering every frame even when idle | Render on change; zero redraws when idle |

## Keep / change / drop
| Feature | Decision | Note |
|---|---|---|
| Holographic look, state colors, orb nodes | Keep | Re-specified in `docs/design/visual-identity.md` |
| Pixel-bot mascot, name pills, death animation | Keep | Rebuilt for WebGPU and DOM |
| Movable/resizable windows | Keep | DOM, ported as behaviour |
| d3-force layout | Change | Simple force layout in Rust, deterministic for tests |
| Canvas 2D renderer | Change | wgpu instanced renderer |
| Permission detection by timeout | Change | Real `PermissionRequest` hook through the broker |
| SSE relay | Change | WebSocket with snapshot plus deltas |
| VS Code extension host | Drop | Standalone binary and browser tab |
| Codex session support | Drop for now | Revisit after Phase 7 |
