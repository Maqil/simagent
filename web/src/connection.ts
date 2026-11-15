// WebSocket transport with exponential-backoff reconnect.
import type { ClientMsg, ServerMsg } from './protocol';
import { useStore } from './store';

const TOKEN_KEY = 'simagent.token';

/** Reads `?token=` from the page URL (storing it), else falls back to sessionStorage. */
export function getToken(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('token');
  try {
    if (fromUrl) {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
      return fromUrl;
    }
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return fromUrl ?? '';
  }
}

export function isDemo(): boolean {
  // `?demo=1` (live demo) or `?demo=replay` (replay demo): no server either way.
  return new URLSearchParams(window.location.search).has('demo');
}

/** URL for a file served by `/api/file`. */
export function fileUrl(path: string): string {
  const q = new URLSearchParams({ path, token: getToken() });
  return `/api/file?${q.toString()}`;
}

function isServerMsg(v: unknown): v is ServerMsg {
  return typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string';
}

/** Opens the socket and keeps it open. Returns a stop function. */
export function connect(): () => void {
  const store = useStore.getState();
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: number | undefined;
  let stopped = false;
  const outbox: ClientMsg[] = [];

  const send = (msg: ClientMsg) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else if (msg.t === 'decide') outbox.push(msg); // load_history is re-sent after snapshot
  };
  store.setTransport(send);

  const open = () => {
    if (stopped) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(getToken())}`;
    useStore.getState().setConnection(attempt === 0 ? 'connecting' : 'reconnecting');
    const sock = new WebSocket(url);
    ws = sock;

    sock.onopen = () => {
      attempt = 0;
      useStore.getState().setConnection('live');
      while (outbox.length) {
        const m = outbox.shift();
        if (m) sock.send(JSON.stringify(m));
      }
    };
    sock.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.data);
      } catch {
        console.warn('simagent: non-JSON frame ignored');
        return;
      }
      if (isServerMsg(parsed)) useStore.getState().receive(parsed);
    };
    sock.onclose = () => {
      if (ws !== sock || stopped) return;
      ws = null;
      const delay = Math.min(30_000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      attempt += 1;
      useStore.getState().setConnection('reconnecting', Math.round(delay));
      timer = window.setTimeout(open, delay);
    };
    sock.onerror = () => sock.close();
  };

  open();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    ws?.close();
  };
}
