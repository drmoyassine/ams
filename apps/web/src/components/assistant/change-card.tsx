import { useId, useState } from 'react';
import type { ChangeProposalPart } from '@ams/shared';
import { Button } from '../ui/button';
import { ApiError } from '../../lib/framework-api';
import type { AssistantApi } from '../../lib/assistant-api';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SKIPPED_OPEN = 3;

/**
 * The assistant's proposal, in plain words: what it will do, how many items, a few real before / after lines, what is skipped
 * and why, every delete named. Three buttons: Do it, Change it, Cancel. Nothing has been changed until Do it is pressed; there is no
 * other way to apply it (the button asks the server for a one-time token for exactly this proposal and uses it at once). After it
 * the card shows the result with Undo and Redo. All text is rendered as text (dir="auto"), never as HTML.
 */
export function ChangeCard({ part, messageId, api, locked, onUpdate, onChangeIt, onChanged }: {
  part: ChangeProposalPart; messageId: string; api: AssistantApi;
  /** The assistant is still answering: the buttons wait. */
  locked: boolean;
  onUpdate: (partId: string, next: ChangeProposalPart) => void;
  /** "Change it": the person wants something different; the composer takes over. */
  onChangeIt: () => void;
  /** The data under the screens changed (applied, undone, redone): refresh what is shown. */
  onChanged: () => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState<null | 'checking' | 'applying' | 'cancelling' | 'undoing' | 'redoing'>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = part.status === 'pending';
  const disabled = !pending || locked || busy !== null;

  const fail = (e: unknown, fallback: string) => {
    // A confirmation that was used, expired or never existed: the proposal needs asking for again.
    const gone = e instanceof ApiError && e.status === 409 && e.details?.code === 'confirmation';
    setError(gone ? 'This proposal changed or expired: ask me again.' : e instanceof ApiError ? e.message : fallback);
  };
  const doIt = async () => {
    setError(null); setBusy('checking');
    try {
      const c = await api.confirmChange(messageId, part.id);
      if (c.status !== 'ready' || !c.token) { onUpdate(part.id, c.part); return; }
      setBusy('applying');
      const a = await api.applyChange(messageId, part.id, c.token);
      onUpdate(part.id, a.part);
      if (a.status === 'applied') onChanged();
    } catch (e) { fail(e, 'Could not apply this change. Nothing was changed.'); } finally { setBusy(null); }
  };
  const cancel = async () => {
    setError(null); setBusy('cancelling');
    try { onUpdate(part.id, await api.declineChange(messageId, part.id)); } catch (e) { fail(e, 'Could not cancel'); } finally { setBusy(null); }
  };
  const undo = async (redo: boolean) => {
    if (!part.result) return;
    setError(null); setBusy(redo ? 'redoing' : 'undoing');
    try {
      const ok = await (redo ? api.redoChange : api.undoChange)(part.result.changeSetId, part.result.message);
      if (ok) onChanged();
    } finally { setBusy(null); }
  };

  const r = part.result;
  const skippedShown = part.skipped.slice(0, 25);
  const hasDeletes = part.deletesCount > 0;
  const stateWords = busy === 'checking' ? 'Checking that this still holds…' : busy === 'applying' ? 'Making the change…' : busy === 'cancelling' ? 'Cancelling…' : busy === 'undoing' ? 'Taking it back…' : busy === 'redoing' ? 'Doing it again…' : '';

  return (
    <section aria-labelledby={`${id}-h`} data-testid="change-card" data-status={part.status}
      className={`space-y-3 rounded-md border bg-background p-3 text-sm ${pending ? 'border-primary/50' : 'border-border'} ${part.status === 'superseded' || part.status === 'cancelled' ? 'opacity-70' : ''}`}>
      <div>
        <h3 id={`${id}-h`} className="font-medium">{part.newDraft ? 'Start a new draft' : 'Proposed change'} <span className="font-normal text-muted-foreground" dir="auto">· {part.versionLabel}</span></h3>
        <p dir="auto" className="mt-1">{part.summary}</p>
      </div>

      <div>
        <p className="font-medium" data-testid="change-count">
          {part.newDraft ? `A new draft, ${part.newDraft.edition}, copied from ${part.versionLabel}` : `${plural(part.counts.items, 'item')} ${pending ? 'will change' : part.status === 'applied' ? 'changed' : 'would have changed'}`}
        </p>
        {part.counts.byOperation.length > 0 && !part.newDraft && (
          <ul className="mt-1 list-disc ps-5" aria-label="What will be done">
            {part.counts.byOperation.map((o, i) => <li key={`${o.op}-${i}`}><span dir="auto">{o.label}</span>: {plural(o.items, 'item')}</li>)}
          </ul>
        )}
      </div>

      {part.examples.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">For example</p>
          <ul className="mt-1 space-y-1.5" aria-label="Examples" data-testid="change-examples">
            {part.examples.map((e, i) => (
              <li key={i} className="rounded border border-border bg-muted/40 px-2 py-1">
                <span className="font-medium" dir="auto">{e.code}</span> <span className="text-muted-foreground">({e.field})</span>
                <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1">
                  <span dir="auto" className="break-words text-muted-foreground line-through decoration-muted-foreground/50 [overflow-wrap:anywhere]">{e.before}</span>
                  <span aria-label="becomes" className="rtl:rotate-180">→</span>
                  <span dir="auto" className="break-words [overflow-wrap:anywhere]">{e.after}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasDeletes && (
        <div data-testid="change-deletes">
          <p className="font-medium">{plural(part.deletesCount, 'delete')}, to the Trash (kept 30 days)</p>
          <ul className="mt-1 list-disc ps-5" aria-label="What will be deleted">
            {part.deletes.map((d, i) => (
              <li key={i}><span dir="auto">{d.code} {d.title}</span>{d.subItems || d.notes ? <span className="text-muted-foreground"> (with {[d.subItems ? plural(d.subItems, 'sub-item') : '', d.notes ? plural(d.notes, 'note') : ''].filter(Boolean).join(' and ')})</span> : null}</li>
            ))}
          </ul>
          {part.deletesCount > part.deletes.length && <p className="text-xs text-muted-foreground">and {part.deletesCount - part.deletes.length} more</p>}
        </div>
      )}

      {part.skippedCount > 0 && (
        <details open={part.skippedCount <= SKIPPED_OPEN} data-testid="change-skipped">
          <summary className="cursor-pointer font-medium">{plural(part.skippedCount, 'item')} skipped</summary>
          <ul className="mt-1 list-disc ps-5">
            {skippedShown.map((s, i) => <li key={i}>{s.code ? <span dir="auto" className="font-medium">{s.code}: </span> : null}<span dir="auto">{s.reason}</span></li>)}
          </ul>
          {part.skippedCount > skippedShown.length && <p className="text-xs text-muted-foreground">and {part.skippedCount - skippedShown.length} more</p>}
        </details>
      )}

      {part.counts.writtenByAssistant > 0 && <p className="text-xs">{plural(part.counts.writtenByAssistant, 'text')} will be written by the assistant. They are marked until you keep or revert them.</p>}
      {part.warnings.map((w, i) => <p key={i} className="text-xs text-muted-foreground" dir="auto">{w}</p>)}
      {part.remaining > 0 && <p className="text-xs">{plural(part.remaining, 'more item change')} did not fit in this step. Ask me for the next step after you apply this one.</p>}
      {!part.dryRun.ok && part.dryRun.problems.map((p, i) => <p key={i} role="alert" className="text-red-700" dir="auto">{p}</p>)}

      {pending && (
        <>
          <p className="text-xs text-muted-foreground">Nothing has been changed yet. The change can be undone, and anything deleted goes to the Trash.</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Your answer">
            <Button type="button" className="min-h-11" onClick={() => void doIt()} disabled={disabled} data-testid="change-do-it">Do it</Button>
            <Button type="button" variant="outline" className="min-h-11" onClick={onChangeIt} disabled={disabled} data-testid="change-change-it">Change it</Button>
            <Button type="button" variant="ghost" className="min-h-11" onClick={() => void cancel()} disabled={disabled} data-testid="change-cancel">Cancel</Button>
          </div>
          {locked && <p className="text-xs text-muted-foreground">You can answer when the assistant has finished.</p>}
        </>
      )}

      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{stateWords}</p>

      {part.status === 'applied' && r && (
        <div className="space-y-2" data-testid="change-result">
          <p className="font-medium" dir="auto"><span aria-hidden="true">✓ </span>{r.state === 'undone' ? `Undone: ${r.message}` : r.message}</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Take it back or do it again">
            <Button type="button" variant="outline" className="min-h-11" onClick={() => void undo(false)} disabled={busy !== null || r.state !== 'applied'}>Undo</Button>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => void undo(true)} disabled={busy !== null || r.state !== 'undone'}>Redo</Button>
          </div>
        </div>
      )}
      {part.status === 'failed' && <p role="alert" className="text-red-800" data-testid="change-failed" dir="auto">Nothing was changed. {part.error ?? 'It could not be applied.'}</p>}
      {part.status === 'stale' && (
        <p role="alert" className="text-amber-900" data-testid="change-stale" dir="auto">This proposal changed or expired: ask me again.{part.error ? ` (${part.error})` : ''}</p>
      )}
      {part.status === 'cancelled' && <p className="text-muted-foreground" data-testid="change-cancelled">Cancelled. Nothing was changed.</p>}
      {part.status === 'superseded' && <p className="text-muted-foreground" data-testid="change-superseded">Replaced by a newer message. Nothing was changed.</p>}
      {error && <p role="alert" className="text-red-700" data-testid="change-error" dir="auto">{error}</p>}
    </section>
  );
}
