// `?demo=1`: a scripted fake event stream fed through the same store as the real socket,
// so the UI can be exercised without the server. State is folded with replay.ts's port of
// sim-core's rules (the live UI never folds state itself; the server sends it).
// `?demo=replay`: replay mode on a synthetic three-minute session, also without a server.
import type {
  AgentEvent,
  AgentId,
  ClientMsg,
  EventKind,
  JsonValue,
  MessageChannel,
  SessionState,
  SessionSummary,
  ToolKind,
} from './protocol';
import { useStore } from './store';
import { applyEvent, newSession as newReplaySession, type ReplaySource } from './replay';

export type DemoMode = 'live' | 'replay' | null;

/** `?demo=1` → live demo, `?demo=replay` → replay demo. */
export function demoMode(): DemoMode {
  const v = new URLSearchParams(window.location.search).get('demo');
  if (v === 'replay') return 'replay';
  return v ? 'live' : null;
}

type Step = { delay: number; agent: AgentId; kind: EventKind } | { delay: number; wait: 'decision' };

const MAIN = 'main';
const EXPLORE = 'a1f3c9';
const TESTS = 'b72e04';

function newSession(id: string, at: number, cwd: string): SessionState {
  const s = newReplaySession(id, at);
  s.cwd = cwd;
  s.git_branch = 'main';
  return s;
}

/** Same rules as the server (ported in replay.ts), applied to a copy. */
function apply(s: SessionState, e: AgentEvent): SessionState {
  const st: SessionState = structuredClone(s);
  applyEvent(st, e);
  return st;
}

function msg(from: AgentId, to: AgentId, channel: MessageChannel, text: string, delay = 150): Step {
  // Recorded in the receiver's transcript (as the parser does), except SendMessage calls.
  const agent = channel === 'message' ? from : to;
  return { delay, agent, kind: { type: 'message_sent', from, to, channel, text } };
}

let toolSeq = 0;
function tool(
  agent: AgentId,
  name: string,
  tool_kind: ToolKind,
  summary: string,
  input: JsonValue,
  output: string,
  ms: number,
  is_error = false,
): Step[] {
  const id = `toolu_demo_${++toolSeq}`;
  return [
    { delay: 350, agent, kind: { type: 'tool_started', tool_use_id: id, name, tool_kind, summary, input } },
    { delay: ms, agent, kind: { type: 'tool_finished', tool_use_id: id, is_error, output, duration_ms: ms } },
  ];
}

function usage(agent: AgentId, input: number, output: number, cache_read: number): Step {
  return {
    delay: 120,
    agent,
    kind: { type: 'usage_reported', model: 'claude-opus-5-5', usage: { input, output, cache_read, cache_write: 2_000 } },
  };
}

const ROOT = '/Users/demo/projects/orbital';

const MAIN_RS = `use orbital::Engine;

fn main() {
    let mut engine = Engine::new();
    engine.run();
}
`;

