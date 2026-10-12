import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatCell, type DataColumn, type EvidenceItem } from '@ams/shared';
import type { EvidenceApi } from '../lib/evidence-api';
import { DataFormView } from './data-form';
import { useConfirm } from './confirm-dialog';
import { RequestFormDialog, RequestList } from './evidence-requests';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** Where signed-in people answer a data item's form, and where its public link opens (DEC-020). */
export const formUrl = (itemId: string) => `${window.location.origin}/forms/${itemId}`;
export const publicFormUrl = (token: string) => `${window.location.origin}/f/${token}`;

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <Input readOnly aria-label={label} value={value} onFocus={(e) => e.currentTarget.select()} />
      <Button type="button" variant="outline" onClick={() => { void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined); }}>{copied ? 'Copied' : 'Copy'}</Button>
    </div>
  );
}

/** The form: whether it takes responses, how to share it, and what it looks like. */
export function FormTab({ item, api, canWrite }: { item: EvidenceItem; api: EvidenceApi; canWrite: boolean }) {
  const qc = useQueryClient();
  const form = useQuery({ queryKey: ['data-form', item.id], queryFn: () => api.form(item.id) });
  const spec = useQuery({ queryKey: ['data-definition', item.id], queryFn: () => api.dataDefinition(item.id) });
  const requests = useQuery({ queryKey: ['form-requests', item.id], queryFn: () => api.formRequests(item.id) });
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const confirm = useConfirm();
  // The library card shows whether the form is open, so the list is refreshed too.
  const act = (fn: () => Promise<unknown>) => { setError(''); fn().then(() => Promise.all([qc.invalidateQueries({ queryKey: ['data-form', item.id] }), qc.invalidateQueries({ queryKey: ['evidence'] })]), (e: Error) => setError(e.message)); };
  if (!form.data || !spec.data) return <p className="text-sm">Loading…</p>;
  const f = form.data;
  return (
    <section aria-label="Form" className="space-y-4">
      <div className="space-y-3 rounded-md border border-border p-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" role="switch" aria-label="Accepting responses" checked={f.open} disabled={!canWrite}
            onChange={(e) => act(() => api.setFormOpen(item.id, e.target.checked))} />
          {f.open ? 'Accepting responses' : 'Not accepting responses'}
        </label>
        {f.open && (
          <>
            <div className="space-y-1 text-sm">
              <p>People with an AMS account answer here (they sign in):</p>
              <CopyField label="Form link for AMS users" value={formUrl(item.id)} />
            </div>
            {canWrite && (
              <div className="space-y-1 text-sm">
                <p>Anyone can answer through a public link, as often as they like, until you turn it off:</p>
                {f.linkToken ? (
                  <>
                    <CopyField label="Public form link" value={publicFormUrl(f.linkToken)} />
                    <div className="flex gap-2">
                      <Button type="button" variant="ghost" onClick={() => void confirm({ title: 'Make a new link?', message: 'The current link stops working. Anyone who has it will need the new one.', confirmLabel: 'Make a new link' }).then((ok) => { if (ok) act(() => api.newFormLink(item.id)); })}>New link</Button>
                      <Button type="button" variant="ghost" onClick={() => act(() => api.removeFormLink(item.id))}>Turn off public link</Button>
                    </div>
                  </>
                ) : <Button type="button" variant="outline" onClick={() => act(() => api.newFormLink(item.id))}>Create public link</Button>}
              </div>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">The questions are the columns of the definition. Responses wait under Responses until someone adds them to the data.</p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      </div>
      <section aria-label="Requests to fill in" className="space-y-2 rounded-md border border-border p-4">
        <div className="flex items-center gap-2">
          <h4 className="font-medium">Ask specific people</h4>
          {canWrite && <Button type="button" variant="outline" className="ms-auto" onClick={() => setAsking(true)}>Ask people to fill it in</Button>}
        </div>
        <p className="text-xs text-muted-foreground">Each person gets a request to answer once, by a due date, whether or not the form is open to everyone.</p>
        {(requests.data?.length ?? 0) > 0 && (
          <RequestList requests={requests.data!} api={api} canManage={canWrite} setError={setError}
            onChange={() => void qc.invalidateQueries({ queryKey: ['form-requests', item.id] })} />
        )}
      </section>
      {asking && <RequestFormDialog api={api} item={item} onClose={() => setAsking(false)}
        onDone={() => { for (const queryKey of [['form-requests', item.id], ['evidence-requests'], ['evidence']]) void qc.invalidateQueries({ queryKey }); }} />}
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Preview</p>
        <DataFormView preview form={{ title: item.title, definition: spec.data.definition, institutionName: '', columns: spec.data.columns }} />
      </div>
    </section>
  );
}

/** The responses, as a sheet: who and when, and whether each is part of the data yet. New ones are added in one step. */
export function ResponsesTab({ item, api, canWrite, columns, onAdded }: { item: EvidenceItem; api: EvidenceApi; canWrite: boolean; columns: DataColumn[]; onAdded: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['data-responses', item.id], queryFn: () => api.responses(item.id) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const pending = (list.data ?? []).filter((r) => r.includedInVersionNo === null);
  const add = async () => {
    setBusy(true); setError(''); setInfo('');
    try {
      const v = await api.addResponsesToData(item.id);
      setInfo(`Added to the data as version ${v.versionNo} (${v.rowCount} rows).`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['data-responses', item.id] }), qc.invalidateQueries({ queryKey: ['data-form', item.id] })]);
      onAdded();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (!list.data) return <p className="text-sm">Loading…</p>;
  return (
    <section aria-label="Responses" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">{list.data.length} response{list.data.length === 1 ? '' : 's'} · {pending.length} not yet in the data</span>
        {canWrite && pending.length > 0 && (
          <Button type="button" className="ms-auto" disabled={busy} onClick={() => void add()}>{busy ? 'Adding…' : `Add ${pending.length} response${pending.length === 1 ? '' : 's'} to the data`}</Button>
        )}
      </div>
      {info && <p role="status" className="text-sm">{info}</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {list.data.length === 0 ? <p className="text-sm text-muted-foreground">No responses yet.</p> : (
        <div className="max-h-[32rem] overflow-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm" aria-label="Responses">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th scope="col" className="border-b border-border px-2 py-1 text-start font-medium">Received</th>
                <th scope="col" className="min-w-28 border-b border-s border-border px-2 py-1 text-start font-medium">From</th>
                {columns.map((c) => <th key={c.key} scope="col" className="min-w-32 border-b border-s border-border px-2 py-1 text-start font-medium" dir="auto">{c.label}</th>)}
                <th scope="col" className="whitespace-nowrap border-b border-s border-border px-2 py-1 text-start font-medium">In the data</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id} className="border-b border-border" data-testid="data-response">
                  <td className="whitespace-nowrap px-2 py-1">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="border-s border-border px-2 py-1">{r.submittedByName ?? (r.via === 'link' ? 'Public link' : '—')}</td>
                  {columns.map((c) => <td key={c.key} className="border-s border-border px-2 py-1" dir="auto">{formatCell(c, r.answers[c.key] ?? null)}</td>)}
                  <td className="border-s border-border px-2 py-1">{r.includedInVersionNo === null ? <span className="rounded bg-amber-50 px-1.5 text-xs text-amber-900">New</span> : `Version ${r.includedInVersionNo}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
