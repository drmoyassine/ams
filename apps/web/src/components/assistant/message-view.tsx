import { useState } from 'react';
import type { AssistantLink, AssistantMessage, MemoryProposalPart, MemoryScopeType, MessagePart } from '@ams/shared';
import { Button } from '../ui/button';
import { ApiError } from '../../lib/framework-api';
import type { AssistantApi } from '../../lib/assistant-api';
import type { ScreenContext } from '../../lib/assistant-screen';
import { MarkdownLite } from './markdown-lite';

const selectClass = 'h-10 w-full rounded-md border border-border bg-background px-2 text-sm';

/** A requirement code, a source page or a version the assistant looked at: a small button that opens it. */
export function LinkChip({ link, onOpen }: { link: AssistantLink; onOpen: (l: AssistantLink) => void }) {
  const text = link.kind === 'requirement' ? link.code : link.label;
  const what = link.kind === 'requirement' ? `Open requirement ${link.label}` : link.kind === 'source' ? `Open ${link.label}` : `Open ${link.label}`;
  return (
    <button type="button" onClick={() => onOpen(link)} aria-label={what} title={link.label} dir="auto"
      className="min-h-8 max-w-full truncate rounded-full border border-border bg-background px-2.5 py-0.5 text-xs hover:bg-muted">{text}</button>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Looked up 3 things", collapsed; open it to see each step and jump to what it found. */
function Steps({ parts, running, onOpen }: { parts: MessagePart[]; running: boolean; onOpen: (l: AssistantLink) => void }) {
  const calls = parts.filter((p) => p.type === 'tool_call');
  const results = parts.filter((p): p is Extract<MessagePart, { type: 'tool_result' }> => p.type === 'tool_result');
  if (calls.length === 0) return null;
  const refused = results.filter((r) => r.refused).length;
  return (
    <details className="rounded-md border border-border bg-background text-sm" data-testid="assistant-steps">
      <summary className="cursor-pointer px-3 py-2">
        {running ? `Looking things up… (${plural(calls.length, 'step')} so far)` : `Looked up ${plural(calls.length, 'thing')}`}
        {refused > 0 && <span className="text-muted-foreground"> · {refused} not allowed</span>}
      </summary>
      <ol className="space-y-2 border-t border-border px-3 py-2">
        {calls.map((c) => {
          const r = results.find((x) => x.callId === c.id);
          return (
            <li key={c.id} className="space-y-1">
              <p dir="auto" className={r?.refused ? 'text-muted-foreground' : ''}>{r ? r.summary : `Looking: ${c.type === 'tool_call' ? c.summary : ''}`}</p>
              {r && r.links.length > 0 && <div className="flex flex-wrap gap-1">{r.links.map((l, i) => <LinkChip key={i} link={l} onOpen={onOpen} />)}</div>}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

const scopeKey = (type: MemoryScopeType, id: string | null) => `${type}:${id ?? ''}`;
const scopeWords = (type: MemoryScopeType, label: string) =>
  type === 'institution' ? 'The whole institution' : type === 'framework' ? `Standard ${label}` : type === 'version' ? `Version ${label}` : `Engagement ${label}`;

/** "Remember this?": the assistant's suggestion, which the person edits, saves or declines. Nothing is stored before Save. */
export function MemoryCard({ part, messageId, api, screen, locked, onResolved, onOpenMemory }: {
  part: MemoryProposalPart; messageId: string; api: AssistantApi; screen: ScreenContext; locked: boolean;
  onResolved: (partId: string, patch: Partial<MemoryProposalPart>) => void; onOpenMemory: () => void;
}) {
  const [text, setText] = useState(part.text);
  const [scope, setScope] = useState(scopeKey(part.scope.type, part.scope.id));
  const [visibility, setVisibility] = useState(part.visibility);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options: { key: string; type: MemoryScopeType; id: string | null; label: string }[] = [{ key: scopeKey(part.scope.type, part.scope.id), type: part.scope.type, id: part.scope.id, label: part.scope.label }];
  const add = (type: MemoryScopeType, id: string | null, label: string) => { const key = scopeKey(type, id); if (!options.some((o) => o.key === key)) options.push({ key, type, id, label }); };
  add('institution', null, 'the institution');
  if (screen.versionId) add('version', screen.versionId, screen.versionLabel ?? 'this version');
  if (screen.engagementId) add('engagement', screen.engagementId, screen.engagementLabel ?? 'this engagement');
  const chosen = options.find((o) => o.key === scope) ?? options[0]!;
  const everyone = chosen.type === 'institution' ? 'Everyone in the institution' : `Everyone who can see ${chosen.label}`;
  const id = `memory-${part.id}`;

  if (part.status === 'saved') {
    return (
      <div className="rounded-md border border-border bg-background p-3 text-sm" data-testid="memory-card-saved">
        <p dir="auto"><span aria-hidden="true">✓ </span>Saved to memory: “{part.text}”</p>
        <button type="button" className="mt-1 text-xs underline" onClick={onOpenMemory}>See all memory</button>
      </div>
    );
  }
  if (part.status === 'declined') return <p className="text-xs text-muted-foreground" data-testid="memory-card-declined">Not saved.</p>;

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const item = await api.confirmProposal(messageId, part.id, {
        text: text.trim(), scopeType: chosen.type, scopeId: chosen.id, visibility, kind: part.kind,
      });
      onResolved(part.id, { status: 'saved', text: item.text, memoryId: item.id, visibility: item.visibility, scope: item.scope });
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not save this'); } finally { setBusy(false); }
  };
  const decline = async () => {
    setBusy(true); setError(null);
    try { await api.declineProposal(messageId, part.id); onResolved(part.id, { status: 'declined' }); } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not do that'); } finally { setBusy(false); }
  };
  return (
    <section className="space-y-2 rounded-md border border-primary/40 bg-background p-3 text-sm" aria-labelledby={`${id}-h`} data-testid="memory-card">
      <h3 id={`${id}-h`} className="font-medium">Remember this?</h3>
      <label className="block">
        <span className="sr-only">What to remember</span>
        <textarea aria-label="What to remember" dir="auto" rows={2} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} disabled={busy}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs">About
          <select aria-label="About" className={selectClass} value={chosen.key} onChange={(e) => setScope(e.target.value)} disabled={busy}>
            {options.map((o) => <option key={o.key} value={o.key}>{scopeWords(o.type, o.label)}</option>)}
          </select>
        </label>
        <label className="block text-xs">Who sees it
          <select aria-label="Who sees it" className={selectClass} value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)} disabled={busy}>
            <option value="private">Only me</option>
            <option value="workspace">{everyone}</option>
          </select>
        </label>
      </div>
      {locked && <p className="text-xs text-muted-foreground">You can save this when the assistant has finished.</p>}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void save()} disabled={busy || locked || !text.trim()}>Save</Button>
        <Button type="button" variant="outline" onClick={() => void decline()} disabled={busy || locked}>Not now</Button>
      </div>
    </section>
  );
}

function Usage({ message }: { message: AssistantMessage }) {
  const u = message.usage;
  if (!u || message.status !== 'done') return null;
  const tokens = u.inputTokens + u.outputTokens;
  return (
    <p className="text-[11px] text-muted-foreground" data-testid="assistant-usage">
      {tokens.toLocaleString('en')} tokens · {plural(u.calls, 'model call')}{u.costUsd != null ? ` · about $${u.costUsd.toFixed(u.costUsd < 0.01 ? 4 : 2)}` : ''}
    </p>
  );
}

/** One message: the person's on the end side, the assistant's on the start side. */
export function MessageView({ message, api, screen, onOpenLink, onRetry, onResolved, onOpenMemory }: {
  message: AssistantMessage; api: AssistantApi; screen: ScreenContext; onOpenLink: (l: AssistantLink) => void; onRetry: (m: AssistantMessage) => void;
  onResolved: (messageId: string, partId: string, patch: Partial<MemoryProposalPart>) => void; onOpenMemory: () => void;
}) {
  if (message.role === 'user') {
    const text = message.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    return (
      <li className="flex justify-end" data-testid="message-user">
        <p dir="auto" className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-ee-sm bg-primary px-3 py-2 text-sm text-primary-foreground">{text}</p>
      </li>
    );
  }
  const running = message.status === 'queued' || message.status === 'running';
  const toolParts = message.parts.filter((p) => p.type === 'tool_call' || p.type === 'tool_result');
  const hasText = message.parts.some((p) => p.type === 'text');
  return (
    <li className="flex justify-start" data-testid="message-assistant" data-status={message.status ?? ''}>
      <div className="min-w-0 max-w-[92%] space-y-2 text-sm">
        <Steps parts={toolParts} running={running} onOpen={onOpenLink} />
        {message.parts.map((p) => {
          if (p.type === 'text') return <div key={p.id} className="rounded-2xl rounded-es-sm bg-muted px-3 py-2"><MarkdownLite text={p.text} /></div>;
          if (p.type === 'memory_proposal') {
            return <MemoryCard key={p.id} part={p} messageId={message.id} api={api} screen={screen} locked={running} onResolved={(partId, patch) => onResolved(message.id, partId, patch)} onOpenMemory={onOpenMemory} />;
          }
          return null;
        })}
        {running && (
          <p role="status" className="flex items-center gap-2 px-1 text-muted-foreground">
            <span aria-hidden="true" className="inline-block size-2 animate-pulse rounded-full bg-primary" />
            {toolParts.length > 0 ? 'Looking things up…' : message.status === 'queued' ? 'Waiting to start…' : 'Thinking…'}
          </p>
        )}
        {message.status === 'failed' && (
          <div role="alert" className="space-y-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800" data-testid="assistant-error">
            <p dir="auto">{hasText ? 'I could not finish this answer. ' : ''}{message.error ?? 'Something went wrong.'}</p>
            <Button type="button" variant="outline" onClick={() => onRetry(message)}>Retry</Button>
          </div>
        )}
        {message.status === 'cancelled' && <p className="px-1 text-muted-foreground">Stopped.</p>}
        <Usage message={message} />
      </div>
    </li>
  );
}