function script(): Step[] {
  return [
    { delay: 200, agent: MAIN, kind: { type: 'session_started', cwd: ROOT, git_branch: 'feat/retry', version: '2.3.0' } },
    msg('user', MAIN, 'prompt', 'Add retry with backoff to the HTTP client,\nthen make sure the tests pass.', 400),
    { delay: 0, agent: MAIN, kind: { type: 'user_prompt', text: 'Add retry with backoff to the HTTP client,\nthen make sure the tests pass.' } },
    { delay: 300, agent: MAIN, kind: { type: 'model_seen', model: 'claude-opus-5-5' } },
    { delay: 900, agent: MAIN, kind: { type: 'thinking', text: 'I should look at how the client is structured first, then spawn an explorer for call sites and a test runner.' } },
    usage(MAIN, 1_200, 400, 18_000),
    { delay: 300, agent: MAIN, kind: { type: 'title', title: 'Retry with backoff for HTTP client' } },
    ...tool(MAIN, 'Read', 'read', 'src/main.rs', { file_path: `${ROOT}/src/main.rs` }, MAIN_RS, 700),
    ...tool(MAIN, 'Read', 'read', 'src/http/client.rs', { file_path: `${ROOT}/src/http/client.rs` }, 'pub struct Client {\n    inner: reqwest::Client,\n}\n…', 600),
    { delay: 500, agent: MAIN, kind: { type: 'assistant_text', text: "I'll explore the call sites and run the tests in parallel." } },
    { delay: 300, agent: MAIN, kind: { type: 'tool_started', tool_use_id: 'toolu_agent_1', name: 'Agent', tool_kind: 'agent', summary: 'Find all HTTP call sites', input: { subagent_type: 'Explore', description: 'Find all HTTP call sites' } } },
    { delay: 200, agent: MAIN, kind: { type: 'subagent_spawned', child: EXPLORE, agent_type: 'Explore', description: 'Find all HTTP call sites', tool_use_id: 'toolu_agent_1' } },
    { delay: 300, agent: MAIN, kind: { type: 'tool_started', tool_use_id: 'toolu_agent_2', name: 'Agent', tool_kind: 'agent', summary: 'Run the test suite and report failures', input: { subagent_type: 'general-purpose', description: 'Run the test suite and report failures' } } },
    { delay: 200, agent: MAIN, kind: { type: 'subagent_spawned', child: TESTS, agent_type: 'general-purpose', description: 'Run the test suite and report failures', tool_use_id: 'toolu_agent_2' } },
    msg(MAIN, EXPLORE, 'dispatch', 'Find all HTTP call sites in the workspace.\nReport file:line for every client.get / client.post and note which ones already retry.', 300),
    { delay: 100, agent: EXPLORE, kind: { type: 'user_prompt', text: 'Find all HTTP call sites' } },
    ...tool(EXPLORE, 'Grep', 'search', 'client\\.(get|post)', { pattern: 'client\\.(get|post)', path: ROOT }, 'src/api/users.rs:14\nsrc/api/orders.rs:31\nsrc/sync.rs:88', 900),
    usage(EXPLORE, 800, 200, 9_000),
    msg(MAIN, TESTS, 'dispatch', 'Run the test suite (cargo test --workspace) and report any failures with their output.', 200),
    { delay: 100, agent: TESTS, kind: { type: 'user_prompt', text: 'Run the test suite and report failures' } },
    ...tool(TESTS, 'Bash', 'bash', 'cargo test --workspace', { command: 'cargo test --workspace', description: 'Run all tests' }, 'running 42 tests\n...\ntest http::client::times_out ... FAILED\n\nfailures: 1', 2200, true),
    ...tool(EXPLORE, 'Read', 'read', 'src/api/users.rs', { file_path: `${ROOT}/src/api/users.rs` }, 'pub async fn fetch_user(c: &Client, id: u64) -> Result<User> {\n    c.get(format!("/users/{id}")).await\n}', 600),
    ...tool(EXPLORE, 'Read', 'read', 'src/sync.rs', { file_path: `${ROOT}/src/sync.rs` }, '// sync loop…', 500),
    usage(TESTS, 1_500, 300, 11_000),
    { delay: 400, agent: EXPLORE, kind: { type: 'assistant_text', text: 'Found 3 call sites: users.rs:14, orders.rs:31, sync.rs:88.' } },
    { delay: 300, agent: EXPLORE, kind: { type: 'turn_ended', duration_ms: 5_200 } },
    msg(EXPLORE, MAIN, 'result', 'Found 3 call sites:\n- src/api/users.rs:14  fetch_user\n- src/api/orders.rs:31  create_order\n- src/sync.rs:88  sync loop (already retries manually)', 100),
    { delay: 200, agent: MAIN, kind: { type: 'subagent_finished', child: EXPLORE } },
    { delay: 100, agent: MAIN, kind: { type: 'tool_finished', tool_use_id: 'toolu_agent_1', is_error: false, output: 'Found 3 call sites.', duration_ms: 6_000 } },
    ...tool(MAIN, 'Edit', 'write', 'src/http/client.rs', { file_path: `${ROOT}/src/http/client.rs`, old_string: 'inner: reqwest::Client,', new_string: 'inner: reqwest::Client,\n    retry: RetryPolicy,' }, 'The file src/http/client.rs has been updated.', 800),
    ...tool(MAIN, 'Write', 'write', 'src/http/retry.rs', { file_path: `${ROOT}/src/http/retry.rs`, content: 'pub struct RetryPolicy { max: u32 }\n' }, 'File created successfully.', 700),
    usage(MAIN, 2_400, 1_800, 42_000),
    { delay: 300, agent: MAIN, kind: { type: 'tool_started', tool_use_id: 'toolu_send_1', name: 'SendMessage', tool_kind: 'other', summary: `to ${TESTS}`, input: { to: TESTS, message: 'Heads up: I changed Client; rerun http::client tests after your current run.' } } },
    msg(MAIN, TESTS, 'message', 'Heads up: I changed Client; rerun http::client tests after your current run.', 50),
    { delay: 150, agent: MAIN, kind: { type: 'tool_finished', tool_use_id: 'toolu_send_1', is_error: false, output: 'Message sent.', duration_ms: 150 } },
    { delay: 400, agent: TESTS, kind: { type: 'thinking', text: 'The timeout test fails; I need to rerun it with output.' } },
    { delay: 600, agent: TESTS, kind: { type: 'permission_requested', request_id: 'req_demo_1', tool_name: 'Bash', input: { command: 'cargo test -p orbital http::client::times_out -- --nocapture', description: 'Rerun the failing test with output' } } },
    { delay: 0, wait: 'decision' },
    ...tool(TESTS, 'Bash', 'bash', 'cargo test -p orbital http::client', { command: 'cargo test -p orbital http::client' }, 'running 6 tests\ntest result: ok. 6 passed', 1800),
    usage(TESTS, 600, 250, 14_000),
    { delay: 400, agent: TESTS, kind: { type: 'assistant_text', text: 'All http::client tests pass now.' } },
    { delay: 300, agent: TESTS, kind: { type: 'turn_ended', duration_ms: 9_800 } },
    msg(TESTS, MAIN, 'result', 'All http::client tests pass (6 passed). The earlier times_out failure was fixed by the new RetryPolicy.', 100),
    { delay: 200, agent: MAIN, kind: { type: 'subagent_finished', child: TESTS } },
    { delay: 100, agent: MAIN, kind: { type: 'tool_finished', tool_use_id: 'toolu_agent_2', is_error: false, output: 'All tests pass.', duration_ms: 14_000 } },
    { delay: 600, agent: MAIN, kind: { type: 'assistant_text', text: 'Retry with exponential backoff is in place:\n- `RetryPolicy` in src/http/retry.rs\n- wired into `Client`\n\nAll tests pass.' } },
    usage(MAIN, 900, 600, 48_000),
    { delay: 300, agent: MAIN, kind: { type: 'turn_ended', duration_ms: 31_000 } },
    msg('bg_lint_7', MAIN, 'notification', 'Background task "clippy --workspace" completed: 0 warnings.', 900),
  ];
}

