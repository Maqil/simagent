import { useEffect, useMemo, useState } from 'react';
import type { JsonValue, SessionState } from '../protocol';
import { useSessionEvents } from '../store';
import { getString } from '../format';
import { fileUrl, isDemo } from '../connection';

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookRead', 'NotebookEdit']);
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

interface FileEntry {
  path: string;
  reads: number;
  writes: number;
  last: number;
}

function pathOf(input: JsonValue): string | null {
  return getString(input, 'file_path') ?? getString(input, 'notebook_path') ?? getString(input, 'path');
}

export function FilesPanel({ session }: { session: SessionState }) {
  const events = useSessionEvents(session.id);
  const [open, setOpen] = useState<string | null>(null);

  const files = useMemo(() => {
    const map = new Map<string, FileEntry>();
    for (const { ev } of events) {
      if (ev.type !== 'tool_started' || !FILE_TOOLS.has(ev.name)) continue;
      const p = pathOf(ev.input);
      if (!p) continue;
      let f = map.get(p);
      if (!f) map.set(p, (f = { path: p, reads: 0, writes: 0, last: ev.at }));
      if (ev.tool_kind === 'write') f.writes += 1;
      else f.reads += 1;
      f.last = Math.max(f.last, ev.at);
    }
    return [...map.values()].sort((a, b) => b.last - a.last);
  }, [events]);

  useEffect(() => setOpen(null), [session.id]);

  if (!files.length) return <div className="panel-empty">No files read or written yet.</div>;

  const root = session.cwd ? session.cwd.replace(/\/$/, '') + '/' : null;
  return (
    <div className="files">
      <ul className="files__list">
        {files.map((f) => (
          <li key={f.path}>
            <button
              className={`file${open === f.path ? ' file--open' : ''}`}
              onClick={() => setOpen(open === f.path ? null : f.path)}
              title={f.path}
            >
              <span className="file__path mono">
                {root && f.path.startsWith(root) ? f.path.slice(root.length) : f.path}
              </span>
              {f.reads > 0 && <span className="chip chip--read">R {f.reads}</span>}
              {f.writes > 0 && <span className="chip chip--write">W {f.writes}</span>}
            </button>
          </li>
        ))}
      </ul>
      {open && <FileViewer path={open} />}
    </div>
  );
}

function FileViewer({ path }: { path: string }) {
  const image = IMAGE_RE.test(path);
  const [state, setState] = useState<{ text?: string; error?: string; loading: boolean }>({ loading: true });

  useEffect(() => {
    if (image) return;
    const ctrl = new AbortController();
    setState({ loading: true });
    if (isDemo()) {
      setState({ loading: false, error: 'File contents are served by simagent; not available in demo mode.' });
      return;
    }
    fetch(fileUrl(path), { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}${r.status === 403 ? ' (outside allowed roots)' : ''}`);
        setState({ loading: false, text: await r.text() });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
      });
    return () => ctrl.abort();
  }, [path, image]);

  return (
    <div className="viewer">
      <div className="viewer__head mono">{path}</div>
      {image ? (
        <img className="viewer__img" src={fileUrl(path)} alt={path} />
      ) : state.loading ? (
        <div className="muted">loading…</div>
      ) : state.error ? (
        <div className="err">{state.error}</div>
      ) : (
        <pre className="pre mono viewer__pre">{state.text}</pre>
      )}
    </div>
  );
}
