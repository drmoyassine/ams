import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ContentText } from '../components/content-text';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { ApiError, type FrameworkApi, type FrameworkListItem, type Issue } from '../lib/framework-api';
import { can, useApi, useMe } from '../lib/me';

function Versions({ api, framework }: { api: FrameworkApi; framework: FrameworkListItem }) {
  const { data } = useQuery({ queryKey: ['versions', framework.id], queryFn: () => api.versions(framework.id) });
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {(data ?? []).map((v) => (
        <li key={v.id}>
          <Link to="/versions/$versionId" params={{ versionId: v.id }} className="rounded border border-border px-2 py-1 text-sm hover:bg-muted">
            {v.edition} <span className="text-muted-foreground">· {v.status.replace('_', ' ')}</span>
          </Link>
        </li>
      ))}
      {data?.length === 0 && <li className="text-sm text-muted-foreground">No versions yet.</li>}
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
      <h2 className="mb-2 text-lg font-semibold">Import a framework file</h2>
      <p className="mb-2 text-sm text-muted-foreground">Creates a new draft version. Nothing existing is changed.</p>
      <input
        type="file" accept="application/json,.json" aria-label="Framework file"
        onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }}
      />
      <textarea aria-label="Framework JSON" dir="ltr" rows={6} value={text} onChange={(e) => setText(e.target.value)} className="mt-2 w-full rounded-md border border-border p-2 font-mono text-xs" />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="text-sm">Edition (optional) <Input value={edition} onChange={(e) => setEdition(e.target.value)} className="w-40" /></label>
        {canReview && <label className="text-sm"><input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} /> Approve everything on import (trusted files)</label>}
        <Button type="button" disabled={!text.trim() || run.isPending} onClick={() => run.mutate()}>Import</Button>
      </div>
      {message && <p role="alert" className="mt-2 text-sm text-red-700">{message}</p>}
      {issues.length > 0 && <ul aria-label="Import problems" className="mt-1 list-disc space-y-1 ps-5 text-sm text-red-700">{issues.map((i, n) => <li key={n}><code>{i.path}</code>: {i.message}</li>)}</ul>}
      {done && (
        <p role="status" className="mt-2 text-sm text-emerald-800">
          Imported {done.counts}. <Link to="/versions/$versionId" params={{ versionId: done.id }} className="underline">Open the draft</Link>
        </p>
      )}
    </Card>
  );
}

function NewFramework({ api }: { api: FrameworkApi }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async (f: FormData) => {
      setError(null);
      try {
        const acc = await api.createAccreditor({ name: String(f.get('accName')), shortName: String(f.get('accShort')), type: String(f.get('accType')) as 'institutional' });
        await api.createFramework({ accreditorId: acc.id, name: String(f.get('name')), scope: String(f.get('scope')) as 'institution' });
        await qc.invalidateQueries({ queryKey: ['frameworks'] });
      } catch (e) { if (e instanceof ApiError) setError(e.message); else throw e; }
    },
  });
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); create.mutate(new FormData(e.currentTarget)); };
  return (
    <Card>
      <h2 className="mb-2 text-lg font-semibold">New framework</h2>
      <form onSubmit={submit} className="grid grid-cols-2 gap-2">
        <label className="text-sm">Accreditor name<Input name="accName" required /></label>
        <label className="text-sm">Short name<Input name="accShort" required /></label>
        <label className="text-sm">Accreditor type
          <select name="accType" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"><option value="institutional">Institutional</option><option value="programmatic">Programmatic</option><option value="regulatory">Regulatory</option></select>
        </label>
        <label className="text-sm">Framework name<Input name="name" required /></label>
        <label className="text-sm">Scope
          <select name="scope" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"><option value="institution">Institution</option><option value="program">Program</option><option value="both">Both</option></select>
        </label>
        <div className="flex items-end"><Button type="submit" disabled={create.isPending}>Create</Button></div>
      </form>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </Card>
  );
}

export function FrameworksPage({ api: apiProp }: { api?: FrameworkApi }) {
  const { t } = useTranslation();
  const api = useApi(apiProp);
  const me = useMe(api);
  const { data, isError } = useQuery({ queryKey: ['frameworks'], queryFn: () => api.frameworks() });
  const canWrite = can(me.data, 'framework:write');

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('framework.title', 'Frameworks')}</h1>
      {isError && <p role="alert">Could not load frameworks.</p>}
      {data?.length === 0 && <p className="text-muted-foreground">No frameworks yet. Import a framework file or create one.</p>}
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
      {canWrite && <ImportForm api={api} canReview={can(me.data, 'framework:review')} />}
      {canWrite && <NewFramework api={api} />}
    </section>
  );
}
