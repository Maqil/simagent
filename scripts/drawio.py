"""Tiny helper to emit uncompressed draw.io XML with consistent styling.

Used to generate docs/diagrams/*.drawio so the architecture docs and diagram files stay
identical. Run: python3 scripts/drawio.py <name> > docs/diagrams/<name>.drawio
"""

from xml.sax.saxutils import quoteattr

STYLES = {
    "rust": "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;",
    "ts": "rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;",
    "ext": "rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;",
    "store": "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=12;fillColor=#f5f5f5;strokeColor=#666666;",
    "group": "rounded=1;whiteSpace=wrap;html=1;fillColor=none;dashed=1;verticalAlign=top;align=left;spacingLeft=8;strokeColor=#999999;",
}
EDGE = "endArrow=block;html=1;"
ASYNC = "endArrow=block;dashed=1;html=1;"


def diagram(did: str, name: str, nodes, edges) -> str:
    out = [
        '<mxfile host="drawio">',
        f'  <diagram id="{did}" name="{name}">',
        '    <mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" page="1">',
        "      <root>",
        '        <mxCell id="0"/>',
        '        <mxCell id="1" parent="0"/>',
    ]
    for nid, label, kind, x, y, w, h in nodes:
        out.append(
            f'        <mxCell id="{nid}" value={quoteattr(label)} style="{STYLES[kind]}" vertex="1" parent="1">'
        )
        out.append(f'          <mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/>')
        out.append("        </mxCell>")
    for eid, src, dst, label, is_async in edges:
        style = ASYNC if is_async else EDGE
        out.append(
            f'        <mxCell id="{eid}" value={quoteattr(label)} style="{style}" edge="1" parent="1" source="{src}" target="{dst}">'
        )
        out.append('          <mxGeometry relative="1" as="geometry"/>')
        out.append("        </mxCell>")
    out += ["      </root>", "    </mxGraphModel>", "  </diagram>", "</mxfile>"]
    return "\n".join(out) + "\n"


def overview() -> str:
    nodes = [
        ("claude-code", "Claude Code (terminal sessions)", "ext", 40, 40, 200, 60),
        ("transcripts", "~/.claude/projects/*.jsonl", "store", 40, 160, 200, 80),
        ("driver", "driver/ (TS sidecar, Claude Agent SDK)", "ts", 900, 40, 220, 60),
        ("workspace-fs", "Workspace + /tmp files", "ext", 900, 160, 220, 60),
        ("sim-server", "sim-server (tokio + axum)", "group", 300, 300, 560, 300),
        ("ingest", "ingest: tailer, discovery, POST /hooks/:event", "rust", 320, 340, 240, 60),
        ("sim-core", "sim-core: Event, parser, SessionState, cost", "rust", 600, 340, 240, 60),
        ("broker", "permission broker (oneshot + timeout)", "rust", 320, 440, 240, 60),
        ("workspace", "workspace watcher, diffs, file serving", "rust", 600, 440, 240, 60),
        ("ws", "WebSocket hub (snapshot + deltas)", "rust", 460, 530, 240, 50),
        ("sqlite", "SQLite history", "store", 900, 500, 160, 90),
        ("sim-protocol", "sim-protocol (wire types, ts-rs)", "rust", 40, 520, 200, 60),
        ("browser", "Browser (Chrome / Edge)", "group", 300, 660, 560, 160),
        ("web", "web/ Vite + React: tabs, messages, approvals, diffs, chat", "ts", 320, 700, 250, 90),
        ("sim-render", "sim-render (wgpu -> wasm): scene, timeline, galaxy", "rust", 590, 700, 250, 90),
    ]
    edges = [
        ("edge-cc-transcripts", "claude-code", "transcripts", "writes", False),
        ("edge-cc-hooks", "claude-code", "ingest", "HTTP hooks", False),
        ("edge-transcripts-ingest", "transcripts", "ingest", "tail", False),
        ("edge-driver-ingest", "driver", "ingest", "JSON-lines stdio", True),
        ("edge-ingest-core", "ingest", "sim-core", "raw records", False),
        ("edge-ingest-broker", "ingest", "broker", "PermissionRequest", True),
        ("edge-fs-workspace", "workspace-fs", "workspace", "notify events", True),
        ("edge-core-ws", "sim-core", "ws", "state deltas", True),
        ("edge-core-sqlite", "sim-core", "sqlite", "persist events", False),
        ("edge-broker-ws", "broker", "ws", "pending approvals", True),
        ("edge-ws-web", "ws", "web", "WebSocket", False),
        ("edge-web-broker", "web", "broker", "decision", False),
        ("edge-web-render", "web", "sim-render", "scene updates (wasm)", False),
        ("edge-protocol-ws", "sim-protocol", "ws", "types", False),
    ]
    return diagram("overview", "System overview", nodes, edges)


if __name__ == "__main__":
    import sys

    print({"00-overview": overview}[sys.argv[1]](), end="")
