# 00 · System overview

## Purpose
simagent is live mission control for Claude Code. It shows every agent and subagent as an
animated scene plus a timeline, lets you inspect every file, diff, image and command a session
touches, and lets you control sessions (approve tools, prompt, interrupt, resume) from the
browser instead of the terminal.

## Responsibilities
| Component | Language | Responsibility |
|---|---|---|
| `sim-core` | Rust (native + wasm32) | Event model, tolerant transcript parser, `SessionState` machine, token/cost accounting, subagent tree. No IO. |
| `sim-protocol` | Rust | Versioned wire types for server and UI; generates TypeScript types. |
| `sim-server` | Rust (tokio, axum) | Ingest (transcript tailing, session discovery, hook endpoint), permission broker, workspace watcher and file serving, SQLite history, WebSocket hub. Ships as the `simagent` binary with the web build embedded. |
| `sim-render` | Rust (wgpu → wasm) | WebGPU scene: agents, file galaxy, tool visuals, GPU timeline, minimap, picking. |
| `web/` | TS (Vite, React) | DOM panels: session tabs, messages, approval card, diffs, files, images, chat input. Usage page (all-transcript token/cost totals). Hosts the WebGPU canvas. |
| `driver/` | TS (Node/Bun) | Sidecar around the Claude Agent SDK for app-driven sessions. |

## Interfaces
| Boundary | Transport | Direction |
|---|---|---|
| Claude Code → server | Transcript files `~/.claude/projects/*/*.jsonl` (tailed) | in |
| Claude Code → server | HTTP hooks `POST /hooks/:event`, token header; `PermissionRequest` waits for a decision | in/out |
| Driver ↔ server | JSON-lines over the sidecar's stdio | both |
| Server ↔ browser | WebSocket: snapshot on connect, then deltas; client sends decisions and prompts | both |
| Browser → server | HTTP GET for files/images from allowlisted roots | in/out |
| Browser → server | `GET /api/usage?days=N`, token header: token/cost totals across all transcripts ([01-usage](01-usage.md)) | in/out |
| web ↔ sim-render | wasm-bindgen calls in the same page | both |

Two public types exist so far: `sim_core::SessionId` (newtype id) and
`sim_protocol::Hello` (first WS message, carries `PROTOCOL_VERSION`).

## Data flow
1. Claude Code appends records to a transcript and fires hooks.
2. Ingest turns both into `sim_core::Event`s. Both sources produce the same `Event`, so
   nothing downstream cares where a session came from. At startup only the
   `--startup-sessions` (default 3) most recently modified sessions are tailed. A session
   that changes later is picked up then, and the browser can load any other one with
   `ClientMsg::OpenSession`, which sends its transcript paths down the same channel the
   file watcher uses (ADR-0003).
3. sim-core folds events into `SessionState` and metrics; the server persists events to SQLite.
4. The WebSocket hub sends a snapshot to each new client, then deltas.
5. A `PermissionRequest` hook parks on a `oneshot` channel in the broker. The UI's decision
   completes it. On timeout or with no UI connected the broker returns *no decision* and
   Claude Code shows its normal terminal prompt. If Claude Code abandons the hook request
   (Esc, its own hook timeout), a drop guard still emits `PermissionResolved::FellBack`
   so the UI card clears.
6. The UI updates DOM panels and pushes scene changes into sim-render, which redraws only on change.

## Key design decisions
- One Rust server, browser UI, DOM for text, WebGPU for the scene, TS sidecar for the SDK:
  [ADR-0001](../adr/0001-architecture.md).
- sim-core stays IO-free so it runs in both server and browser (checked by `just wasm-core`).
- Fail open to the terminal: simagent can never leave a session worse off than without it.
- Loopback-only binding and a token on hooks/WS (see `11-security.md`, Phase 3).

## Rust concepts used
- **Cargo workspace** with shared `[workspace.dependencies]` and `[workspace.lints]`
  (see `docs/learning/cargo-workspaces.md`).
- **Newtype pattern** for ids (`crates/sim-core/src/ids.rs`).
- **lib + bin split** in sim-server so the router is testable in-process.
- Later: async tasks and channels (Phase 2), oneshot channels (Phase 3), wgpu (Phase 5).

## Diagram
Colors: blue = Rust crate, green = TS/JS, grey = external system, cylinders = data stores,
dashed edges = async channels / streams.