/** Starts the demo feed. Returns a stop function. */
export function startDemo(): () => void {
  const store = useStore.getState();
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const now = Date.now();
  const sid = 'demo-5e1f-4c2a-9b7d-orbital';
  let session = newSession(sid, now, ROOT);
  // A second, quiet session so tabs and sorting are visible.
  const other = newSession('demo-77aa-docs', now - 3_600_000, '/Users/demo/projects/docs-site');
  other.title = 'Fix broken links in docs';
  other.last_activity = now - 600_000;
  other.cost_usd = 0.42;
  other.agents[MAIN]!.cost_usd = 0.42;
  other.agents[MAIN]!.model = 'claude-sonnet-5';

  const steps = script();
  let i = 0;
  let timer: number | undefined;
  let waiting = false;

  const emit = (agent: AgentId, kind: EventKind) => {
    const ev = { session: sid, agent, at: Date.now(), source: 'transcript', ...kind } as AgentEvent;
    session = apply(session, ev);
    useStore.getState().receive({ t: 'update', event: ev, state: session });
  };

  const tick = () => {
    const step = steps[i];
    if (!step) return;
    if ('wait' in step) {
      waiting = true;
      return;
    }
    i += 1;
    emit(step.agent, step.kind);
    const next = steps[i];
    if (next) timer = window.setTimeout(tick, reduced ? Math.min(next.delay, 300) : next.delay);
  };

  store.setTransport((msg: ClientMsg) => {
    if (msg.t === 'load_history') {
      useStore.getState().receive({ t: 'history', session: msg.session, events: [] });
    } else if (msg.t === 'decide') {
      emit(TESTS, {
        type: 'permission_resolved',
        request_id: msg.request_id,
        resolution: { outcome: 'decided', decision: msg.decision },
      });
      if (waiting) {
        waiting = false;
        i += 1;
        if (msg.decision.behavior === 'deny') {
          emit(TESTS, { type: 'assistant_text', text: `Permission denied: ${msg.decision.message}` });
        }
        timer = window.setTimeout(tick, 400);
      }
    }
  });
  store.setReplaySource(demoSource());
  store.setConnection('demo');
  store.receive({ t: 'snapshot', protocol_version: 1, sessions: [session, other] });
  timer = window.setTimeout(tick, 300);
  return () => window.clearTimeout(timer);
}

