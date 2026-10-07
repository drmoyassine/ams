import { useEffect, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ContentText } from '../components/content-text';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { ApiError, type FrameworkApi, type FrameworkListItem, type Issue } from '../lib/framework-api';
import { can, useApi, useMe } from '../lib/me';

export const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const STATUS_LABEL = { draft: 'Draft', in_review: 'In review', published: 'Published', retired: 'Retired' } as const;

export const EyeIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
);
export const PencilIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);

/** One row per version: "Version 2027-28", its status, its date, and an icon to open it (edit while it is a draft, view once it is not). */
function Versions({ api, framework }: { api: FrameworkApi; framework: FrameworkListItem }) {
  const { data } = useQuery({ queryKey: ['versions', framework.id], queryFn: () => api.versions(framework.id) });
  return (
    <ul className="mt-3 divide-y divide-border rounded-md border border-border" aria-label={`Versions of ${framework.name}`}>
      {(data ?? []).map((v) => {
        const editable = v.status === 'draft' || v.status === 'in_review';
        const date = v.publishedAt ? `Published ${DATE.format(new Date(v.publishedAt))}` : v.effectiveFrom ? `Effective ${DATE.format(new Date(v.effectiveFrom))}` : 'Not published';
        return (
          <li key={v.id} className="flex items-center justify-between gap-3 px-3 py-2" data-testid="version-row">
            <span className="flex items-center gap-2 text-sm">
              <span className="font-medium">Version {v.edition}</span>
              <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{STATUS_LABEL[v.status]}</span>
            </span>
            <span className="flex items-center gap-3 text-sm text-muted-foreground">
              <span>{date}</span>
              <Link
                to="/settings/versions/$versionId" params={{ versionId: v.id }}
                aria-label={`${editable ? 'Edit' : 'View'} version ${v.edition} of ${framework.name}`} title={editable ? 'Edit this version' : 'View this version'}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-foreground hover:bg-muted"
              >
                {editable ? <PencilIcon /> : <EyeIcon />}<span className="text-xs">{editable ? 'Edit' : 'View'}</span>
              </Link>
            </span>
          </li>
        );
      })}
      {data?.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No versions yet.</li>}
    </ul>
  );
}

function ImportForm({ api, canReview }: { api: FrameworkApi; canReview: boolean }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [edition, setEdition] = useState('');
  const [autoApprove, setAutoApprove] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; counts: string } | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      setIssues([]); setMessage(null); setDone(null);
      let file: unknown;
      try { file = JSON.parse(text); } catch (e) { setMessage(`Not valid JSON: ${(e as Error).message}`); return; }
      try {
        const r = await api.importFile({ file, ...(edition ? { edition } : {}), ...(autoApprove ? { autoApprove } : {}) });
        setDone({ id: r.version.id, counts: `${r.counts.requirements} requirements, ${r.counts.documents} documents, ${r.counts.templates} templates` });
        await qc.invalidateQueries({ queryKey: ['frameworks'] });
        await qc.invalidateQueries({ queryKey: ['versions'] });
      } catch (e) {
        if (e instanceof ApiError) { setMessage(e.message); setIssues(e.issues); } else throw e;
      }
    },
  });

  return (
    <Card>
      <h2 className="mb-2 text-lg font-semibold">Import a standard from a file</h2>
      <p className="mb-2 text-sm text-muted-foreground">Creates a new draft version. Nothing existing is changed.</p>
      <input
        type="file" accept="application/json,.json" aria-label="Standard file"
        onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }}
      />
      <textarea aria-label="Standard JSON" dir="ltr" rows={6} value={text} onChange={(e) => setText(e.target.value)} className="mt-2 w-full rounded-md border border-border p-2 font-mono text-xs" />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="text-sm">Edition (optional) <Input value={edition} onChange={(e) => setEdition(e.target.value)} className="w-40" /></label>
        {canReview && <label className="text-sm"><input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} /> Approve everything on import (trusted files)</label>}
        <Button type="button" disabled={!text.trim() || run.isPending} onClick={() => run.mutate()}>Import</Button>
      </div>
      {message && <p role="alert" className="mt-2 text-sm text-red-700">{message}</p>}
      {issues.length > 0 && <ul aria-label="Import problems" className="mt-1 list-disc space-y-1 ps-5 text-sm text-red-700">{issues.map((i, n) => <li key={n}><code>{i.path}</code>: {i.message}</li>)}</ul>}
      {done && (
        <p role="status" className="mt-2 text-sm text-emerald-800">
          Imported {done.counts}. <Link to="/settings/versions/$versionId" params={{ versionId: done.id }} className="underline">Open the draft</Link>
        </p>
      )}
    </Card>
  );
}

