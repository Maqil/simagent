---
name: coding-guidelines
description: Core Rust coding guidelines for simagent - naming, API design, documentation, lints, safety and project rules. Use alongside rust-engineer whenever writing or reviewing Rust, and for the end-of-phase review pass.
---

# coding-guidelines

## Naming (Rust API Guidelines)
- Types and traits `UpperCamelCase`; functions, modules, variables `snake_case`;
  constants `SCREAMING_SNAKE_CASE`.
- Conversions: `as_*` cheap borrow, `to_*` expensive or owned, `into_*` consumes self.
- Getters have no `get_` prefix: `fn name(&self)`.
- Iterator methods: `iter`, `iter_mut`, `into_iter`.
- Acronyms are words: `WsClient`, `HttpHook`, not `WSClient`.

## API design
- Make illegal states unrepresentable: enums, newtypes, and constructors that validate.
- Keep fields private when an invariant exists; expose methods instead.
- Accept generic inputs (`impl AsRef<Path>`, `impl Into<String>`) at boundaries; keep internals concrete.
- Implement common traits: `Debug`, `Display` for user-facing types, `From` for error conversion, `Default` when there is an obvious default.
- Avoid `pub` by default. Use `pub(crate)` for crate-internal sharing.

## Documentation
- Every public item has a doc comment saying what it is *and why it exists or is shaped that way*.
- Each crate root has a `//!` overview naming its responsibility and its boundaries.
- Add `# Errors` to fallible public functions and `# Panics` if one can panic.
- `cargo doc` with `-D warnings` must pass; intra-doc links must resolve.

## Lints and formatting
- Edition 2024, stable toolchain, `rustfmt` defaults plus `max_width = 100`.
- Workspace lints: `unsafe_code = forbid`, `missing_docs = warn`, `clippy::pedantic = warn`,
  `unwrap_used`/`expect_used`/`print_stdout`/`dbg_macro = warn`. CI runs with `-D warnings`.
- An `#[allow(...)]` sits on the smallest item possible with a comment explaining why.

## Safety and robustness
- No `unsafe`. No panics on external input: transcripts, hook bodies, WS messages and file paths are untrusted.
- Slice by `.get(..)`, not `[..]`, when indices come from data.
- Bound everything that grows: channel capacity, read sizes, file preview sizes, history length.
- Paths from clients are canonicalized and checked against allowlisted roots before use.

## Project rules (simagent)
- sim-core never depends on tokio, axum, wgpu or the filesystem.
- Server binds to 127.0.0.1 only; hooks and WS require the token header.
- On UI absence or timeout, the permission broker returns *no decision* so Claude Code
  falls back to its terminal prompt. Never block a session indefinitely.
- Renderer: instanced draws, render only on change, no per-frame allocations.
- Text-heavy UI stays in the DOM.
- Original code only; never copy code from other projects.
- Docs and draw.io diagrams change in the same commit as the code they describe.

## End-of-phase review pass
Go crate by crate and report findings as a list with file:line, then fix them:
1. Lints clean, docs complete, no stray `allow`s.
2. Errors typed in libs, contextual in bins, no panics on input.
3. Ownership: needless clones, owned params, allocations in loops.
4. Concurrency: locks across await, missing timeouts, unbounded channels.
5. Tests cover new logic; snapshots reviewed, not blindly accepted.
6. Architecture docs and diagrams match the code.
