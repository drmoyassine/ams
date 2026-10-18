import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImportApplyResult, ImportProposal, ImportProposalStatus } from '@ams/shared';
import { SourceViewer } from '../../pages/version/source-viewer';
import type { DocumentsApi } from '../../lib/documents-api';
import { ApiError } from '../../lib/framework-api';
import { onUndone, redoDescriptor, undoDescriptor } from '../../lib/undo';
import { useAction } from '../../lib/use-action';
import { useConfirm } from '../confirm-dialog';
import { Button } from '../ui/button';
import { humanize, RunChip, spendText } from './parts';

const STATUS: Record<ImportProposalStatus, { label: string; cls: string }> = {
  pending: { label: 'Waiting', cls: 'bg-muted text-muted-foreground' },
  accepted: { label: 'Accepted', cls: 'bg-emerald-50 text-emerald-900' },
  edited: { label: 'Edited', cls: 'bg-emerald-50 text-emerald-900' },
  skipped: { label: 'Skipped', cls: 'bg-muted text-muted-foreground line-through' },
  applied: { label: 'Applied', cls: 'bg-sky-50 text-sky-900' },
};
const READY: ImportProposalStatus[] = ['accepted', 'edited'];
type Cell = string | number | boolean | null | undefined;
const isCell = (v: unknown): v is Cell => v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The values columns: the keys the proposals share, in the order they first appear (at most eight). */
function columnsOf(list: ImportProposal[]): string[] {
  const keys: string[] = [];
  for (const p of list) for (const k of Object.keys(asRecord(p.effective))) if (!keys.includes(k)) keys.push(k);
  return keys.slice(0, 8);
}

/** One editable cell. Text keeps its own direction (dir="auto"); a change is saved when the cell loses focus. */
function ValueCell({ label, value, disabled, options, listId, onSave }: { label: string; value: unknown; disabled: boolean; options?: string[]; listId?: string; onSave: (v: Cell) => void }) {
  const [draft, setDraft] = useState<string>(isCell(value) ? String(value ?? '') : JSON.stringify(value));
  useEffect(() => { setDraft(isCell(value) ? String(value ?? '') : JSON.stringify(value)); }, [value]);
  if (options && (value === null || value === undefined || typeof value === 'string')) {
    // A field with a fixed list of values: a choice, so nothing typed can fail to fit.
    return (
      <select aria-label={label} value={value ?? ''} disabled={disabled} onChange={(e) => onSave(e.target.value === '' ? null : e.target.value)}
        className="w-full min-w-28 rounded border border-border bg-background px-2 py-1 text-sm disabled:border-transparent disabled:bg-transparent">
        <option value="">—</option>
        {options.map((o) => <option key={o} value={o}>{humanize(o)}</option>)}
      </select>
    );
  }
  if (typeof value === 'boolean') {
    return <input type="checkbox" aria-label={label} checked={value} disabled={disabled} onChange={(e) => onSave(e.target.checked)} />;
  }
  if (!isCell(value)) return <code dir="auto" className="block max-w-56 truncate text-xs" title={JSON.stringify(value)}>{JSON.stringify(value)}</code>;
  const commit = () => {
    if (draft === String(value ?? '')) return;
    if (typeof value === 'number') { const n = Number(draft); if (draft.trim() !== '' && Number.isFinite(n)) onSave(n); else setDraft(String(value)); return; }
    onSave(draft.trim() === '' && (value === null || value === undefined) ? null : draft);
  };
  return (
    <input aria-label={label} dir="auto" value={draft} disabled={disabled} list={listId} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
      className="w-full min-w-28 rounded border border-border bg-background px-2 py-1 text-sm disabled:border-transparent disabled:bg-transparent" />
  );
}

/**
 * The proposals of one import run, to review: a table of what the AI found beside the page it came from (the page text with the
 * quote highlighted by the server's matcher), editable values, accept or skip per row or in bulk, and "Apply N": one confirmed
 * action that writes the accepted rows as you, in one go, with Undo and Redo. Needs canWrite to change anything.
 */
