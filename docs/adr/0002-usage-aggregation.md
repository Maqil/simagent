# ADR-0002: Usage aggregation across all transcripts

- Status: proposed
- Date: 2026-11-15

## Context
The Usage page needs token and cost totals across every Claude Code transcript on disk.
That can be hundreds of MB and keeps growing, and the page polls every 60 s. Transcripts are
append-only JSONL. Prices differ per model version, and cache reads and 1-hour cache writes
are priced differently from input. A flat 1.25× write rate undercounted, because Claude Code
writes 1-hour cache entries. The real Pro/Max quota and the real bill are not on disk.

## Decision
- A dedicated `GET /api/usage?days=N` endpoint backed by an in-memory `UsageCache` keyed by
  transcript path. Per file it keeps the byte offset, its `TranscriptParser` (dedupe set) and
  hour buckets. Each request reads only new complete lines, inside `spawn_blocking`.
  Rewritten files (shrunk, same size with a new mtime, or mtime gone backwards) are
  reparsed, and deleted files are forgotten.
- Return hour buckets (UTC hour, model, subagent) so the browser can group by local day and
  re-slice ranges without refetching.
- Price per model *version*, matched most-specific-first, with an explicit cache-read price,
  5-minute writes at 1.25× input, 1-hour writes at 2× input, and an optional long-prompt tier.
- Be honest about the numbers: dollars are labelled *API-equivalent*, and 5-hour windows are
  labelled *estimated*.

## Alternatives considered
- **Aggregate in the live WebSocket hub.** It only sees recently active sessions, so history
  would be missing.
- **Full reparse on every request.** Simple, but too slow on hundreds of MB every 60 s.
- **SQLite usage store.** Survives restarts, but means a schema, migrations and write-path
  coupling. Could come back in Phase 7 if startup scans get slow.
- **One flat price per model family.** Wrong when versions change price and when cache
  traffic dominates.

## Consequences
- After the first scan, requests are cheap. The first request after startup pays a full scan.
- Memory grows with the number of transcripts × active hours; buckets are small.
- Correctness depends on transcripts being append-only. A rewrite is detected when the file
  shrinks, its mtime goes backwards, or its mtime changes while the size stays the same; a
  rewrite that both grows the file and keeps the old prefix's offset is indistinguishable from
  an append (Claude Code never does this).
- The pricing table must be kept up to date when models change.