// ---------------------------------------------------------------- ?demo=replay

const REPLAY_ID = 'demo-replay-3c9e-orbital-auth';
const REPLAY_ROOT = '/Users/demo/projects/orbital-auth';

/** Builds a synthetic ~3 minute session: a main agent, four subagents, messages, idle gaps. */
export function syntheticSession(start: number): AgentEvent[] {
  const out: AgentEvent[] = [];
  let t = start;
  let n = 0;
  const at = (agent: AgentId, kind: EventKind, dt = 400) => {
    t += dt;
    out.push({ session: REPLAY_ID, agent, at: t, source: 'transcript', ...kind } as AgentEvent);
  };
  const send = (from: AgentId, to: AgentId, channel: MessageChannel, text: string, dt = 200) =>
    at(channel === 'message' ? from : to, { type: 'message_sent', from, to, channel, text }, dt);
  const use = (agent: AgentId, input: number, output: number, cache: number) =>
    at(agent, { type: 'usage_reported', model: 'claude-opus-5-5', usage: { input, output, cache_read: cache, cache_write: 1_500 } }, 80);
  const run = (agent: AgentId, name: string, kind: ToolKind, summary: string, input: JsonValue, output: string, ms: number, err = false) => {
    const id = `toolu_r_${++n}`;
    at(agent, { type: 'tool_started', tool_use_id: id, name, tool_kind: kind, summary, input }, 300);
    at(agent, { type: 'tool_finished', tool_use_id: id, is_error: err, output, duration_ms: ms }, ms);
  };
  const spawn = (child: AgentId, type: string, desc: string, prompt: string) => {
    const id = `toolu_r_agent_${child}`;
    at(MAIN, { type: 'tool_started', tool_use_id: id, name: 'Agent', tool_kind: 'agent', summary: desc, input: { subagent_type: type, description: desc, prompt } }, 300);
    at(MAIN, { type: 'subagent_spawned', child, agent_type: type, description: desc, tool_use_id: id }, 150);
    send(MAIN, child, 'dispatch', prompt, 150);
    at(child, { type: 'user_prompt', text: prompt }, 50);
    at(child, { type: 'model_seen', model: 'claude-opus-5-5' }, 50);
  };
  const finish = (child: AgentId, result: string) => {
    at(child, { type: 'assistant_text', text: result }, 500);
    at(child, { type: 'turn_ended', duration_ms: null }, 200);
    send(child, MAIN, 'result', result, 100);
    at(MAIN, { type: 'subagent_finished', child }, 100);
    at(MAIN, { type: 'tool_finished', tool_use_id: `toolu_r_agent_${child}`, is_error: false, output: result, duration_ms: null }, 100);
  };
  const R = REPLAY_ROOT;
  const P = 'p_scout';
  const S = 's_schema';
  const T = 't_tests';
  const D = 'd_docs';

  at(MAIN, { type: 'session_started', cwd: R, git_branch: 'feat/sessions', version: '2.3.0' }, 0);
  const ask = 'Replace the cookie auth with signed session tokens.\nKeep the old cookies working for a week, add tests, and update the docs.';
  send('user', MAIN, 'prompt', ask, 600);
  at(MAIN, { type: 'user_prompt', text: ask }, 0);
  at(MAIN, { type: 'model_seen', model: 'claude-opus-5-5' }, 200);
  at(MAIN, { type: 'thinking', text: 'Plan: scout the auth module, design the token schema, then tests and docs in parallel.' }, 1800);
  at(MAIN, { type: 'title', title: 'Signed session tokens' }, 300);
  use(MAIN, 2_100, 600, 22_000);
  run(MAIN, 'Read', 'read', 'src/auth/mod.rs', { file_path: `${R}/src/auth/mod.rs` }, 'pub mod cookie;\npub mod middleware;', 600);
  run(MAIN, 'Grep', 'search', 'Cookie::', { pattern: 'Cookie::', path: R }, 'src/auth/cookie.rs:12\nsrc/auth/middleware.rs:40\nsrc/routes/login.rs:22', 800);
  at(MAIN, { type: 'assistant_text', text: "I'll send a scout through the auth code and a designer for the token schema." }, 900);

  spawn(P, 'Explore', 'Map the auth flow', 'Map how a request is authenticated today: every place a cookie is read, set or cleared. Return a short call graph.');
  spawn(S, 'Plan', 'Design token schema', 'Design a signed session token (claims, expiry, rotation). Consider key rotation and the one-week cookie fallback.');
  for (let k = 0; k < 4; k++) {
    run(P, 'Read', 'read', ['src/auth/cookie.rs', 'src/auth/middleware.rs', 'src/routes/login.rs', 'src/routes/logout.rs'][k]!, { file_path: `${R}/src/auth/${k}.rs` }, '// …', 700 + k * 200);
    if (k === 1) run(S, 'WebFetch', 'web', 'RFC 7519 claims', { url: 'https://www.rfc-editor.org/rfc/rfc7519' }, 'JSON Web Token (JWT)…', 2400);
    if (k === 2) use(P, 1_400, 300, 9_000);
  }
  at(S, { type: 'thinking', text: 'HMAC-SHA256 with a kid header allows rotation without invalidating sessions.' }, 1600);
  use(S, 1_900, 1_100, 12_000);
  send(MAIN, S, 'message', 'Also keep the token under 4 KB so it fits in one header.', 1200);
  at(S, { type: 'assistant_text', text: 'Noted: compact claims only.' }, 800);
  finish(P, 'Auth flow: login.rs sets the cookie → middleware.rs:40 reads it → handlers get `User`. logout.rs clears it. Two helpers in cookie.rs.');
  run(S, 'Write', 'write', 'docs/design/tokens.md', { file_path: `${R}/docs/design/tokens.md`, content: '# Tokens\n' }, 'File created successfully.', 900);
  finish(S, 'Schema: {sub, sid, iat, exp, kid}, HMAC-SHA256, 12h expiry with sliding refresh. Fallback: middleware accepts the legacy cookie until 2026-11-22 and re-issues a token.');

  // A long idle gap (the human stepped away) that "skip idle gaps" compresses.
  t += 38_000;
  const go = 'Looks good. Go ahead, and run clippy too.';
  send('user', MAIN, 'prompt', go, 0);
  at(MAIN, { type: 'user_prompt', text: go }, 0);
  at(MAIN, { type: 'thinking', text: 'Implement the token module, then tests and docs in parallel.' }, 1400);
  use(MAIN, 3_200, 2_400, 51_000);
  run(MAIN, 'Write', 'write', 'src/auth/token.rs', { file_path: `${R}/src/auth/token.rs`, content: 'pub struct Claims { … }' }, 'File created successfully.', 1100);
  run(MAIN, 'Edit', 'write', 'src/auth/middleware.rs', { file_path: `${R}/src/auth/middleware.rs`, old_string: 'cookie', new_string: 'token' }, 'Updated.', 900);
  spawn(T, 'general-purpose', 'Write and run tests', 'Add tests for token issue/verify/expiry and the legacy cookie fallback, then run cargo test.');
  spawn(D, 'general-purpose', 'Update the docs', 'Update docs/auth.md for the new tokens, including the migration window.');
  run(T, 'Write', 'write', 'tests/token.rs', { file_path: `${R}/tests/token.rs`, content: '#[test] fn round_trip() {}' }, 'File created successfully.', 1000);
  run(D, 'Read', 'read', 'docs/auth.md', { file_path: `${R}/docs/auth.md` }, '# Auth\nCookies…', 600);
  run(T, 'Bash', 'bash', 'cargo test token', { command: 'cargo test token' }, 'test token::expiry ... FAILED\n\nfailures: 1', 4200, true);
  at(T, { type: 'permission_requested', request_id: 'req_r_1', tool_name: 'Bash', input: { command: 'cargo test token -- --nocapture' } }, 400);
  at(T, { type: 'permission_resolved', request_id: 'req_r_1', resolution: { outcome: 'decided', decision: { behavior: 'allow' } } }, 6500);
  run(D, 'Edit', 'write', 'docs/auth.md', { file_path: `${R}/docs/auth.md`, old_string: 'Cookies', new_string: 'Signed tokens' }, 'Updated.', 900);
  finish(D, 'docs/auth.md now describes signed tokens, rotation and the one-week cookie migration window.');
  send(T, MAIN, 'message', 'expiry test fails: exp is compared in seconds but iat is ms. Want me to fix token.rs?', 600);
  send(MAIN, T, 'message', 'Yes, fix it in token.rs and rerun.', 1500);
  run(T, 'Edit', 'write', 'src/auth/token.rs', { file_path: `${R}/src/auth/token.rs`, old_string: 'as_millis', new_string: 'as_secs' }, 'Updated.', 700);
  run(T, 'Bash', 'bash', 'cargo test', { command: 'cargo test' }, 'test result: ok. 58 passed', 6800);
  use(T, 2_200, 900, 18_000);
  finish(T, 'Added 6 tests (round trip, tamper, expiry, rotation, legacy cookie, cookie after window). Fixed a seconds/ms bug in token.rs. 58 passed.');
  run(MAIN, 'Bash', 'bash', 'cargo clippy --workspace', { command: 'cargo clippy --workspace -- -D warnings' }, 'Finished. 0 warnings.', 7200);
  use(MAIN, 1_100, 800, 64_000);
  send('bg_ci_42', MAIN, 'notification', 'Background task "cargo bench auth" completed: verify 1.8µs/op.', 3000);
  at(MAIN, { type: 'assistant_text', text: 'Done:\n- signed tokens in src/auth/token.rs (HMAC, kid rotation)\n- middleware accepts legacy cookies until 2026-11-22\n- 6 new tests, clippy clean\n- docs updated' }, 1500);
  at(MAIN, { type: 'turn_ended', duration_ms: null }, 300);

  // Stretch to about three minutes so the timeline has room.
  const span = t - start;
  const target = 180_000;
  if (span < target) {
    const f = target / span;
    for (const e of out) e.at = start + Math.round((e.at - start) * f);
  }
  return out;
}

