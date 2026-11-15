---
name: rust-engineer
description: Idiomatic Rust for simagent. Use for writing or reviewing any Rust in crates/ - ownership and borrowing, traits, enums, error handling with thiserror/anyhow, async with tokio and axum, channels, tracing, testing with insta, and wasm32 constraints for sim-core and sim-render.
---

# rust-engineer

Apply these when writing or reviewing Rust in this repo. The user is learning Rust:
explain each choice in a "Rust notes" section after the change.

## Ownership and borrowing
- Parameters borrow by default: `&str` not `String`, `&[T]` not `Vec<T>`, `&Path` not `PathBuf`.
- Take ownership (`String`, `Vec<T>`) only when the function stores the value. Use
  `impl Into<String>` for constructors that store strings.
- Every `.clone()` needs a reason: crossing a task boundary, storing a copy, or cheap
  (`Arc`, `SmolStr`, `Copy`). Otherwise restructure to borrow.
- Return borrowed views (`fn name(&self) -> &str`) instead of clones.
- Prefer iterators (`map`, `filter`, `collect`) over index loops; avoid collecting just to iterate again.

## Types and modelling
- Newtypes for every id (`SessionId`, `ToolUseId`, `AgentId`) with `#[serde(transparent)]`.
- Enums over booleans or stringly-typed fields. A state machine is an `enum`, and
  transitions are `match` expressions with no `_ =>` arm on our own enums, so adding a
  variant forces every site to be revisited.
- `#[non_exhaustive]` on public enums and structs that will grow (events, protocol messages).
- Derive what is cheap and useful: `Debug` always; `Clone, PartialEq, Eq, Hash` when meaningful.
- `#[must_use]` on pure functions and builders that return values (clippy pedantic asks for it).

## Errors
- Libraries (`sim-core`, `sim-protocol`, `sim-render`, sim-server modules): `thiserror` enums,
  one per module boundary, variants carrying context (path, line number).
- Binaries (`main.rs`, CLIs): `anyhow::Result` with `.context("what we were doing")`.
- Never `.unwrap()` / `.expect()` outside tests. Use `?`, `ok_or`, `let ... else`.
- Tolerant parsing: an unknown or malformed transcript line is logged with `tracing::warn!`
  and skipped, never a hard error for the whole file.

## Async (tokio + axum)
- One task per long-running responsibility (tailer per file, broker, WS client). Tasks
  talk through channels: `mpsc` for streams, `oneshot` for one reply (permission
  decisions), `broadcast` for fan-out to WS clients, `watch` for latest-value state.
- Never hold a `std::sync::Mutex` or `tokio::sync::Mutex` guard across `.await`. Prefer
  an owning task plus messages over shared locked state.
- Every wait on something external has a timeout (`tokio::time::timeout`).
- Use `tokio::task::spawn_blocking` for blocking filesystem or SQLite work not covered by async APIs.
- Graceful shutdown via `CancellationToken` or a shutdown signal, so tasks stop cleanly.
- axum handlers stay thin: extract, call a domain function, map the error to a response.

## Logging
- `tracing` only; no `println!` except CLI output. Structured fields: `tracing::info!(session = %id, "...")`.
- `#[tracing::instrument(skip_all, fields(session = %id))]` on per-session and per-request entry points.

## wasm32 (sim-core, sim-render)
- sim-core must compile for `wasm32-unknown-unknown`: no tokio, std::fs, threads or system time.
  Time is passed in as data.
- sim-render: no per-frame allocations; reuse buffers, use instanced draws and `bytemuck` for GPU data.

## Tests
- Unit tests next to the code in `#[cfg(test)] mod tests`.
- Parser and state machine: `insta` snapshot tests over `fixtures/sessions/*.jsonl`.
- Server: build the router in-process and call it; no real ports in unit tests.
- Test names describe behaviour: `skips_unknown_record_types`, not `test_parse_2`.

## Review checklist
1. Does it compile with zero clippy warnings at pedantic, with no unjustified `#[allow]`?
2. Any `unwrap`, `expect`, `panic!`, `unsafe`, or indexing that can panic on input data?
3. Any clone, `String` parameter or allocation in a hot loop that could borrow instead?
4. Any lock held across `.await`, or an unbounded wait without a timeout?
5. Are public items documented with *why*, and is the matching architecture doc updated?
