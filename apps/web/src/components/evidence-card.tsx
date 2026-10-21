import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EvidenceItem, EvidenceVersion } from '@ams/shared';
import type { EvidenceApi } from '../lib/evidence-api';
import type { FrameworkApi, Requirement } from '../lib/framework-api';
import { download, fileNameFor, toXlsx } from '../lib/sheet-io';
import { tag } from '../pages/settings/iqf-requirements';
import { AccordionCard, HoverCard, Shaded } from './accordion';
import { ContentText } from './content-text';
import { DatasetPanel } from './dataset-panel';
import type { CycleApis } from './cycles/directory';
import { CollectionChips, CollectionSection } from './evidence-collection';
import { draftOf, errorText, EVERY_LABEL, ItemFields, METHOD_LABEL, methodConfigOf, scheduleOf } from './evidence-item-form';
import { EvidenceLinkList } from './evidence-links';
import { RequestEvidenceDialog, RequestFormDialog, RequestList } from './evidence-requests';
import { Modal } from './link-evidence-dialog';
import { Button } from './ui/button';

const TYPE_LABEL = { document: 'Document', dataset: 'Dataset' } as const;
const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const size = (n: number | null) => (n === null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the item is, from its latest version: PDF, DOC, XLS, IMG…, LINK for an address, DATA for a dataset, — with nothing yet. */
export function kindOf(item: Pick<EvidenceItem, 'type' | 'latest'>): string {
  if (item.type === 'dataset') return 'DATA';
  const v = item.latest;
  if (!v) return '—';
  if (v.url && !v.fileName) return 'LINK';
  const ext = /\.([a-z0-9]{1,5})$/i.exec(v.fileName ?? '')?.[1]?.toLowerCase() ?? '';
  const mime = v.mime ?? '';
  if (ext === 'pdf' || mime === 'application/pdf') return 'PDF';
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext) || /msword|wordprocessing/.test(mime)) return 'DOC';
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext) || /spreadsheet|ms-excel|csv/.test(mime)) return 'XLS';
  if (['ppt', 'pptx', 'odp'].includes(ext) || /presentation|powerpoint/.test(mime)) return 'PPT';
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'IMG';
  return ext ? ext.slice(0, 4).toUpperCase() : 'FILE';
}

/** A small tile on the left of the card saying what the item is. */
function KindTile({ item }: { item: EvidenceItem }) {
  const kind = kindOf(item);
  const label = kind === '—' ? 'No file yet' : kind === 'DATA' ? 'Dataset' : kind === 'LINK' ? 'Link' : `${kind} file`;
  return (
    <span role="img" aria-label={label} data-testid="evidence-kind"
      className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-[0.65rem] font-semibold uppercase tracking-tight text-muted-foreground">{kind}</span>
  );
}

const chip = 'rounded px-1.5 py-0.5';
/** The right side of the closed card: how it is collected and when, links, the latest version, dataset and form state, and flags only when they apply. */
function CardMeta({ item }: { item: EvidenceItem }) {
  const v = item.latest;
  const data = item.type === 'dataset';
  return (
    <span className="hidden shrink-0 flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground md:flex" data-testid="evidence-meta">
      <CollectionChips item={item} />
      {item.linkCount > 0 && <span>Linked to {item.linkCount}</span>}
      {item.proposedLinkCount > 0 && <span className={`${chip} bg-amber-50 text-amber-900`}>{item.proposedLinkCount} to review</span>}
      {v && <span>v{v.versionNo} · {DATE.format(new Date(v.createdAt))}</span>}
      {data && v?.rowCount != null && <span>{plural(v.rowCount, 'row')}</span>}
      {data && item.formOpen && <span className={`${chip} bg-muted`}>Form open</span>}
      {data && item.pendingResponses > 0 && <span className={`${chip} bg-amber-50 text-amber-900`}>{item.pendingResponses} new</span>}
      {item.linkCount === 0 && <span className={`${chip} bg-muted`}>Not linked</span>}
      {item.openRequestCount > 0 && <span className={`${chip} bg-muted`}>Open request</span>}
      {item.status === 'archived' && <span className={`${chip} bg-muted`}>Archived</span>}
    </span>
  );
}

