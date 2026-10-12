import type { ReactNode } from 'react';

/**
 * The assistant's text, as plain React elements: paragraphs, bullet and numbered lists, **bold**, *italic*, `code` and fenced
 * code. It NEVER produces raw HTML (everything is a text node or an element we create), and it makes no links: whatever the
 * model writes, nothing in it can run or navigate. Each block takes `dir="auto"` so Arabic and English paragraphs each read
 * the right way round.
 */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|(?<![*\w])\*([^*\n]+)\*(?![*\w]))/g;
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${n++}`;
    if (m[2] !== undefined) out.push(<strong key={key}>{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" dir="ltr">{m[3]}</code>);
    else out.push(<em key={key}>{m[4]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block = { kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] } | { kind: 'ol'; items: string[] } | { kind: 'code'; text: string };

function blocks(source: string): Block[] {
  const out: Block[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i += 1;
      out.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      const items: string[] = [];
      while (i < lines.length) {
        const m = (kind === 'ul' ? /^\s*[-*•]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/).exec(lines[i]!);
        if (!m) break;
        items.push(m[1]!);
        i += 1;
      }
      out.push({ kind, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*```/.test(lines[i]!) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)) para.push(lines[i++]!);
    out.push({ kind: 'p', lines: para });
  }
  return out;
}

export function MarkdownLite({ text }: { text: string }) {
  return (
    <div className="space-y-2 break-words">
      {blocks(text).map((b, i) => {
        if (b.kind === 'code') return <pre key={i} dir="ltr" className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{b.text}</pre>;
        if (b.kind === 'ul') return <ul key={i} dir="auto" className="list-disc space-y-1 ps-5">{b.items.map((t, j) => <li key={j} dir="auto">{inline(t, `${i}-${j}`)}</li>)}</ul>;
        if (b.kind === 'ol') return <ol key={i} dir="auto" className="list-decimal space-y-1 ps-5">{b.items.map((t, j) => <li key={j} dir="auto">{inline(t, `${i}-${j}`)}</li>)}</ol>;
        const lines = b.lines;
        return <p key={i} dir="auto">{lines.flatMap((l, j) => (j === 0 ? inline(l, `${i}-${j}`) : [<br key={`br${j}`} />, ...inline(l, `${i}-${j}`)]))}</p>;
      })}
    </div>
  );
}
