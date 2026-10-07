import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ContentText } from '../components/content-text';
import { DatasetPanel } from '../components/dataset-panel';
import { EvidenceLinkList } from '../components/evidence-links';
import { NewEvidenceDialog } from '../components/link-evidence-dialog';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { useEvidenceApi, type EvidenceApi } from '../lib/evidence-api';
import { type FrameworkApi } from '../lib/framework-api';
import { can, useApi, useMe } from '../lib/me';

const TYPE_LABEL = { document: 'Document', data: 'Data' } as const;
const size = (n: number | null) => (n === null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

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
          <p className="text-sm text-muted-foreground">{TYPE_LABEL[item.type]}</p>
          {item.description && <p className="mt-1 whitespace-pre-line text-sm"><ContentText>{item.description}</ContentText></p>}
        </div>
        <section aria-label="Versions">
          <h3 className="mb-1 font-medium">Versions</h3>
          <ul className="divide-y divide-border text-sm">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2 py-1.5" data-testid="evidence-version">
                <span className="font-medium">v{v.versionNo}</span>
                {v.rowCount !== null
                  ? <span>{v.rowCount} row{v.rowCount === 1 ? '' : 's'} of data</span>
                  : v.url
                    ? <a className="underline" href={v.url} target="_blank" rel="noreferrer">{v.url}</a>
                    : <a className="underline" href={api.fileUrl(v.id)} target="_blank" rel="noreferrer"><ContentText>{v.fileName ?? 'file'}</ContentText></a>}
                <span className="text-xs text-muted-foreground">{v.rowCount === null ? `${size(v.size)} · ` : ''}{new Date(v.createdAt).toLocaleDateString()}</span>
                {v.notes && <span className="text-xs text-muted-foreground" dir="auto">· {v.notes}</span>}
              </li>
            ))}
            {versions.length === 0 && <li className="py-1.5 text-muted-foreground">{item.type === 'data' ? 'No data saved yet.' : 'No file yet.'}</li>}
          </ul>
          {canWrite && item.type === 'document' && (
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

/** For data evidence, the definition and the online sheet, full width under the list. */
function SelectedData({ id, api, canWrite }: { id: string; api: EvidenceApi; canWrite: boolean }) {
  const { data } = useQuery({ queryKey: ['evidence-item', id], queryFn: () => api.get(id) });
  return data?.item.type === 'data' ? <DatasetPanel item={data.item} api={api} canWrite={canWrite} /> : null;
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
        {canWrite && <Button type="button" className="ms-auto" onClick={() => setAdding(true)}>+ Evidence</Button>}
      </div>
      <p className="text-sm text-muted-foreground">Evidence belongs to the institution: add it once, attach it to your internal framework, and link it to every accreditor requirement it supports, each with its own reason.</p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {adding && canWrite && <NewEvidenceDialog api={api} dataWithoutFile onClose={() => setAdding(false)} onCreated={(item) => { setAdding(false); setSelected(item.id); void qc.invalidateQueries({ queryKey: ['evidence'] }); }} />}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <ul aria-label="Evidence" className="divide-y divide-border">
            {(list.data ?? []).map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => setSelected(e.id)} className={`flex w-full flex-wrap items-center gap-2 px-2 py-2 text-start text-sm hover:bg-muted ${selected === e.id ? 'bg-muted' : ''}`}>
                  <span className="font-medium"><ContentText>{e.title}</ContentText></span>
                  <span className="text-xs text-muted-foreground">{TYPE_LABEL[e.type]}{e.latest ? ` · v${e.latest.versionNo}` : ' · no file'}</span>
                  <span className="ms-auto text-xs text-muted-foreground">{e.linkCount} link{e.linkCount === 1 ? '' : 's'}</span>
                </button>
              </li>
            ))}
            {list.data?.length === 0 && <li className="px-2 py-2 text-sm text-muted-foreground">{q ? 'Nothing matches.' : 'No evidence yet.'}</li>}
          </ul>
        </Card>
        {selected ? <Detail key={selected} id={selected} api={api} canWrite={canWrite} setError={setError} /> : <p className="text-sm text-muted-foreground">Select evidence to see its versions and links.</p>}
      </div>
      {selected && <SelectedData key={selected} id={selected} api={api} canWrite={canWrite} />}
    </section>
  );
}