/** "Standard 1.0 · Mission" for the picker, indented under its parent. */
const standardLabel = (r: Requirement) => `${r.parentId ? '   ' : ''}${tag(r)} · ${r.title}`;

/** The items of the internal quality framework's newest published version, or null while there is none. */
function useInternalStandards(framework: FrameworkApi) {
  const qf = useQuery({ queryKey: ['quality-framework'], queryFn: () => framework.qualityFramework() });
  const published = (qf.data?.versions ?? []).filter((v) => v.status === 'published');
  const version = published[published.length - 1];
  const reqs = useQuery({ queryKey: ['requirements', version?.id], queryFn: () => framework.requirements(version!.id), enabled: !!version });
  return { loading: qf.isLoading || reqs.isLoading, none: !!qf.data && !version, items: reqs.data ?? [] };
}

/** Choose an item of the internal quality framework. */
function StandardSelect({ framework, value, onChange }: { framework: FrameworkApi; value: string; onChange: (id: string) => void }) {
  const { loading, none, items } = useInternalStandards(framework);
  if (none) return <p className="text-sm text-muted-foreground">The internal quality framework has no published version yet.</p>;
  return (
    <label className="flex flex-col text-sm">Standard
      <select aria-label="Standard" required value={value} disabled={loading} onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-border bg-background px-2" dir="auto">
        <option value="">{loading ? 'Loading…' : 'Choose a standard'}</option>
        {items.map((r) => <option key={r.id} value={r.id}>{standardLabel(r)}</option>)}
      </select>
    </label>
  );
}

