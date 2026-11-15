# Cargo workspaces

**Java/TS analogy:** a workspace is like a Maven multi-module build or a pnpm monorepo.
One `Cargo.lock`, one `target/` folder, many crates.

## Crate, package, workspace
- A **crate** is one compilation unit: a library (`src/lib.rs`) or a binary (`src/main.rs`).
- A **package** is a folder with a `Cargo.toml`; it can hold one lib plus several bins.
  `sim-server` does this: `lib.rs` holds the router, and `main.rs` is the `simagent` binary.
- A **workspace** groups packages so they build together and share versions.

```toml
# Cargo.toml (root)
[workspace]
resolver = "3"                 # dependency feature resolver for edition 2024
members = ["crates/sim-core", "crates/sim-server"]

[workspace.dependencies]       # versions decided once...
serde = { version = "1", features = ["derive"] }
```

```toml
# crates/sim-core/Cargo.toml
[dependencies]
serde.workspace = true         # ...and inherited here
```

## Shared lints
`[workspace.lints]` sets compiler and clippy rules once; each crate opts in with
`[lints] workspace = true`. We forbid `unsafe`, warn on missing docs, turn on
`clippy::pedantic`, and CI promotes all warnings to errors with `-D warnings`.

`priority = -1` on `pedantic` lets individual lints placed after it override the group.

## Why lib + bin
Tests can only call into a library. Putting the router in `lib.rs` lets a test build it and
call handlers directly, while `main.rs` only parses flags and binds the socket:

```rust
// lib.rs
pub fn router() -> Router { Router::new().route("/healthz", get(healthz)) }
// main.rs
axum::serve(listener, sim_server::router()).await?;
```

## Cross-compiling one crate
`sim-core` must also run in the browser, so `just wasm-core` runs
`cargo check -p sim-core --target wasm32-unknown-unknown`. If someone adds tokio or `std::fs`
to sim-core, that check fails, which is how the rule is enforced.
