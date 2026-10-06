import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CONFIDENTIALITY_LEVELS, EVIDENCE_TYPES, type EvidenceItem } from '@ams/shared';
import { ContentText } from '../components/content-text';
import { EvidenceLinkList } from '../components/evidence-links';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { useEvidenceApi, type EvidenceApi } from '../lib/evidence-api';
import { type FrameworkApi } from '../lib/framework-api';
import { can, useApi, useMe } from '../lib/me';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
const TYPE_LABEL = { document: 'Document', dataset: 'Dataset', url: 'Link', minutes: 'Minutes', policy: 'Policy', report: 'Report', other: 'Other' } as const;
const CONF_LABEL = { public: 'Public', internal: 'Internal', restricted: 'Restricted' } as const;
const size = (n: number | null) => (n === null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function AddEvidence({ api, onDone, setError }: { api: EvidenceApi; onDone: (id: string) => void; setError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const url = String(f.get('url') ?? '').trim();
    if ((!file || file.size === 0) && !url) { setError('Choose a file or give a link.'); return; }
    setBusy(true); setError('');
    try {
      const tags = String(f.get('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      const period = String(f.get('period') ?? '').trim();
      const item = await api.create({
        title: String(f.get('title')), type: String(f.get('type')) as EvidenceItem['type'], confidentiality: String(f.get('confidentiality')) as EvidenceItem['confidentiality'],
        containsStudentData: f.get('student') === 'on', tags, ...(period ? { periodLabel: period } : {}), ...(url && !(file && file.size) ? { url } : {}),
      });
      if (file && file.size > 0) await api.upload(item.id, file);
      onDone(item.id);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card>
      <form onSubmit={(e) => void submit(e)} aria-label="Add evidence" className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col text-sm sm:col-span-2">Title<Input name="title" aria-label="Title" required dir="auto" /></label>
        <label className="flex flex-col text-sm">Type<select name="type" aria-label="Type" className={select} defaultValue="document">{EVIDENCE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></label>
        <label className="flex flex-col text-sm">Period<Input name="period" aria-label="Period" placeholder="e.g. AY2025-26" /></label>
        <label className="flex flex-col text-sm">Confidentiality<select name="confidentiality" aria-label="Confidentiality" className={select} defaultValue="internal">{CONFIDENTIALITY_LEVELS.map((c) => <option key={c} value={c}>{CONF_LABEL[c]}</option>)}</select></label>
        <label className="flex flex-col text-sm">Tags<Input name="tags" aria-label="Tags" placeholder="comma separated" /></label>
        <label className="flex flex-col text-sm">File<input aria-label="File" type="file" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <label className="flex flex-col text-sm">or a link to it<Input name="url" aria-label="Link" type="url" placeholder="https://…" /></label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="student" /> Contains student data</label>
        <div className="sm:col-span-2"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Add evidence'}</Button></div>
      </form>
    </Card>
  );
}

function Detail({ id, api, canWrite, setError }: { id: string; api: EvidenceApi; canWrite: boolean; setError: (m: string) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['evidence-item', id], queryFn: () => api.get(id) });
  const [busy, setBusy] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['evidence-item', id] }), qc.invalidateQueries({ queryKey: ['evidence'] })]);
  if (!data) return <p>Loading…</p>;
  const { item, versions, links } = data;
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError('');
    try { await api.upload(id, file); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card>
      <section aria-label={`Evidence: ${item.title}`} className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold"><ContentText>{item.title}</ContentText></h2>
          <p className="text-sm text-muted-foreground">{TYPE_LABEL[item.type]} · {CONF_LABEL[item.confidentiality]}{item.periodLabel ? ` · ${item.periodLabel}` : ''}{item.containsStudentData ? ' · contains student data' : ''}</p>
          {item.tags.length > 0 && <p className="mt-1 flex flex-wrap gap-1">{item.tags.map((t) => <span key={t} className="rounded bg-muted px-1.5 text-xs">{t}</span>)}</p>}
        </div>
        <section aria-label="Versions">
          <h3 className="mb-1 font-medium">Versions</h3>
          <ul className="divide-y divide-border text-sm">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2 py-1.5" data-testid="evidence-version">
                <span className="font-medium">v{v.versionNo}</span>
                {v.url
                  ? <a className="underline" href={v.url} target="_blank" rel="noreferrer">{v.url}</a>
                  : <a className="underline" href={api.fileUrl(v.id)} target="_blank" rel="noreferrer"><ContentText>{v.fileName ?? 'file'}</ContentText></a>}
                <span className="text-xs text-muted-foreground">{size(v.size)} · {new Date(v.createdAt).toLocaleDateString()}</span>
              </li>
            ))}
            {versions.length === 0 && <li className="py-1.5 text-muted-foreground">No file yet.</li>}
          </ul>
          {canWrite && (
            <label className="mt-2 flex items-center gap-2 text-sm">{busy ? 'Uploading…' : 'Upload a new version'}
              <input aria-label="Upload a new version" type="file" disabled={busy} className="text-sm" onChange={(e) => void upload(e.target.files?.[0])} />
            </label>
          )}
        </section>
        <section aria-label="Linked to">
          <h3 className="mb-1 font-medium">Linked to</h3>
          <EvidenceLinkList links={links} api={api} canReview={false} canRemove={false} showTarget onChange={() => void refresh()} setError={setError} />
        </section>
      </section>
    </Card>
  );
}