export function ImportReview({ api, runId, canWrite, onBack }: { api: DocumentsApi; runId: string; canWrite: boolean; onBack?: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = ['import-proposals', runId];
  const q = useQuery({ queryKey: key, queryFn: () => api.proposals(runId) });
  const [error, setError] = useState('');
  const run = useAction(setError);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ apply: ImportApplyResult; label: string; undone: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const list = q.data?.proposals ?? [];
  const cols = useMemo(() => columnsOf(list), [list]);
  const options = q.data?.fieldOptions ?? {};
  // Fields with suggestions (the org chart's units) offer them, plus what the other rows already say, while a new value can be typed.
  const suggestions = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [k, base] of Object.entries(q.data?.fieldSuggestions ?? {})) {
      const seen = new Set(base);
      for (const p of list) { const v = asRecord(p.effective)[k]; if (typeof v === 'string' && v.trim()) seen.add(v.trim()); }
      out[k] = [...seen].sort((a, b) => a.localeCompare(b));
    }
    return out;
  }, [q.data, list]);
  const listIdOf = (k: string) => (suggestions[k] ? `import-${runId}-${k}` : undefined);
  const [bulkField, setBulkField] = useState('');
  const [bulkValue, setBulkValue] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  // An Undo or Redo from the toast or the keyboard changes what is applied: look again.
  useEffect(() => onUndone(() => { void qc.invalidateQueries({ queryKey: key }); }), [qc, runId]);
  const current = list.find((p) => p.id === selected) ?? list[0];
  const ready = list.filter((p) => READY.includes(p.status));
  const targetNoun = q.data?.run.targetLabel.toLowerCase() ?? 'items';
  const editable = (p: ImportProposal) => canWrite && p.status !== 'applied';

  const decide = async (ids: string[], decision: 'accept' | 'skip' | 'reset') => {
    setError('');
    if (!ids.length) return;
    await run(() => api.decide(runId, { ids, decision }));
    setChecked(new Set());
    await refresh();
  };
  const save = async (p: ImportProposal, k: string, v: Cell) => {
    setError('');
    try { await api.editProposal(p.id, { ...asRecord(p.effective), [k]: v }); } catch (e) {
      if (e instanceof ApiError) setError(`${humanize(k)}: ${e.issues.length ? e.issues.map((i) => i.message).join('; ') : e.message}`); else throw e;
    }
    await refresh();
  };
  /** Sets one field to one value on every selected proposal (e.g. the degree level of the 21 programs of one heading). */
  const setForSelected = async (ids: string[]) => {
    if (!bulkField || !ids.length) return;
    setError(''); setBusy(true);
    const v: Cell = bulkValue.trim() === '' ? null : bulkValue;
    const failed: string[] = [];
    for (const id of ids) {
      const p = list.find((x) => x.id === id);
      if (!p || p.status === 'applied') continue;
      try { await api.editProposal(p.id, { ...asRecord(p.effective), [bulkField]: v }); } catch (e) {
        if (e instanceof ApiError) failed.push(`${p.label}: ${e.issues.length ? e.issues.map((i) => i.message).join('; ') : e.message}`); else { setBusy(false); throw e; }
      }
    }
    setBusy(false);
    if (failed.length) setError(`${humanize(bulkField)} was not set on ${failed.length}: ${failed.slice(0, 3).join(' · ')}${failed.length > 3 ? ' …' : ''}`);
    await refresh();
  };
  const apply = async () => {
    setError(''); setResult(null);
    const preview = await run(() => api.applyPreview(runId));
    if (!preview || preview.count === 0) { if (preview) setError(preview.message); return; }
    const ok = await confirm({ title: `Apply ${preview.count} ${preview.count === 1 ? 'item' : 'items'}?`, message: preview.message, confirmLabel: `Apply ${preview.count}` });
    if (!ok) return;
    setBusy(true);
    const r = await run(() => api.apply(runId));
    setBusy(false);
    if (r) setResult({ apply: r, label: r.message.replace(/\.( .*)?$/, ''), undone: false });
    await refresh();
  };
  const undo = async () => {
    if (!result?.apply.applyId) return;
    if (await undoDescriptor(api.fetcher, api.undoDescriptor(result.apply.applyId, result.label))) setResult({ ...result, undone: true });
    await refresh();
  };
  const redo = async () => {
    if (!result?.apply.applyId) return;
    if (await redoDescriptor(api.fetcher, api.redoDescriptor(result.apply.applyId, result.label))) setResult({ ...result, undone: false });
    await refresh();
  };
  const allChecked = list.length > 0 && list.every((p) => checked.has(p.id));
  const noFlags = list.filter((p) => p.status === 'pending' && p.quoteVerified && p.flags.length === 0).map((p) => p.id);
  const pickable = [...checked].filter((id) => list.find((p) => p.id === id)?.status !== 'applied');

  return (
    <section aria-label="Review proposals" className="space-y-3">
      {Object.entries(suggestions).map(([k, vals]) => (
        <datalist key={k} id={listIdOf(k)}>{vals.map((v) => <option key={v} value={v} />)}</datalist>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {onBack && <Button type="button" variant="ghost" onClick={onBack}>← Back to documents</Button>}
        {q.data && <><h2 className="text-lg font-semibold">{q.data.run.targetLabel}: review</h2><RunChip status={q.data.run.status} /><span className="text-xs text-muted-foreground">{spendText(q.data.run.usage)}</span></>}
      </div>
      <p className="text-sm text-muted-foreground">The AI proposed these from your documents. Each is shown with the words it came from. Change a value, accept or skip each one, then apply: nothing is saved before that, and you can undo it.</p>
      {q.data?.run.status === 'failed' && q.data.run.error && <p role="note" className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">This import stopped: {q.data.run.error} What it had found before is below.</p>}
      {q.isError && <p role="alert" className="text-sm text-red-700">The proposals could not be loaded.</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {result && (
        <div role="status" className="space-y-1 rounded border border-border bg-muted/40 p-2 text-sm" data-testid="apply-result">
          <p>{result.undone ? `Undone: ${result.label}.` : result.apply.message}</p>
          {!result.undone && result.apply.skipped.length > 0 && (
            <ul aria-label="Left alone" className="list-disc ps-5 text-xs">
              {result.apply.skipped.map((s) => <li key={s.proposalId}><span dir="auto" className="font-medium">{s.label}</span>: {s.reason}</li>)}
            </ul>
          )}
          {result.apply.applyId && (result.undone
            ? <Button type="button" variant="outline" className="px-2 py-1 text-xs" onClick={() => void redo()}>Redo</Button>
            : <Button type="button" variant="outline" className="px-2 py-1 text-xs" onClick={() => void undo()}>Undo</Button>)}
        </div>
      )}
      {q.data && list.length === 0 && <p className="text-sm text-muted-foreground">Nothing was found in these documents.</p>}
      {list.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="min-w-0 space-y-2">
            {canWrite && (
              <div role="toolbar" aria-label="Decide on several" className="flex flex-wrap items-center gap-2 text-sm">
                <Button type="button" variant="outline" disabled={!pickable.length} onClick={() => void decide(pickable, 'accept')}>Accept selected</Button>
                <Button type="button" variant="outline" disabled={!pickable.length} onClick={() => void decide(pickable, 'skip')}>Skip selected</Button>
                <Button type="button" variant="ghost" disabled={!noFlags.length} onClick={() => void decide(noFlags, 'accept')}>Accept all without a flag ({noFlags.length})</Button>
                <span className="flex flex-wrap items-center gap-1" role="group" aria-label="Set a value on the selected">
                  <select aria-label="Field to set" value={bulkField} onChange={(e) => { setBulkField(e.target.value); setBulkValue(''); }}
                    className="rounded border border-border bg-background px-2 py-1 text-sm">
                    <option value="">Set a field…</option>
                    {cols.filter((k) => list.some((p) => isCell(asRecord(p.effective)[k]) && typeof asRecord(p.effective)[k] !== 'boolean')).map((k) => <option key={k} value={k}>{humanize(k)}</option>)}
                  </select>
                  {bulkField && (options[bulkField]
                    ? <select aria-label={`Value for ${humanize(bulkField)}`} value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} className="rounded border border-border bg-background px-2 py-1 text-sm">
                        <option value="">—</option>
                        {options[bulkField]!.map((o) => <option key={o} value={o}>{humanize(o)}</option>)}
                      </select>
                    : <input aria-label={`Value for ${humanize(bulkField)}`} dir="auto" list={listIdOf(bulkField)} value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} className="w-40 rounded border border-border bg-background px-2 py-1 text-sm" />)}
                  {bulkField && <Button type="button" variant="outline" disabled={!pickable.length || busy} onClick={() => void setForSelected(pickable)}>Set on {pickable.length} selected</Button>}
                </span>
                <Button type="button" className="ms-auto" disabled={!ready.length || busy} onClick={() => void apply()}>Apply {ready.length}</Button>
              </div>
            )}
            <div className="overflow-x-auto rounded-md border border-border">
              <table aria-label="Proposals" className="w-full text-start text-sm">
                <thead className="bg-muted/50 text-xs">
                  <tr>
                    {canWrite && <th className="w-8 p-2"><input type="checkbox" aria-label="Select all" checked={allChecked} onChange={() => setChecked(allChecked ? new Set() : new Set(list.map((p) => p.id)))} /></th>}
                    <th className="p-2 text-start font-medium">Decision</th>
                    {cols.map((k) => <th key={k} className="p-2 text-start font-medium">{humanize(k)}</th>)}
                    <th className="p-2 text-start font-medium">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => {
                    const values = asRecord(p.effective);
                    const sel = current?.id === p.id;
                    return (
                      <tr key={p.id} data-testid="proposal" data-status={p.status} aria-selected={sel} className={`border-t border-border align-top ${sel ? 'bg-primary/5' : ''}`}>
                        {canWrite && <td className="p-2"><input type="checkbox" aria-label={`Select ${p.label}`} checked={checked.has(p.id)} disabled={p.status === 'applied'}
                          onChange={() => setChecked((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })} /></td>}
                        <td className="p-2">
                          <div className="flex flex-col items-start gap-1">
                            <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span>
                            {editable(p) && (
                              <span className="flex gap-1">
                                <button type="button" className="text-xs underline" aria-label={`Accept ${p.label}`} disabled={p.status === 'accepted' || p.status === 'edited'} onClick={() => void decide([p.id], 'accept')}>Accept</button>
                                <button type="button" className="text-xs underline" aria-label={`Skip ${p.label}`} disabled={p.status === 'skipped'} onClick={() => void decide([p.id], 'skip')}>Skip</button>
                              </span>
                            )}
                            {p.status === 'skipped' && isSkippedByTarget(p) && <span className="max-w-40 text-xs text-muted-foreground">{skipReason(p)}</span>}
                          </div>
                        </td>
                        {cols.map((k) => (
                          <td key={k} className="p-2"><ValueCell label={`${humanize(k)} of ${p.label}`} value={values[k]} disabled={!editable(p)} {...(options[k] ? { options: options[k] } : {})} {...(listIdOf(k) ? { listId: listIdOf(k)! } : {})} onSave={(v) => void save(p, k, v)} /></td>
                        ))}
                        <td className="p-2">
                          <button type="button" className="text-start text-xs underline" aria-label={`Show the source of ${p.label}`} onClick={() => setSelected(p.id)}>
                            <span dir="auto">{p.documentName ?? 'document'}</span>{p.pageNo ? `, page ${p.pageNo}` : ''}
                          </button>
                          {(!p.quoteVerified || p.flags.length > 0) && (
                            <ul aria-label={`To look at for ${p.label}`} className="mt-1 space-y-0.5 text-xs text-amber-900">
                              {!p.quoteVerified && !p.flags.some((f) => /quote/i.test(f)) && <li>The quote was not found on the page it cites.</li>}
                              {p.flags.map((f) => <li key={f}>{f}</li>)}
                            </ul>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">{list.length} {targetNoun} proposed · {ready.length} accepted · {list.filter((p) => p.status === 'applied').length} applied</p>
          </div>
          <div className="min-w-0 xl:sticky xl:top-4 xl:self-start">
            {current?.documentId && current.documentName && IMAGE_NAME.test(current.documentName) && <div className="mb-3"><SourceImage api={api} documentId={current.documentId} name={current.documentName} /></div>}
            {current && (current.documentId && current.pageNo
              ? <SourceViewer key={current.id} api={{ pageView: api.pageView, sourceFileUrl: api.fileUrl }} title={current.label} heading="Source page"
                citations={[{ key: current.id, label: current.documentName ?? 'document', documentId: current.documentId, page: current.pageNo, quote: current.quote }]} />
              : <p className="text-sm text-muted-foreground">This one does not cite a page.</p>)}
          </div>
        </div>
      )}
    </section>
  );
}

const IMAGE_NAME = /\.(png|jpe?g|webp|gif)$/i;

/** The picture itself, beside the proposals, when the source is an image (an org chart): the person checks each box against it. */
function SourceImage({ api, documentId, name }: { api: DocumentsApi; documentId: string; name: string | null }) {
  return (
    <figure className="space-y-1" data-testid="source-image">
      <img src={api.fileUrl(documentId)} alt={`The uploaded image ${name ?? ''}`.trim()} className="max-h-[50dvh] w-full rounded-md border border-border bg-background object-contain" />
      <figcaption className="text-xs text-muted-foreground">The image the AI read. Check each proposed unit against it; the text below is the AI's reading of it.</figcaption>
    </figure>
  );
}

const isSkippedByTarget = (p: ImportProposal) => !!asRecord(p.appliedRef).skipped;
const skipReason = (p: ImportProposal) => String(asRecord(p.appliedRef).reason ?? '');