/** Replay source for demo mode: the synthetic session plus the live demo's own events. */
function demoSource(): ReplaySource {
  const start = Date.now() - 26 * 3_600_000;
  const events = syntheticSession(start);
  return {
    list: async () => {
      const st = useStore.getState();
      const live: SessionSummary[] = Object.values(st.sessions).map((s) => ({
        id: s.id,
        project: `-Users-demo-projects-${(s.cwd ?? '').split('/').pop() ?? ''}`,
        cwd: s.cwd,
        title: s.title,
        modified_ms: s.last_activity,
        size_bytes: (st.events[s.id]?.length ?? 0) * 420,
        subagents: Object.keys(s.agents).length - 1,
        live: true,
      }));
      return [
        ...live,
        {
          id: REPLAY_ID,
          project: '-Users-demo-projects-orbital-auth',
          cwd: REPLAY_ROOT,
          title: 'Signed session tokens',
          modified_ms: events.at(-1)?.at ?? start,
          size_bytes: 1_284_000,
          subagents: 4,
          live: false,
        },
        {
          id: 'demo-0b1d-old-migration',
          project: '-Users-demo-projects-orbital',
          cwd: ROOT,
          title: null,
          modified_ms: start - 5 * 86_400_000,
          size_bytes: 88_000,
          subagents: 0,
          live: false,
        },
      ];
    },
    load: async (id) => {
      if (id === REPLAY_ID) return events;
      const local = useStore.getState().events[id];
      if (local) return local.map((se) => se.ev);
      throw new Error('This demo session has no transcript.');
    },
  };
}

/** `?demo=replay`: opens replay mode on the synthetic session. */
export function startReplayDemo(): () => void {
  const store = useStore.getState();
  store.setReplaySource(demoSource());
  store.setTransport(() => {});
  store.setConnection('demo');
  store.receive({ t: 'snapshot', protocol_version: 1, sessions: [] });
  // `&seek=0.6` (fraction of events) and `&tab=finished` start paused at a point, for screenshots.
  const q = new URLSearchParams(window.location.search);
  const seek = Number(q.get('seek'));
  const tab = q.get('tab');
  void store.openReplay(REPLAY_ID, { title: 'Signed session tokens', autoplay: !seek }).then(() => {
    const st = useStore.getState();
    if (seek > 0 && st.replay) st.replaySeek(Math.round(st.replay.stored.length * Math.min(1, seek)));
    if (tab === 'messages' || tab === 'activity' || tab === 'finished' || tab === 'agents' || tab === 'files') {
      st.setPanelTab(tab);
    }
  });
  return () => {};
}
