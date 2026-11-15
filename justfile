# simagent task runner. `just` lists recipes; `just check` is the definition-of-done gate.

# Homebrew's rustup is keg-only, so cargo isn't on PATH by default. Prepend its bin dir and
# ~/.cargo/bin (cargo-installed tools like nextest) so recipes work from any shell.
export PATH := "/opt/homebrew/opt/rustup/bin:" + env_var("HOME") + "/.cargo/bin:" + env_var("PATH")

default:
    @just --list

# Format all Rust code.
fmt:
    cargo fmt --all

# Lint with clippy (pedantic at warn, all warnings are errors).
clippy:
    cargo clippy --workspace --all-targets -- -D warnings

# Run tests with nextest.
test:
    cargo nextest run --workspace --no-tests=pass

# Build docs; any rustdoc warning fails.
doc:
    RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps

# sim-core must stay IO-free and compile for the browser.
wasm-core:
    cargo check -p sim-core --target wasm32-unknown-unknown

# Every ```xml block in docs/architecture must match its docs/diagrams copy and parse.
diagrams-check:
    python3 scripts/check_diagrams.py

# The full gate: run before calling any change done.
check:
    cargo fmt --all -- --check
    just clippy
    just test
    just doc
    just wasm-core
    just diagrams-check

# Run the server locally.
run *ARGS:
    cargo run -p sim-server -- {{ARGS}}

# Install web UI dependencies.
web-install:
    pnpm -C web install

# Run the web UI dev server (proxies /ws, /api, /hooks to 127.0.0.1:7410).
web-dev:
    pnpm -C web dev

# Typecheck and build the web UI into web/dist.
web-build:
    pnpm -C web build

# Build the web UI and a release binary with it embedded.
build:
    pnpm -C web install --frozen-lockfile
    pnpm -C web build
    cargo build --release -p sim-server

# Build everything and launch the app (opens the browser).
app *ARGS: build
    ./target/release/simagent serve {{ARGS}}

# Install simagent hooks into ~/.claude/settings.json (backs it up first).
hooks-install:
    cargo run -q --release -p sim-server -- hooks install

# Test bench: the real server plus a scripted ~3 min session (subagents, messages, an
# approval, an error, compaction) written to a temp dir. No real Claude Code needed.
demo *ARGS: build
    ./target/release/simagent demo {{ARGS}}

# Same, fast and on repeat: good for watching visuals while changing them.
demo-loop: build
    ./target/release/simagent demo --speed 2 --loop
