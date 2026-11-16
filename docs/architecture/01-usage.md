# 01 · Usage

## Purpose
A top-level **Usage** page that shows token totals and API-equivalent cost across *all*
Claude Code transcripts on disk, not only the open session. Dollar figures are what the same
traffic would cost on the API; 5-hour windows are estimates, because the real Pro/Max quota
is not recorded on disk.

## Responsibilities
| Component | Language | Responsibility |
|---|---|---|
| `sim-core::cost` | Rust (native + wasm32) | Pricing table per model version, matched most-specific-first by substring (`opus-5-5` before `opus`). Each row: input, output, cache-read $/MTok, optional long-prompt tier (Haiku 5.5 ×5 above 100K prompt tokens). 5-minute cache writes cost 1.25× input, 1-hour writes 2× input. `cost_breakdown(model, &Usage) -> CostBreakdown`. |
| `sim-core::usage` | Rust (native + wasm32) | `Totals {requests, usage, cost, last_ms}`; hour buckets keyed by (UTC hour, model, subagent) in a `BTreeMap`; `five_hour_blocks`. Pure, no IO. |
| `sim-server::usage` | Rust (tokio, axum) | `UsageCache`: incremental per-file scan of transcripts, joins session metadata from `SessionCache`, serves `GET /api/usage`. |
| `sim-protocol` | Rust | `UsageReport`, `SessionUsage`, `UsageBucket`, `UsageBlock`; mirrored in `web/src/protocol.ts`. |
| `web/src/usage.ts`, `UsagePage.tsx` | TS (React) | Usage button in TopBar next to History, store `view: 'live' \| 'usage'`, 60 s polling, KPI tiles, token vs cost composition, daily stacked chart by model, current 5-hour window with burn rate and projection, by-model table, project → session table (click opens replay), weekday×hour heatmap. Demo mode uses synthetic data. |

## Interfaces
| Boundary | Transport | Direction |
|---|---|---|
| Transcripts → server | `~/.claude/projects/**/*.jsonl`, read from a saved byte offset | in |
| Browser → server | `GET /api/usage?days=N`, token header; `days` defaults to 30, clamped to `1..=365` | in/out |

`UsageReport { generated_ms, since_ms, sessions: [SessionUsage { id, project, cwd, title, live,
last_activity_ms, buckets: [UsageBucket { hour_ms, model, subagent, requests, usage, cost }] }],
blocks: [UsageBlock { start_ms, end_ms, last_activity_ms, active, requests, usage, cost }] }`.

`Usage` now carries `cache_write_1h` (a subset of `cache_write`) from
`usage.cache_creation.ephemeral_1h_input_tokens`, and `thinking` (a subset of `output`) from
`usage.output_tokens_details.thinking_tokens`.

## Data flow
1. The page polls `GET /api/usage` every 60 s (sequence in [10-flows](10-flows.md)).
2. The handler runs the scan in `spawn_blocking`. For each transcript, `UsageCache` reads only
   new complete lines after the saved offset. A file that shrank or was rewritten is reparsed;
   deleted files are forgotten.
3. Lines without `"usage"` are skipped before JSON parsing. The rest go through the file's own
   `TranscriptParser` (its dedupe set stops repeated message ids being counted twice), are
   priced with `cost_breakdown`, and are added to hour buckets. Subagent transcripts count
   toward their main session with `subagent = true`.
4. Buckets are filtered to `since_ms`, joined with `SessionCache` metadata, and
   `five_hour_blocks` is computed. A block starts at the first activity floored to the hour and
   lasts 5 h; the first activity at or after its end starts the next. Blocks are hour-aligned,
   so hour buckets give exact results.
5. The browser groups hour buckets into *local* days and re-slices 7/30/90 days without refetching.

## Key design decisions
- Incremental per-file scan with an in-memory cache behind its own endpoint:
  [ADR-0002](../adr/0002-usage-aggregation.md).
- Hour buckets rather than daily totals: the server works in UTC; only the browser knows the
  user's time zone.
- Explicit cache-read price and separate 1-hour cache-write rate. Claude Code writes 1-hour
  cache entries, so the old flat 1.25× undercounted.
- Honest labels: "API-equivalent" dollars and "estimated" windows.

## Rust concepts used
- **`BTreeMap`** with a tuple key for ordered, deterministic buckets (`sim-core/src/usage.rs`).
- **`tokio::task::spawn_blocking`** for blocking file IO off the async runtime.
- **`std::sync::Mutex`** never held across `.await`: the lock lives inside the blocking closure.
- **`Seek`/`BufRead`** to resume at a byte offset and stop at the last complete line.

## Diagram
Colors: blue = Rust crate, green = TS/JS, grey = external system, cylinders = data stores,
dashed edges = async channels / polling.

```xml
<mxfile host="drawio">
  <diagram id="usage" name="Usage aggregation">
    <mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" page="1">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="transcripts" value="~/.claude/projects/**/*.jsonl (main + subagent transcripts)" style="shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=12;fillColor=#f5f5f5;strokeColor=#666666;" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="220" height="90" as="geometry"/>
        </mxCell>
        <mxCell id="usage-scan" value="sim-server usage.rs: incremental scan (spawn_blocking)" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="340" y="50" width="240" height="70" as="geometry"/>
        </mxCell>
        <mxCell id="usage-cache" value="UsageCache (in memory): per path offset, TranscriptParser, hour buckets" style="shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=12;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="340" y="180" width="240" height="100" as="geometry"/>
        </mxCell>
        <mxCell id="session-cache" value="SessionCache (sessions.rs): project, cwd, title, live" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="40" y="200" width="220" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="sim-core-usage" value="sim-core: cost.rs pricing table, usage.rs Totals, hour buckets, five_hour_blocks" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="660" y="50" width="260" height="70" as="geometry"/>
        </mxCell>
        <mxCell id="endpoint" value="GET /api/usage?days=N (token) -&gt; UsageReport" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="660" y="200" width="260" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="sim-protocol" value="sim-protocol: UsageReport, SessionUsage, UsageBucket, UsageBlock" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="980" y="200" width="240" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="web-usage" value="web/ usage.ts + UsagePage.tsx: local-day grouping, charts, 5h window, tables" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
          <mxGeometry x="660" y="340" width="260" height="70" as="geometry"/>
        </mxCell>
        <mxCell id="edge-transcripts-scan" value="read new complete lines" style="endArrow=block;html=1;" edge="1" parent="1" source="transcripts" target="usage-scan">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-scan-cache" value="update offsets + buckets" style="endArrow=block;html=1;" edge="1" parent="1" source="usage-scan" target="usage-cache">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-scan-core" value="parse, price, bucket" style="endArrow=block;html=1;" edge="1" parent="1" source="usage-scan" target="sim-core-usage">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-cache-endpoint" value="buckets" style="endArrow=block;html=1;" edge="1" parent="1" source="usage-cache" target="endpoint">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-sessions-endpoint" value="session metadata" style="endArrow=block;html=1;" edge="1" parent="1" source="session-cache" target="endpoint">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-protocol-endpoint" value="types" style="endArrow=block;html=1;" edge="1" parent="1" source="sim-protocol" target="endpoint">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-web-endpoint" value="poll every 60s (HTTP)" style="endArrow=block;dashed=1;html=1;" edge="1" parent="1" source="web-usage" target="endpoint">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```