/** Attach the latest version to an item of the internal quality framework, with the justification (required). */
function LinkToStandardDialog({ item, latest, api, framework, onDone, onClose }: {
  item: EvidenceItem; latest: EvidenceVersion; api: EvidenceApi; framework: FrameworkApi; onDone: () => void; onClose: () => void;
}) {
  const [requirementId, setRequirementId] = useState('');
  const [justification, setJustification] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!requirementId || !justification.trim()) return;
    setBusy(true); setError('');
    try { await api.linkInternal(requirementId, { evidenceVersionId: latest.id, rationale: justification.trim() }); onDone(); onClose(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal labelledBy="link-standard-title" onClose={onClose}>
      <div className="mb-1 flex items-start justify-between gap-2">
        <h2 id="link-standard-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">Link to a standard</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground"><ContentText>{item.title}</ContentText> · v{latest.versionNo}</p>
      <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label="Link to a standard">
        <StandardSelect framework={framework} value={requirementId} onChange={setRequirementId} />
        <label className="flex flex-col text-sm">Justification
          <textarea aria-label="Justification" required rows={3} dir="auto" className="rounded-md border border-border p-2 text-sm"
            placeholder="Why this evidence supports it" value={justification} onChange={(e) => setJustification(e.target.value)} />
        </label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !requirementId || !justification.trim()}>{busy ? 'Linking…' : 'Link'}</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Ask someone for an update of a document. A request targets an item of the internal quality framework, so the
 * standard is chosen first; the request itself is the usual one, with the document's title filled in.
 */
function RequestUpdateDialog({ item, api, framework, onDone, onClose }: { item: EvidenceItem; api: EvidenceApi; framework: FrameworkApi; onDone: () => void; onClose: () => void }) {
  const { items } = useInternalStandards(framework);
  const [requirementId, setRequirementId] = useState('');
  const [chosen, setChosen] = useState<Requirement | null>(null);
  if (chosen) return <RequestEvidenceDialog api={api} title={`${tag(chosen)} · ${chosen.title}`} requirementId={chosen.id} initialWhat={item.title} onDone={onDone} onClose={onClose} />;
  return (
    <Modal labelledBy="request-update-title" onClose={onClose}>
      <div className="mb-1 flex items-start justify-between gap-2">
        <h2 id="request-update-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">Request an update</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground"><ContentText>{item.title}</ContentText></p>
      <form className="space-y-3" aria-label="Request an update" onSubmit={(e) => { e.preventDefault(); setChosen(items.find((r) => r.id === requirementId) ?? null); }}>
        <StandardSelect framework={framework} value={requirementId} onChange={setRequirementId} />
        <p className="-mt-1 text-xs text-muted-foreground">The standard the update is for; what is sent becomes evidence proposed there, for review.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!requirementId}>Continue</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Everything about the item itself: title, type, definition, how it is collected, the schedule and the owner. */
function EditDetailsDialog({ item, api, apis, onDone, onClose }: { item: EvidenceItem; api: EvidenceApi; apis?: CycleApis | undefined; onDone: () => void; onClose: () => void }) {
  const [draft, setDraft] = useState(() => draftOf(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.update(item.id, {
        title: draft.title.trim(), definition: draft.definition.trim() || null, ownerUserId: draft.ownerUserId || null,
        ...(draft.type !== item.type ? { type: draft.type } : {}),
        method: draft.method, methodConfig: methodConfigOf(draft), schedule: scheduleOf(draft),
      });
      onDone(); onClose();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  return (
    <Modal labelledBy="edit-evidence-title" onClose={onClose}>
      <div className="mb-4 flex items-start justify-between gap-2">
        <h2 id="edit-evidence-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">Edit details</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label="Edit details">
        <ItemFields draft={draft} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} apis={apis} currentOwner={item.ownerUserId && item.ownerName ? { id: item.ownerUserId, name: item.ownerName } : null} />
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </Modal>
  );
}

type Dialog = 'link' | 'request-update' | 'request-form' | 'edit' | null;

/**
 * One piece of evidence in the library: what it is, its title, and what needs attention on the closed card; opening it
 * shows the definition, how it is collected and when, every version, what it is linked to, and for a dataset its requests and the online sheet.
 */
export function EvidenceCard({ item, api, framework, canWrite, canReview, open, onToggle, apis }: {
  item: EvidenceItem; api: EvidenceApi; framework: FrameworkApi; canWrite: boolean; canReview: boolean; open: boolean; onToggle: (open: boolean) => void;
  /** The clients that name people (the owner, a person to ask); they default to the app's own, and tests hand over those of the signed-in test person. */
  apis?: CycleApis;
}) {
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const isData = item.type === 'dataset';
  const active = item.status === 'active';
  const latest = item.latest;
  const detail = useQuery({ queryKey: ['evidence-item', item.id], queryFn: () => api.get(item.id), enabled: open });
  const requests = useQuery({ queryKey: ['form-requests', item.id], queryFn: () => api.formRequests(item.id), enabled: open && isData });
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['evidence-item', item.id] }), qc.invalidateQueries({ queryKey: ['evidence'] }),
    qc.invalidateQueries({ queryKey: ['form-requests', item.id] }), qc.invalidateQueries({ queryKey: ['evidence-requests'] }),
  ]);
  const act = (fn: () => Promise<unknown>) => { setError(''); void fn().then(refresh, (e: Error) => setError(e.message)); };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError('');
    try { await api.upload(item.id, file); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const downloadLatest = async () => {
    if (!latest) return;
    if (latest.rowCount === null) { window.open(latest.url ?? api.fileUrl(latest.id), '_blank', 'noopener'); return; }
    const data = await api.versionData(latest.id);
    download(await toXlsx(item.title, data.columns, data.rows), fileNameFor(item.title, 'xlsx'));
  };

  const may = (when: boolean, label: string, onSelect: () => void) => (when ? [{ label, onSelect }] : []);
  const menu = [
    ...may(isData, 'Open sheet', () => onToggle(true)),
    ...may(!isData && canWrite && active, 'Upload a new version', () => fileInput.current?.click()),
    ...may(canWrite && active && !!latest, 'Link to a standard', () => setDialog('link')),
    ...may(!isData && canWrite && active, 'Request an update', () => setDialog('request-update')),
    ...may(isData && canWrite && active, 'Ask people to fill in the form', () => setDialog('request-form')),
    ...may(!!latest, 'Download latest', () => act(downloadLatest)),
    ...may(canWrite, 'Edit details', () => setDialog('edit')),
    ...may(canWrite, active ? 'Archive' : 'Restore', () => act(() => api.update(item.id, { status: active ? 'archived' : 'active' }))),
  ];
  const close = () => setDialog(null);
  const d = detail.data;

  return (
    <div className="space-y-1">
      <AccordionCard label={`Evidence: ${item.title}`} title={item.title} strong testId="evidence-card" tone={active ? 'plain' : 'shaded'}
        lead={<KindTile item={item} />} meta={<CardMeta item={item} />}
        open={open} onToggle={() => onToggle(!open)} menuLabel={`Actions for ${item.title}`} menu={menu}
        hover={(
          <HoverCard>
            <p className="font-semibold"><ContentText>{item.title}</ContentText></p>
            <p className="text-xs text-muted-foreground">{TYPE_LABEL[item.type]}{latest ? ` · version ${latest.versionNo}` : ''}</p>
            {item.definition ? <p className="mt-1 whitespace-pre-line"><ContentText>{item.definition}</ContentText></p> : <p className="mt-1 text-muted-foreground">No definition.</p>}
            <p className="mt-1 text-xs text-muted-foreground">{METHOD_LABEL[item.method]}{item.schedule ? ` · ${EVERY_LABEL[item.schedule.every].toLowerCase()}` : ''}</p>
          </HoverCard>
        )}>
        {!d ? <p className="text-sm">Loading…</p> : (
          <>
            <div className="space-y-2">
              <Shaded>Definition</Shaded>
              {d.item.definition
                ? <p className="whitespace-pre-line text-sm"><ContentText>{d.item.definition}</ContentText></p>
                : <p className="text-sm text-muted-foreground">No definition.</p>}
            </div>
            <CollectionSection item={d.item} apis={{ evidence: api, ...apis }} canWrite={canWrite} />
            <section aria-label="Versions" className="space-y-2">
              <Shaded>Versions</Shaded>
              <ul className="divide-y divide-border rounded-md border border-border text-sm">
                {d.versions.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5" data-testid="evidence-version">
                    <span className="font-medium">v{v.versionNo}</span>
                    {v.rowCount !== null
                      ? <span>{plural(v.rowCount, 'row')} of data</span>
                      : v.url
                        ? <a className="underline" href={v.url} target="_blank" rel="noreferrer">{v.url}</a>
                        : <a className="underline" href={api.fileUrl(v.id)} target="_blank" rel="noreferrer"><ContentText>{v.fileName ?? 'file'}</ContentText></a>}
                    <span className="text-xs text-muted-foreground">{v.rowCount === null && v.size !== null ? `${size(v.size)} · ` : ''}{DATE.format(new Date(v.createdAt))}</span>
                    {v.notes && <span className="text-xs text-muted-foreground">· <ContentText>{v.notes}</ContentText></span>}
                  </li>
                ))}
                {d.versions.length === 0 && <li className="px-3 py-1.5 text-muted-foreground">{isData ? 'No data saved yet.' : 'No file yet.'}</li>}
              </ul>
              {!isData && canWrite && active && (
                <Button type="button" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? 'Uploading…' : 'Upload a new version'}</Button>
              )}
            </section>
            <section aria-label="Linked to" className="space-y-2">
              <Shaded>Linked to</Shaded>
              <EvidenceLinkList links={d.links} api={api} canReview={canReview} canRemove={canWrite} showTarget onChange={() => void refresh()} setError={setError} />
            </section>
            {isData && (requests.data?.length ?? 0) > 0 && (
              <section aria-label="Requests for this item" className="space-y-2">
                <Shaded>Requests</Shaded>
                <RequestList requests={requests.data!} api={api} canManage={canWrite} setError={setError} onChange={() => void refresh()} />
              </section>
            )}
            {isData && <DatasetPanel item={d.item} api={api} canWrite={canWrite && active} />}
          </>
        )}
      </AccordionCard>
      {!isData && canWrite && active && (
        <input ref={fileInput} aria-label="Upload a new version" type="file" tabIndex={-1} className="sr-only" disabled={busy}
          onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
      )}
      {error && <p role="alert" className="px-1 text-sm text-red-700">{error}</p>}
      {dialog === 'link' && latest && <LinkToStandardDialog item={item} latest={latest} api={api} framework={framework} onDone={() => void refresh()} onClose={close} />}
      {dialog === 'request-update' && <RequestUpdateDialog item={item} api={api} framework={framework} onDone={() => void refresh()} onClose={close} />}
      {dialog === 'request-form' && <RequestFormDialog api={api} item={item} onDone={() => void refresh()} onClose={close} />}
      {dialog === 'edit' && <EditDetailsDialog item={item} api={api} apis={{ evidence: api, ...apis }} onDone={() => void refresh()} onClose={close} />}
    </div>
  );
}