```xml
<mxfile host="drawio">
  <diagram id="overview" name="System overview">
    <mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" page="1">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="claude-code" value="Claude Code (terminal sessions)" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="200" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="transcripts" value="~/.claude/projects/*.jsonl" style="shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=12;fillColor=#f5f5f5;strokeColor=#666666;" vertex="1" parent="1">
          <mxGeometry x="40" y="160" width="200" height="80" as="geometry"/>
        </mxCell>
        <mxCell id="driver" value="driver/ (TS sidecar, Claude Agent SDK)" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
          <mxGeometry x="900" y="40" width="220" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="workspace-fs" value="Workspace + /tmp files" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;" vertex="1" parent="1">
          <mxGeometry x="900" y="160" width="220" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="sim-server" value="sim-server (tokio + axum)" style="rounded=1;whiteSpace=wrap;html=1;fillColor=none;dashed=1;verticalAlign=top;align=left;spacingLeft=8;strokeColor=#999999;" vertex="1" parent="1">
          <mxGeometry x="300" y="300" width="560" height="300" as="geometry"/>
        </mxCell>
        <mxCell id="ingest" value="ingest: tailer, discovery, POST /hooks/:event" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="320" y="340" width="240" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="sim-core" value="sim-core: Event, parser, SessionState, cost" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="600" y="340" width="240" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="broker" value="permission broker (oneshot + timeout)" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="320" y="440" width="240" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="workspace" value="workspace watcher, diffs, file serving" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="600" y="440" width="240" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="ws" value="WebSocket hub (snapshot + deltas)" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="460" y="530" width="240" height="50" as="geometry"/>
        </mxCell>
        <mxCell id="sqlite" value="SQLite history" style="shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=12;fillColor=#f5f5f5;strokeColor=#666666;" vertex="1" parent="1">
          <mxGeometry x="900" y="500" width="160" height="90" as="geometry"/>
        </mxCell>
        <mxCell id="sim-protocol" value="sim-protocol (wire types, ts-rs)" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="40" y="520" width="200" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="browser" value="Browser (Chrome / Edge)" style="rounded=1;whiteSpace=wrap;html=1;fillColor=none;dashed=1;verticalAlign=top;align=left;spacingLeft=8;strokeColor=#999999;" vertex="1" parent="1">
          <mxGeometry x="300" y="660" width="560" height="160" as="geometry"/>
        </mxCell>
        <mxCell id="web" value="web/ Vite + React: tabs, messages, approvals, diffs, chat" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
          <mxGeometry x="320" y="700" width="250" height="90" as="geometry"/>
        </mxCell>
        <mxCell id="sim-render" value="sim-render (wgpu -&gt; wasm): scene, timeline, galaxy" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="590" y="700" width="250" height="90" as="geometry"/>
        </mxCell>
        <mxCell id="edge-cc-transcripts" value="writes" style="endArrow=block;html=1;" edge="1" parent="1" source="claude-code" target="transcripts">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-cc-hooks" value="HTTP hooks" style="endArrow=block;html=1;" edge="1" parent="1" source="claude-code" target="ingest">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-transcripts-ingest" value="tail" style="endArrow=block;html=1;" edge="1" parent="1" source="transcripts" target="ingest">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-driver-ingest" value="JSON-lines stdio" style="endArrow=block;dashed=1;html=1;" edge="1" parent="1" source="driver" target="ingest">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-ingest-core" value="raw records" style="endArrow=block;html=1;" edge="1" parent="1" source="ingest" target="sim-core">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-ingest-broker" value="PermissionRequest" style="endArrow=block;dashed=1;html=1;" edge="1" parent="1" source="ingest" target="broker">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-fs-workspace" value="notify events" style="endArrow=block;dashed=1;html=1;" edge="1" parent="1" source="workspace-fs" target="workspace">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-core-ws" value="state deltas" style="endArrow=block;dashed=1;html=1;" edge="1" parent="1" source="sim-core" target="ws">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-core-sqlite" value="persist events" style="endArrow=block;html=1;" edge="1" parent="1" source="sim-core" target="sqlite">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-broker-ws" value="pending approvals" style="endArrow=block;dashed=1;html=1;" edge="1" parent="1" source="broker" target="ws">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-ws-web" value="WebSocket" style="endArrow=block;html=1;" edge="1" parent="1" source="ws" target="web">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-web-broker" value="decision" style="endArrow=block;html=1;" edge="1" parent="1" source="web" target="broker">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-web-render" value="scene updates (wasm)" style="endArrow=block;html=1;" edge="1" parent="1" source="web" target="sim-render">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="edge-protocol-ws" value="types" style="endArrow=block;html=1;" edge="1" parent="1" source="sim-protocol" target="ws">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```
