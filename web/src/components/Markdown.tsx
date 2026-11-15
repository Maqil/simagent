// A small, safe Markdown renderer for agent text (replies, prompts, subagent messages).
//
// It builds React elements directly. There is no innerHTML anywhere, so transcript text can
// never inject markup. It covers what Claude actually writes: headings, paragraphs, bold,
// italic, strikethrough, `code`, links, fenced code (also indented inside list items),
// ordered/unordered/task lists with nesting, blockquotes, tables and rules.
// Anything it doesn't recognise renders as plain text.

import { memo, useState, type ReactNode } from 'react';

// ---------------------------------------------------------------- block model

type Block =
  | { k: 'p'; text: string }
  | { k: 'h'; level: number; text: string }
  | { k: 'code'; lang: string; text: string }
  | { k: 'quote'; children: Block[] }
  | { k: 'list'; ordered: boolean; start: number; items: Block[][]; checks: (boolean | null)[] }
  | { k: 'table'; head: string[]; align: ('l' | 'c' | 'r')[]; rows: string[][] }
  | { k: 'hr' };

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*).*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function indentOf(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** Removes up to `n` columns of leading indentation. */
function dedent(line: string, n: number): string {
  let i = 0;
  let cols = 0;
  while (i < line.length && cols < n && (line[i] === ' ' || line[i] === '\t')) {
    cols += line[i] === '\t' ? 4 : 1;
    i++;
  }
  return line.slice(i);
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ k: 'p', text: para.join('\n') });
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    // Fenced code. An unclosed fence runs to the end (e.g. a collapsed preview).
    const fm = FENCE.exec(line);
    if (fm) {
      flush();
      const ind = fm[1]!.length;
      const mark = fm[2]!;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        const t = l.trim();
        if (t.startsWith(mark[0]!.repeat(mark.length)) && /^[`~]+$/.test(t)) {
          i++;
          break;
        }
        body.push(dedent(l, ind));
        i++;
      }
      out.push({ k: 'code', lang: fm[3] ?? '', text: body.join('\n') });
      continue;
    }

    const hm = HEADING.exec(line);
    if (hm) {
      flush();
      out.push({ k: 'h', level: hm[1]!.length, text: hm[2]! });
      i++;
      continue;
    }

    if (HR.test(line) && !para.length) {
      out.push({ k: 'hr' });
      i++;
      continue;
    }

    // Table: a header row followed by a |---| separator.
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      flush();
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : 'l',
      ) as ('l' | 'c' | 'r')[];
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      out.push({ k: 'table', head, align, rows });
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      flush();
      const inner: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) {
        inner.push(lines[i]!.replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      out.push({ k: 'quote', children: parseBlocks(inner.join('\n')) });
      continue;
    }

    const lm = LIST.exec(line);
    if (lm && (!para.length || indentOf(line) === 0)) {
      flush();
      const base = indentOf(line);
      const ordered = /\d/.test(lm[2]!);
      const start = ordered ? parseInt(lm[2]!, 10) : 1;
      const items: Block[][] = [];
      const checks: (boolean | null)[] = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]!);
        if (!m || indentOf(lines[i]!) !== base || /\d/.test(m[2]!) !== ordered) break;
        // Content column: everything indented past the marker belongs to this item.
        const contentCol = base + m[2]!.length + 1;
        let first = m[3]!;
        let check: boolean | null = null;
        const tm = /^\[([ xX])\]\s+(.*)$/.exec(first);
        if (tm) {
          check = tm[1] !== ' ';
          first = tm[2]!;
        }
        const body = [first];
        i++;
        let inFence = false;
        while (i < lines.length) {
          const l = lines[i]!;
          if (FENCE.test(l)) inFence = !inFence;
          if (inFence) {
            body.push(dedent(l, Math.min(contentCol, indentOf(l))));
            i++;
            continue;
          }
          if (!l.trim()) {
            // A blank line ends the item unless the next line is still indented under it.
            const next = lines[i + 1];
            if (next !== undefined && next.trim() && indentOf(next) > base) {
              body.push('');
              i++;
              continue;
            }
            break;
          }
          const ind = indentOf(l);
          if (ind > base) body.push(dedent(l, Math.min(contentCol, ind)));
          else if (!LIST.exec(l) && !HEADING.test(l) && !FENCE.test(l) && ind === base && body.length && body[body.length - 1]!.trim())
            body.push(l.trim()); // lazy continuation of the item's paragraph
          else break;
          i++;
        }
        items.push(parseBlocks(body.join('\n')));
        checks.push(check);
      }
      out.push({ k: 'list', ordered, start, items, checks });
      continue;
    }

    para.push(line);
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- inline

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Parses inline spans: `code`, **bold**, *italic*, ~~strike~~, [links](url), bare URLs. */
export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let n = 0;
  const push = (node: ReactNode) => {
    if (buf) out.push(buf);
    buf = '';
    out.push(node);
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const rest = text.slice(i);

    if (ch === '\\' && i + 1 < text.length && /[\\`*_~[\]()#|>-]/.test(text[i + 1]!)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const run = /^`+/.exec(rest)![0];
      const end = text.indexOf(run, i + run.length);
      if (end > 0) {
        push(
          <code key={`${key}${n++}`} className="md-ic">
            {text.slice(i + run.length, end).trim() || text.slice(i + run.length, end)}
          </code>,
        );
        i = end + run.length;
        continue;
      }
    }

    if (ch === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (m) {
        const href = m[2]!;
        push(
          SAFE_URL.test(href) ? (
            <a key={`${key}${n++}`} className="md-a" href={href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
              {inline(m[1]!, `${key}${n}l`)}
            </a>
          ) : (
            <span key={`${key}${n++}`} className="md-a md-a--local" title={href}>
              {inline(m[1]!, `${key}${n}l`)}
            </span>
          ),
        );
        i += m[0].length;
        continue;
      }
    }

    if (ch === 'h' && /^https?:\/\//.test(rest) && (i === 0 || /[\s(]/.test(text[i - 1]!))) {
      const m = /^https?:\/\/[^\s<>)]+[^\s<>).,;:!?'"]/.exec(rest);
      if (m) {
        push(
          <a key={`${key}${n++}`} className="md-a" href={m[0]} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
            {m[0]}
          </a>,
        );
        i += m[0].length;
        continue;
      }
    }

    // Emphasis: ** / __ (bold), * / _ (italic), ~~ (strike). `_` only at word edges so
    // snake_case identifiers stay intact.
    const em = /^(\*\*|__|~~|\*|_)/.exec(rest);
    if (em) {
      const mark = em[1]!;
      const prev = i > 0 ? text[i - 1]! : ' ';
      const okOpen = !/\s/.test(text[i + mark.length] ?? ' ') && (mark[0] !== '_' || !/\w/.test(prev));
      if (okOpen) {
        let j = text.indexOf(mark, i + mark.length);
        while (j > 0) {
          const after = text[j + mark.length] ?? ' ';
          const before = text[j - 1]!;
          const okClose = !/\s/.test(before) && (mark[0] !== '_' || !/\w/.test(after)) && !(mark === '*' && text[j + 1] === '*' && text[j - 1] !== '*');
          if (okClose) break;
          j = text.indexOf(mark, j + 1);
        }
        if (j > i + mark.length) {
          const inner = inline(text.slice(i + mark.length, j), `${key}${n}e`);
          const k = `${key}${n++}`;
          push(
            mark === '~~' ? <del key={k}>{inner}</del> : mark.length === 2 ? <strong key={k}>{inner}</strong> : <em key={k}>{inner}</em>,
          );
          i = j + mark.length;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  if (buf) out.push(buf);
  return out;
}

/** Inline text with soft line breaks kept (agents often hard-wrap on purpose). */
function inlineLines(text: string, key: string): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  lines.forEach((l, idx) => {
    if (idx) out.push(<br key={`${key}br${idx}`} />);
    out.push(...inline(l, `${key}l${idx}`));
  });
  return out;
}

// ---------------------------------------------------------------- code

const KEYWORDS = new Set(
  (
    'fn let mut const pub use mod struct enum impl trait match if else for while loop return break continue ' +
    'async await move ref where type self Self crate super as in dyn static unsafe extern ' +
    'function var class extends import export from default new this typeof instanceof interface ' +
    'def lambda pass raise try except finally with yield elif not and or is None True False ' +
    'true false null undefined nil void do case switch'
  ).split(' '),
);
const SHELL_CMDS = new Set(
  'git cd ls cat echo npm pnpm npx yarn cargo just rustup brew sudo rm mv cp mkdir curl grep sed awk export source python python3 node make docker kubectl gh'.split(' '),
);
const TOKEN =
  /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.]*(?:e[+-]?\d+)?[a-z\d]*\b)|(\b[A-Za-z_][\w]*\b)|(--?[\w-]+)/g;

/** Light, dependency-free syntax tinting: comments, strings, numbers, keywords, types. */
function highlight(code: string, lang: string): ReactNode[] {
  const shell = /^(sh|bash|zsh|shell|console|fish)$/.test(lang);
  const hashComments = shell || /^(py|python|rb|ruby|toml|yaml|yml|ini|conf|dockerfile|make|makefile)$/.test(lang);
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of code.matchAll(TOKEN)) {
    const at = m.index;
    const [tok, comment, str, num, word, flag] = m;
    let cls = '';
    if (comment) {
      if (comment.startsWith('#') && !hashComments) {
        // `#` isn't a comment here (e.g. Rust attributes, CSS colours): plain text.
        continue;
      }
      if (comment.startsWith('#') && at > 0 && !/\s/.test(code[at - 1]!)) continue;
      cls = 'cm';
    } else if (str) cls = 'st';
    else if (num) cls = 'nu';
    else if (word) {
      const lineStart = code.lastIndexOf('\n', at - 1) + 1;
      const lead = code.slice(lineStart, at).trim();
      if (shell && (lead === '' || lead === '$' || lead.endsWith('&&') || lead.endsWith('|')) && SHELL_CMDS.has(word)) cls = 'kw';
      else if (!shell && KEYWORDS.has(word)) cls = 'kw';
      else if (!shell && /^[A-Z][a-z]/.test(word)) cls = 'ty';
      else if (!shell && code[at + word.length] === '(') cls = 'fn';
    } else if (flag && shell && (at === 0 || /\s/.test(code[at - 1]!))) cls = 'fl';
    if (!cls) continue;
    if (at > last) out.push(code.slice(last, at));
    out.push(
      <span key={n++} className={`tk-${cls}`}>
        {tok}
      </span>,
    );
    last = at + tok.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };
  return (
    <div className="md-code" onClick={(e) => e.stopPropagation()}>
      <div className="md-code__bar">
        <span className="md-code__lang">{lang || 'text'}</span>
        <button className="md-code__copy" onClick={copy} title="Copy code">
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>
      <pre className="md-code__pre">
        <code>{highlight(text, lang.toLowerCase())}</code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------- render

function renderBlocks(blocks: Block[], key: string, tight = false): ReactNode[] {
  return blocks.map((b, idx) => {
    const k = `${key}.${idx}`;
    switch (b.k) {
      case 'p':
        return tight ? (
          <span key={k} className="md-li-text">
            {inlineLines(b.text, k)}
          </span>
        ) : (
          <p key={k} className="md-p">
            {inlineLines(b.text, k)}
          </p>
        );
      case 'h': {
        const H = `h${Math.min(6, b.level + 2)}` as 'h3';
        return (
          <H key={k} className={`md-h md-h${b.level}`}>
            {inline(b.text, k)}
          </H>
        );
      }
      case 'code':
        return <CodeBlock key={k} lang={b.lang} text={b.text} />;
      case 'quote':
        return (
          <blockquote key={k} className="md-quote">
            {renderBlocks(b.children, k)}
          </blockquote>
        );
      case 'hr':
        return <hr key={k} className="md-hr" />;
      case 'table':
        return (
          <div key={k} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {b.head.map((c, ci) => (
                    <th key={ci} style={{ textAlign: alignCss(b.align[ci]) }}>
                      {inline(c, `${k}h${ci}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {b.head.map((_, ci) => (
                      <td key={ci} style={{ textAlign: alignCss(b.align[ci]) }}>
                        {inline(r[ci] ?? '', `${k}r${ri}c${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'list': {
        const L = b.ordered ? 'ol' : 'ul';
        return (
          <L key={k} className={`md-list ${b.ordered ? 'md-ol' : 'md-ul'}`} start={b.ordered && b.start !== 1 ? b.start : undefined}>
            {b.items.map((item, ii) => {
              const check = b.checks[ii];
              const single = item.length >= 1 && item[0]!.k === 'p';
              return (
                <li key={ii} className={check === null || check === undefined ? '' : `md-task ${check ? 'md-task--done' : ''}`}>
                  {check !== null && check !== undefined && (
                    <span className="md-check" aria-hidden>
                      {check ? '✓' : ''}
                    </span>
                  )}
                  {renderBlocks(item, `${k}i${ii}`, single && item.length <= 3)}
                </li>
              );
            })}
          </L>
        );
      }
    }
  });
}

function alignCss(a: 'l' | 'c' | 'r' | undefined): 'left' | 'center' | 'right' {
  return a === 'c' ? 'center' : a === 'r' ? 'right' : 'left';
}

/** Renders Markdown text. Memoised: re-parses only when the text changes. */
export const Markdown = memo(function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return <div className={`md ${className}`}>{renderBlocks(parseBlocks(text), 'b')}</div>;
});
