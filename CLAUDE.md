# simagent: working rules for Claude

simagent is a live mission-control app for Claude Code sessions: a Rust server plus a
WebGPU/DOM web UI. It sees agents live, inspects everything a session touches, and controls
sessions (approvals, prompts, interrupts) so the terminal is no longer needed.

It is a standalone, original project. Don't mention or copy code from other visualizers.

## Git: never commit or push
- Claude must NEVER run `git commit`, `git push`, `git tag`, or anything that rewrites
  history or talks to a remote. The user commits and pushes themselves.
- Claude may edit files and run read-only git commands (`status`, `diff`, `log`).
- When work is ready, say which files changed and suggest a commit message; don't run it.

## How to work
- The user does not write code; they learn Rust and WebGPU by reviewing yours.
- Small, focused steps: one change per turn, compiled and tested before moving on.
- Start each phase in plan mode; the user approves the plan first.
- After each change add a **Rust notes** section: concepts used with file:line pointers,
  why it's written that way and the alternative, and any compiler error you hit.
- The first time a major concept appears, add an explainer with a minimal example in `docs/learning/`.
- End of phase: 5-question quiz and a one-page recap in `docs/learning/phase-N.md`.
- Use the `rust-engineer` and `coding-guidelines` skills for all Rust work and reviews.

## Definition of done
1. `just check` passes (fmt, clippy pedantic `-D warnings`, nextest, cargo doc, sim-core wasm32 check, diagram check).
2. New logic has tests; parser/state use `insta` snapshots against `fixtures/sessions/`.
3. The matching `docs/architecture/NN-*.md` and its draw.io diagram are updated in the same change,
   with an identical copy in `docs/diagrams/NN-*.drawio`.
4. Architecture changes get an ADR in `docs/adr/`.
5. A short explanation plus "Rust notes".

## Diagram rules
Uncompressed draw.io XML in a fenced `xml` block; `<mxfile>` > `<diagram>` > `<mxGraphModel>`;
readable cell ids; `vertex="1"`/`edge="1"` with `parent="1"`. Rust crates `fillColor=#dae8fc`,
TS/JS `#d5e8d4`, external systems `#f5f5f5`, data stores as cylinders, async channels dashed.
Sequence layouts in `10-flows.md`, component layouts elsewhere.

## Hard rules
- Edition 2024, stable. No `unsafe`. No `unwrap`/`expect` outside tests.
- sim-core: no tokio, axum, wgpu or filesystem; must build for wasm32.
- Unknown transcript/hook fields never crash parsing: skip and log.
- Server binds 127.0.0.1 only; token header required on hooks and WS.
- File serving only from allowlisted roots (session cwd, /tmp, ~/.claude); reject traversal.
- UI absent or permission timeout: return no decision so Claude Code falls back to the terminal.
- Renderer: instanced draws, render on change only, no per-frame allocations.
- Text-heavy UI stays in the DOM.

## Layout
`crates/sim-core` pure logic · `crates/sim-protocol` wire types · `crates/sim-server` server + `simagent` bin ·
`crates/sim-render` wgpu/wasm · `driver/` TS Agent SDK sidecar · `web/` Vite+React UI ·
`fixtures/sessions/` scrubbed transcripts · `docs/{architecture,diagrams,adr,learning,design}`.

## Roadmap
0 setup · 1 sim-core · 2 live stream + web · 3 hooks and approvals · 4 files/diffs/images ·
5 WebGPU renderer · 6 driving sessions · 7 polish. Don't start a phase before the previous one is done.
