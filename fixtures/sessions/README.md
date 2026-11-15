# Session fixtures

Real Claude Code transcripts (`~/.claude/projects/<project>/<uuid>.jsonl`), scrubbed, used by
sim-core snapshot tests. Wanted scenarios, one file each:

| File | Scenario |
|---|---|
| `simple.jsonl` | Short session: prompt, a few reads/edits, done |
| `subagents.jsonl` (+ `subagents/` dir) | Task/Agent tool spawning subagents |
| `compaction.jsonl` | A session that compacted context |
| `errors.jsonl` | Failing tool calls (non-zero bash, bad edit) |
| `denials.jsonl` | Permission requests the user denied |
| `images.jsonl` | Pasted or read images |
| `long.jsonl` | A long, multi-hour session (perf) |

## Scrubbing rules
- Replace your home path with `/home/user` and project names with neutral names.
- Remove secrets, tokens, emails and private file contents; keep the JSON structure.
- Keep every record type and unknown field: the parser must tolerate them.
- Do not reformat lines; one JSON object per line exactly as Claude Code wrote it.
