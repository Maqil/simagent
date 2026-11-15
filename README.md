# simagent

Live mission control for Claude Code sessions. A Rust server ingests transcripts and hooks,
brokers permission requests, and streams state to a web UI with a WebGPU agent scene.

Status: working MVP. Live view of all Claude Code sessions, subagent tree, activity feed,
files, timeline, cost, and browser approvals for permission requests.

## Try it without a real session
```sh
just demo                # opens http://127.0.0.1:7420 (the URL is also printed)
just demo-loop           # 2x speed, repeats forever (good while changing visuals)
```
The demo writes realistic transcripts to a temp dir in real time: a prompt, thinking,
reads, writes, a failing test, two parallel subagents, a follow-up message, results,
notifications, compaction, and a real permission request. Press A, D or E on the
approval card to steer the ending. The demo runs on port 7420 so it works next to your
real simagent on 7410; the browser opens by itself, and the full URL (with the token) is
printed in the terminal. Options: `--speed 3`, `--loop`, `--dir <path>` to keep the files,
`--port`, `--no-open`. Afterwards, open History to replay the session you just watched.

## Run it
```sh
just app                 # builds web + release binary, opens http://127.0.0.1:7410/?token=...
just hooks-install       # optional: enables live approvals and hook events (backs up settings.json)
```
Without hooks the app still shows every session from `~/.claude/projects` transcripts.
With hooks, a `PermissionRequest` waits for your decision in the browser (A allow, D deny,
E edit). If no browser is connected, or nobody decides within 120 s, Claude Code falls back to
its normal terminal prompt. Undo with `./target/release/simagent hooks uninstall`.

**Chat with a session:** the Messages tab has a message box. Sending continues that
session with Claude Code in its folder (`claude -p --resume`), and the reply streams into
the conversation and the scene. Tools that need approval show the approval card. Stop
ends the turn. Set `SIMAGENT_CLAUDE` if `claude` is not on your PATH.

Other commands: `simagent replay <file.jsonl>` prints a session timeline;
`simagent hooks print` shows the hooks JSON; `just web-dev` runs the UI with hot reload
(proxying to a running server); open `/?demo=1` for a scripted demo without a server.

## Requirements
Rust stable (rustup, with the wasm32 target), Node + pnpm, `just`, `cargo-nextest`.

## Development
```sh
just check     # fmt, clippy pedantic -D warnings, tests, docs, wasm check, diagram check
bacon          # live clippy while editing
```

