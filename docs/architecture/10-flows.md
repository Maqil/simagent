# 10 · Flows

## Purpose
Sequence diagrams for the request flows that cross components.

## Responsibilities
Each section names the participants and the order of messages. Component layouts live in the
numbered docs (`00`–`09`).

## Interfaces
- Usage request: `GET /api/usage?days=N` (see [01-usage](01-usage.md)).

## Data flow
### Usage request
1. Browser sends `GET /api/usage?days=30` with the token header.
2. The handler checks the token, clamps `days` to `1..=365` and moves the work into `spawn_blocking`.
3. The blocking task locks `UsageCache` and lists transcript files.
4. For each file it seeks to the saved offset and reads only new complete lines; a rewritten file (shrunk, or same size with a new mtime) is reparsed.
5. Lines without `"usage"` are skipped; the rest are parsed, deduped, priced and added to hour buckets. Deleted files are dropped.
6. The lock is released; buckets are joined with `SessionCache` metadata, filtered to `since_ms`, and `five_hour_blocks` runs.
7. The handler returns `UsageReport` as JSON; the browser groups it into local days.

## Key design decisions
- Blocking file IO never runs on async worker threads.
- The std `Mutex` is held only inside the blocking closure, never across `.await`.

## Rust concepts used
- `spawn_blocking` and awaiting its `JoinHandle`.

## Diagram
Sequence layout: lifelines left to right; dashed arrows are async hand-offs and replies.

```xml
<mxfile host="drawio">
  <diagram id="flow-usage" name="Usage request flow">
    <mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" page="1">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="ll-browser" value="Browser (UsagePage)" style="shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=0;collapsible=0;size=40;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="160" height="520" as="geometry"/>
        </mxCell>
        <mxCell id="ll-handler" value="axum handler /api/usage" style="shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=0;collapsible=0;size=40;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="260" y="40" width="160" height="520" as="geometry"/>
        </mxCell>
        <mxCell id="ll-blocking" value="spawn_blocking task" style="shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=0;collapsible=0;size=40;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="480" y="40" width="160" height="520" as="geometry"/>
        </mxCell>
        <mxCell id="ll-cache" value="UsageCache (Mutex)" style="shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=0;collapsible=0;size=40;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="700" y="40" width="160" height="520" as="geometry"/>
        </mxCell>
        <mxCell id="ll-files" value="~/.claude/projects transcripts" style="shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=0;collapsible=0;size=40;fillColor=#f5f5f5;strokeColor=#666666;" vertex="1" parent="1">
          <mxGeometry x="920" y="40" width="160" height="520" as="geometry"/>
        </mxCell>
        <mxCell id="msg-get" value="1. GET /api/usage?days=30 + token" style="endArrow=block;html=1;" edge="1" parent="1">
          <mxGeometry relative="1" as="geometry">
            <mxPoint x="120" y="120" as="sourcePoint"/>
            <mxPoint x="340" y="120" as="targetPoint"/>
          </mxGeometry>
        </mxCell>
        <mxCell id="msg-spawn" value="2. check token, clamp days 1..=365, spawn_blocking" style="endArrow=block;dashed=1;html=1;" edge="1" parent="1">
          <mxGeometry relative="1" as="geometry">
            <mxPoint x="340" y="170" as="sourcePoint"/>
            <mxPoint x="560" y="170" as="targetPoint"/>
          </mxGeometry>
        </mxCell>
        <mxCell id="msg-lock" value="3. lock, refresh(file list)" style="endArrow=block;html=1;" edge="1" parent="1">
          <mxGeometry relative="1" as="geometry">
            <mxPoint x="560" y="220" as="sourcePoint"/>
            <mxPoint x="780" y="220" as="targetPoint"/>
          </mxGeometry>
        </mxCell>
        <mxCell id="msg-read" value="4. per file: seek offset, read new complete lines (reparse if shrunk)" style="endArrow=block;html=1;" edge="1" parent="1">
          <mxGeometry relative="1" as="geometry">
            <mxPoint x="780" y="270" as="sourcePoint"/>
            <mxPoint x="1000" y="270" as="targetPoint"/>
          </mxGeometry>
        </mxCell>
        <mxCell id="msg-lines" value="5. bytes" style="endArrow=open;dashed=1;html=1;" edge="1" parent="1">
          <mxGeometry relative="1" as="geometry">
            <mxPoint x="1000" y="320" as="sourcePoint"/>
            <mxPoint x="780" y="320" as="targetPoint"/>
          </mxGeometry>
        </mxCell>
        <mxCell id="msg-fold" value="6. skip lines without usage, parse, dedupe, price, add to hour buckets, drop deleted files" style="endArrow=block;html=1;" edge="1" parent="1">
          <mxGeometry relative="1" as="geometry">
            <mxPoint x="780" y="370" as="sourcePoint"/>
            <mxPoint x="560" y="370" as="targetPoint"/>
          </mxGeometry>
        </mxCell>
        <mxCell id="msg-report" value="7. join SessionCache metadata, filter since_ms, five_hour_blocks -&gt; UsageReport" style="endArrow=open;dashed=1;html=1;" edge="1" parent="1">
          <mxGeometry relative="1" as="geometry">
            <mxPoint x="560" y="430" as="sourcePoint"/>
            <mxPoint x="340" y="430" as="targetPoint"/>
          </mxGeometry>
        </mxCell>
        <mxCell id="msg-json" value="8. 200 JSON UsageReport; UI groups into local days" style="endArrow=open;dashed=1;html=1;" edge="1" parent="1">
          <mxGeometry relative="1" as="geometry">
            <mxPoint x="340" y="490" as="sourcePoint"/>
            <mxPoint x="120" y="490" as="targetPoint"/>
          </mxGeometry>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```
