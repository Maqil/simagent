# ADR-0003: Load the most recent sessions at startup, others on demand

- Status: accepted
- Date: 2026-11-15

## Context
At startup the server tailed every transcript modified within a time window (first 120
minutes, then 30). With several Claude Code sessions a day, plus a transcript per
subagent, that meant parsing many files before the UI was useful, and the header filled
with tabs. The user wants the few most recent sessions shown at once, and any other one
opened only when they ask for it.

## Decision
- Startup loads the **N most recently modified sessions** (`--startup-sessions`, default
  3), each with its subagent transcripts, instead of a time window.
- After startup, any transcript that changes is picked up as before (file watcher, plus
  a poll fallback that now looks only at files modified since the server started).
- The browser can ask for another session with `ClientMsg::OpenSession { session }`. The
  server resolves the session's transcript paths and sends them down the **same channel
  the file watcher uses**, so `Tailer::poke` loads them exactly like a changed file. The
  session then reaches every browser through normal hub updates; there is no new reply
  message.

## Alternatives considered
- **Keep a time window, just shorter.** Still unbounded on a busy hour, and a window
  that is too short shows nothing after a break.
- **A separate "load session" path that parses a file and pushes events into the hub.**
  It would duplicate the tailer, and then that session would need handing over to the
  tailer for live updates, with a race between the two readers. Reusing the watcher
  channel keeps one reader on one thread.
- **Load everything lazily, even the first sessions.** The UI would open empty; seeing
  the latest work immediately is the point of the app.

## Consequences
- Startup cost is bounded by N sessions, not by how busy the last hour was.
- An opened session stays tracked until the server restarts. Closing its tab only hides
  it, as before.
- `--active-within-mins` is gone. Scripts that passed it must use `--startup-sessions`.
- The demo sets N to `usize::MAX` so its whole scripted directory loads.