function NewFramework({ api, onCreated }: { api: FrameworkApi; onCreated: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async (f: FormData) => {
      setError(null);
      try {
        const acc = await api.createAccreditor({ name: String(f.get('accName')), shortName: String(f.get('accShort')), type: String(f.get('accType')) as 'institutional' });
        await api.createFramework({ accreditorId: acc.id, name: String(f.get('name')), scope: String(f.get('scope')) as 'institution' });
        await qc.invalidateQueries({ queryKey: ['frameworks'] });
        onCreated();
      } catch (e) { if (e instanceof ApiError) setError(e.message); else throw e; }
    },
  });
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); create.mutate(new FormData(e.currentTarget)); };
  return (
    <Card>
      <h2 className="mb-2 text-lg font-semibold">Create a standard from scratch</h2>
      <form onSubmit={submit} className="grid grid-cols-2 gap-2">
        <label className="text-sm">Accreditor name<Input name="accName" required /></label>
        <label className="text-sm">Short name<Input name="accShort" required /></label>
        <label className="text-sm">Accreditor type
          <select name="accType" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"><option value="institutional">Institutional</option><option value="programmatic">Programmatic</option><option value="regulatory">Regulatory</option></select>
        </label>
        <label className="text-sm">Standard name<Input name="name" required /></label>
        <label className="text-sm">Scope
          <select name="scope" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"><option value="institution">Institution</option><option value="program">Program</option><option value="both">Both</option></select>
        </label>
        <div className="flex items-end"><Button type="submit" disabled={create.isPending}>Create standard</Button></div>
      </form>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </Card>
  );
}

/** "New Standard": a small wizard that asks how to add it, then shows that form (PRD 7.7: import a file, or build one by hand). */
function NewStandardDialog({ api, canReview, onClose }: { api: FrameworkApi; canReview: boolean; onClose: () => void }) {
  const [method, setMethod] = useState<'import' | 'scratch' | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="new-standard-title" className="w-full max-w-2xl rounded-lg bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="new-standard-title" className="text-xl font-semibold">New Standard</h2>
          <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
        </div>
        {method === null && (
          <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="How do you want to add the standard?">
            <button type="button" onClick={() => setMethod('import')} className="rounded-lg border border-border p-4 text-start hover:bg-muted">
              <span className="block font-medium">Import a file</span>
              <span className="text-sm text-muted-foreground">Load a standard that was exported from AMS or prepared as a JSON file. It becomes a draft you review before publishing.</span>
            </button>
            <button type="button" onClick={() => setMethod('scratch')} className="rounded-lg border border-border p-4 text-start hover:bg-muted">
              <span className="block font-medium">Start from scratch</span>
              <span className="text-sm text-muted-foreground">Name the accreditor and the standard, then build the requirements by hand.</span>
            </button>
          </div>
        )}
        {method !== null && (
          <div>
            <Button type="button" variant="ghost" className="mb-2 px-2" onClick={() => setMethod(null)}>← Back</Button>
            {method === 'import' ? <ImportForm api={api} canReview={canReview} /> : <NewFramework api={api} onCreated={onClose} />}
          </div>
        )}
        <div className="mt-4 text-end"><Button type="button" variant="ghost" onClick={onClose}>Close</Button></div>
      </div>
    </div>
  );
}

export function FrameworksPage({ api: apiProp }: { api?: FrameworkApi }) {
  const { t } = useTranslation();
  const api = useApi(apiProp);
  const me = useMe(api);
  const [creating, setCreating] = useState(false);
  const { data, isError } = useQuery({ queryKey: ['frameworks'], queryFn: () => api.frameworks() });
  const canWrite = can(me.data, 'framework:write');

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('framework.title', 'External Standards')}</h1>
        {canWrite && <Button type="button" onClick={() => setCreating(true)}>New Standard</Button>}
      </div>
      {isError && <p role="alert">Could not load standards.</p>}
      <p className="text-sm text-muted-foreground">Accreditors' standards. Add or import one, edit its requirements while it is a draft, then publish it; map its requirements to your internal standards in each version's Mappings tab.</p>
      {data?.length === 0 && <p className="text-muted-foreground">No standards yet.{canWrite ? ' Use New Standard to import one or start from scratch.' : ''}</p>}
      <ul className="space-y-3">
        {(data ?? []).map((f) => (
          <li key={f.id}>
            <Card>
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg font-semibold"><ContentText>{f.name}</ContentText></h2>
                <span className="text-sm text-muted-foreground">{f.accreditorShortName} · {f.scope}</span>
              </div>
              <Versions api={api} framework={f} />
            </Card>
          </li>
        ))}
      </ul>
      {creating && <NewStandardDialog api={api} canReview={can(me.data, 'framework:review')} onClose={() => setCreating(false)} />}
    </section>
  );
}