/** The evidence repository (PRD 9.1): stored once, versioned, linked many times. */
export function EvidencePage({ api: override, framework }: { api?: EvidenceApi; framework?: FrameworkApi }) {
  const api = useEvidenceApi(override);
  const me = useMe(useApi(framework));
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const list = useQuery({ queryKey: ['evidence', q], queryFn: () => api.list(q || undefined) });
  const canWrite = can(me.data, 'evidence:write');

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Evidence</h1>
        <Input aria-label="Search evidence" placeholder="Search by title or tag" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
        {canWrite && <Button type="button" className="ms-auto" onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add evidence'}</Button>}
      </div>
      <p className="text-sm text-muted-foreground">Evidence belongs to the institution: add it once, attach it to your internal framework, and link it to every accreditor requirement it supports, each with its own reason.</p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {adding && canWrite && <AddEvidence api={api} setError={setError} onDone={(id) => { setAdding(false); setSelected(id); void qc.invalidateQueries({ queryKey: ['evidence'] }); }} />}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <ul aria-label="Evidence" className="divide-y divide-border">
            {(list.data ?? []).map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => setSelected(e.id)} className={`flex w-full flex-wrap items-center gap-2 px-2 py-2 text-start text-sm hover:bg-muted ${selected === e.id ? 'bg-muted' : ''}`}>
                  <span className="font-medium"><ContentText>{e.title}</ContentText></span>
                  <span className="text-xs text-muted-foreground">{TYPE_LABEL[e.type]}{e.periodLabel ? ` · ${e.periodLabel}` : ''}{e.latest ? ` · v${e.latest.versionNo}` : ' · no file'}</span>
                  {e.confidentiality === 'restricted' && <span className="rounded bg-amber-50 px-1.5 text-xs text-amber-900">Restricted</span>}
                  <span className="ms-auto text-xs text-muted-foreground">{e.linkCount} link{e.linkCount === 1 ? '' : 's'}</span>
                </button>
              </li>
            ))}
            {list.data?.length === 0 && <li className="px-2 py-2 text-sm text-muted-foreground">{q ? 'Nothing matches.' : 'No evidence yet.'}</li>}
          </ul>
        </Card>
        {selected ? <Detail key={selected} id={selected} api={api} canWrite={canWrite} setError={setError} /> : <p className="text-sm text-muted-foreground">Select evidence to see its versions and links.</p>}
      </div>
    </section>
  );
}
