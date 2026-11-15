// Design tokens from docs/design/visual-identity.md. CSS variables in styles.css carry the
// same values; this module is the source for the canvas scene and per-kind colors.
import type { AgentEvent, AgentStatus, MessageChannel, ToolKind } from './protocol';

export const color = {
  bgVoid: '#050510',
  bgGrid: '#0d0d1f',
  holoBase: '#66ccff',
  holoBright: '#aaeeff',
  holoHot: '#ffffff',
  textDim: '#6aa9cf',
  textMuted: '#4f8fb3',
  mascotBody: '#d97757',
  mascotEye: '#0b0d14',
  edgeDispatch: '#cc88ff',
  edgeReturn: '#66ffaa',
  live: '#ff4444',
} as const;

/** Exhaustive status → color map (a missing key is a type error). */
export const statusColor: Record<AgentStatus, string> = {
  idle: '#7f9cc4',
  thinking: '#66ccff',
  tool: '#ffbb44',
  awaiting_permission: '#ffaa33',
  compacting: '#cc88ff',
  done: '#66ffaa',
  error: '#ff5566',
};

export const statusLabel: Record<AgentStatus, string> = {
  idle: 'idle',
  thinking: 'thinking',
  tool: 'running tool',
  awaiting_permission: 'awaiting permission',
  compacting: 'compacting',
  done: 'done',
  error: 'error',
};

export const toolKindColor: Record<ToolKind, string> = {
  read: '#66ccff',
  write: '#ffbb44',
  search: '#cc88ff',
  bash: '#66ffaa',
  web: '#aaeeff',
  agent: '#cc88ff',
  ask: '#ffaa33',
  other: '#7f9cc4',
};

/** Exhaustive message channel → color map (Messages panel, timeline, scene comets). */
export const channelColor: Record<MessageChannel, string> = {
  prompt: '#66ccff',
  dispatch: '#cc88ff',
  result: '#66ffaa',
  message: '#ffbb44',
  notification: '#aaeeff',
};

/** Context breakdown colors (reserved for the context panel). */
export const contextColor = {
  system: '#555577',
  user: '#66ccff',
  toolResults: '#ffbb44',
  reasoning: '#cc88ff',
  subagents: '#66ffaa',
} as const;

/** Color for one event row / timeline tick. */
export function eventColor(e: AgentEvent): string {
  switch (e.type) {
    case 'user_prompt':
      return color.holoBright;
    case 'assistant_text':
      return color.holoBase;
    case 'thinking':
      return '#9a77cc';
    case 'tool_started':
      return toolKindColor[e.tool_kind] ?? toolKindColor.other;
    case 'tool_finished':
      return e.is_error ? statusColor.error : '#66ffaa';
    case 'subagent_spawned':
      return color.edgeDispatch;
    case 'subagent_finished':
      return color.edgeReturn;
    case 'permission_requested':
      return statusColor.awaiting_permission;
    case 'permission_resolved':
      return '#ffbb44';
    case 'compacted':
      return statusColor.compacting;
    case 'error':
      return statusColor.error;
    case 'notification':
      return color.holoBright;
    case 'message_sent':
      return channelColor[e.channel] ?? color.holoBase;
    default:
      return color.textMuted;
  }
}

/** Short glyph per event kind, for the activity list. */
export function eventGlyph(e: AgentEvent): string {
  switch (e.type) {
    case 'user_prompt':
      return '›';
    case 'assistant_text':
      return '◆';
    case 'thinking':
      return '…';
    case 'tool_started':
      return '▸';
    case 'tool_finished':
      return e.is_error ? '✕' : '✓';
    case 'subagent_spawned':
      return '⑂';
    case 'subagent_finished':
      return '◇';
    case 'permission_requested':
      return '⚠';
    case 'permission_resolved':
      return '⚑';
    case 'compacted':
      return '⇲';
    case 'turn_ended':
      return '⏎';
    case 'error':
      return '!';
    case 'notification':
      return '✉';
    case 'message_sent':
      return '⇢';
    default:
      return '·';
  }
}

export const fontSans = 'Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
export const fontMono = '"Geist Mono", "SF Mono", Menlo, ui-monospace, monospace';
