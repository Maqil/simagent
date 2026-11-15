# ADR-0001: Overall architecture

- Status: accepted
- Date: 2026-11-14

## Context
We want a mission-control app for Claude Code that can *see* sessions live, *inspect*
what they touch, and *control* them (approve tools, prompt, interrupt), replacing the
terminal. An earlier TypeScript/Canvas 2D prototype proved the idea but cannot
control sessions and struggles with rendering cost. The author wants to learn Rust and WebGPU.

## Decision
1. **Rust Cargo workspace** with four crates:
   `sim-core` (pure logic, wasm-compatible), `sim-protocol` (wire types),
   `sim-server` (tokio + axum), `sim-render` (wgpu compiled to wasm).
2. **One local server** (`simagent` binary) bound to 127.0.0.1. It ingests two sources,
   transcript files and Claude Code HTTP hooks, and normalizes both into `sim_core::Event`.
3. **Permission broker** in the server holds `PermissionRequest` hooks on a `oneshot`
   channel until the UI decides, with a timeout that returns *no decision* so Claude Code
   falls back to its own terminal dialog.
4. **Browser UI** (Vite + React + TS) served by the binary. Text-heavy panels stay in the
   DOM; the agent scene is a WebGPU canvas rendered by `sim-render`.
5. **TS driver sidecar** wraps the Claude Agent SDK (no official Rust SDK) for app-driven
   sessions, speaking JSON-lines over stdio.
6. **SQLite** (sqlx) for history and replay.

## Alternatives considered
- **Tauri desktop app:** WebKitGTK's WebGPU support on Linux is weak; a browser tab in
  Chrome/Edge gives us WebGPU everywhere with less packaging work.
- **Full-Rust UI (egui/leptos):** text-heavy panels (diffs, messages, editors) are far
  better served by the DOM ecosystem (CodeMirror, virtualization).
- **Node server:** would reuse prototype ideas faster but defeats the learning goal and
  gives weaker guarantees for the broker's concurrency.
- **Canvas 2D or WebGL directly from TS:** simpler, but cannot meet the budgets
  (50 agents, 5k files, 100k events at 60 fps) without the instancing WebGPU gives us.

## Consequences
- Two languages in the repo (Rust, TS); wire types are generated from Rust (`ts-rs`) to
  keep them in sync.
- sim-core must stay IO-free; enforced by a wasm32 check in `just check`.
- The broker's fallback rule means simagent can never make Claude Code worse than the terminal.
