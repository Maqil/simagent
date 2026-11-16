// Reads the questions out of an `AskUserQuestion` tool input, for the question card.
// The input comes from Claude Code and may change shape: anything unexpected is skipped,
// never thrown, the same rule the Rust transcript parser follows.
import type { AgentEvent, JsonValue, SessionState, ToolUseId, AgentId } from '../protocol';

/** One question Claude asked, with the labels of its options. */
export interface AskItem {
  header: string | null;
  question: string;
  options: string[];
}

/** The question card's input: who asked, which tool call, and what. */
export interface OpenQuestion {
  agent: AgentId;
  toolUseId: ToolUseId;
  items: AskItem[];
}

/** The tool whose input this module understands. */
export const ASK_TOOL = 'AskUserQuestion';

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;

type JsonObject = { [key: string]: JsonValue };

function isObject(v: JsonValue | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: JsonValue | undefined): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Parses `{ questions: [{ header, question, options: [{ label }] }] }`; `[]` if unknown. */
export function parseQuestions(input: JsonValue): AskItem[] {
  if (!isObject(input) || !Array.isArray(input.questions)) return [];
  const items: AskItem[] = [];
  for (const q of input.questions) {
    if (items.length === MAX_QUESTIONS) break;
    if (!isObject(q)) continue;
    const question = str(q.question);
    if (!question) continue;
    const options: string[] = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (options.length === MAX_OPTIONS) break;
        const label = isObject(o) ? str(o.label) : str(o);
        if (label) options.push(label);
      }
    }
    items.push({ header: str(q.header), question, options });
  }
  return items;
}

/**
 * The question waiting for the user right now: an `AskUserQuestion` call still active on
 * some agent, with its input found in the event list. `null` when nothing is being asked.
 */
export function openQuestion(events: readonly AgentEvent[], session: SessionState | null): OpenQuestion | null {
  if (!session) return null;
  // Cheap check first (a few agents), so the event list is only searched while asking.
  let toolUseId: ToolUseId | null = null;
  for (const a of Object.values(session.agents)) {
    const t = a.active_tools.find((x) => x.name === ASK_TOOL);
    if (t) {
      toolUseId = t.tool_use_id;
      break;
    }
  }
  if (!toolUseId) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'tool_started' || e.tool_use_id !== toolUseId) continue;
    const items = parseQuestions(e.input);
    return items.length ? { agent: e.agent, toolUseId, items } : null;
  }
  return null;
}
