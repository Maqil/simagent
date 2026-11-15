// Key moments of a session for the Review tab and the scrubber's chapter markers.
// Pure: derived from the replay's event list, so it works for any source.
import type { AgentEvent, AgentId, SessionState } from './protocol';
import { USER_AGENT } from './protocol';

export type MomentKind =
  | 'prompt'
  | 'spawn'
  | 'result'
  | 'finish'
  | 'permission'
  | 'error'
  | 'tool_error'
  | 'compaction'
  | 'turn_end';

export interface Moment {
  /** Index into the replay's event list. Seeking to `index + 1` shows the moment applied. */
  index: number;
  at: number;
  kind: MomentKind;
  agent: AgentId;
  title: string;
  detail: string;
}

const oneLine = (s: string, n = 140) => {
  const line = s.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/** Every moment worth jumping to, in order. */
export function keyMoments(events: readonly AgentEvent[], names: SessionState['agents']): Moment[] {
  const name = (id: AgentId) => (id === USER_AGENT ? 'You' : (names[id]?.name ?? id));
  const out: Moment[] = [];
  events.forEach((e, index) => {
    const base = { index, at: e.at, agent: e.agent };
    switch (e.type) {
      case 'message_sent':
        if (e.channel === 'prompt') out.push({ ...base, kind: 'prompt', title: 'You prompted', detail: oneLine(e.text) });
        else if (e.channel === 'result')
          out.push({ ...base, agent: e.from, kind: 'result', title: `${name(e.from)} reported back`, detail: oneLine(e.text) });
        break;
      case 'subagent_spawned':
        out.push({
          ...base,
          agent: e.child,
          kind: 'spawn',
          title: `Started ${e.description ?? e.agent_type ?? e.child}`,
          detail: e.agent_type ? `${e.agent_type} agent` : 'subagent',
        });
        break;
      case 'subagent_finished':
        out.push({ ...base, agent: e.child, kind: 'finish', title: `${name(e.child)} finished`, detail: '' });
        break;
      case 'permission_requested':
        out.push({ ...base, kind: 'permission', title: `Asked to run ${e.tool_name}`, detail: oneLine(JSON.stringify(e.input)) });
        break;
      case 'permission_resolved':
        out.push({
          ...base,
          kind: 'permission',
          title:
            e.resolution.outcome === 'fell_back'
              ? 'Permission went to the terminal'
              : e.resolution.decision.behavior === 'allow'
                ? 'Permission allowed'
                : 'Permission denied',
          detail: e.resolution.outcome === 'decided' && e.resolution.decision.behavior === 'deny' ? e.resolution.decision.message : '',
        });
        break;
      case 'tool_finished':
        if (e.is_error) out.push({ ...base, kind: 'tool_error', title: `${name(e.agent)}: tool failed`, detail: oneLine(e.output) });
        break;
      case 'error':
        out.push({ ...base, kind: 'error', title: 'Error', detail: oneLine(e.message) });
        break;
      case 'compacted':
        out.push({
          ...base,
          kind: 'compaction',
          title: 'Context compacted',
          detail: e.pre_tokens ? `${Math.round(e.pre_tokens / 1000)}k tokens before` : (e.trigger ?? ''),
        });
        break;
      case 'turn_ended':
        if (e.agent === 'main') out.push({ ...base, kind: 'turn_end', title: 'Turn ended', detail: '' });
        break;
      default:
        break;
    }
  });
  return out;
}

export const momentColor: Record<MomentKind, string> = {
  prompt: '#66ccff',
  spawn: '#cc88ff',
  result: '#66ffaa',
  finish: '#66ffaa',
  permission: '#ffaa33',
  error: '#ff5566',
  tool_error: '#ff5566',
  compaction: '#cc88ff',
  turn_end: '#7f9cc4',
};

export const momentGlyph: Record<MomentKind, string> = {
  prompt: '›',
  spawn: '⑂',
  result: '↩',
  finish: '✓',
  permission: '⚑',
  error: '!',
  tool_error: '✕',
  compaction: '⇲',
  turn_end: '■',
};
