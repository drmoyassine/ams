import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentRow, Me } from '@ams/shared';
import { AccordionCard, Shaded } from '../../components/accordion';
import { useConfirm } from '../../components/confirm-dialog';
import { ContentText } from '../../components/content-text';
import { Dialog } from '../../components/dialog';
import { DocsTab, StatusChip, UploadedBy } from '../../components/docs';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { AnalysisPanel } from './analysis-panel';
import type { FrameworkApi, SourceAuthority, SourceDocument, SourceRole, Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import { FILE_ACCEPT, formatBytes } from '../../lib/source-files';
import { useAction } from '../../lib/use-action';

export const ROLE_LABEL: Record<SourceRole, string> = {
  standards: 'Standards', policy_procedure: 'Policy and procedure', guidance: 'Guidance', report_template: 'Report template',
  evidence_guidance: 'Evidence guidance', amendment: 'Amendment', sample_report: 'Sample report', correspondence: 'Correspondence', other: 'Other',
};
export const AUTHORITY_LABEL: Record<SourceAuthority, string> = { binding: 'Binding', interpretive: 'Interpretive', informational: 'Informational' };
const select = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm';
/** Where reading a source's file stands, in words (the standards' wording; the generic chip says the same in one word). */
export function readStatus(d: Pick<DocumentRow, 'status' | 'pageCount' | 'needsOcrPages'>): string {
  const pages = d.pageCount ?? 0;
  switch (d.status) {
    case 'queued': case 'reading': return 'Reading the file…';
    case 'read': return `Read: ${pages} page${pages === 1 ? '' : 's'}`;
    case 'needs_ocr': { const n = d.needsOcrPages; return `Read: ${pages} page${pages === 1 ? '' : 's'}, ${n} need${n === 1 ? 's' : ''} OCR`; }
    case 'failed': return 'The file could not be read. Check that it is a PDF, Word, Excel, PowerPoint, OpenDocument, RTF, CSV or image file that opens.';
    default: return 'Not read yet';
  }
}

/** Adds a source (with its original, optionally) or changes how one is described. */
function SourceDialog({ editing, error, onSave, onClose }: {
  editing: SourceDocument | null; error: string; onSave: (v: { title: string; role: SourceRole | null; authority: SourceAuthority; language: string; file: File | null }) => Promise<unknown>; onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = editing ? 'Edit source' : 'New source';
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    void onSave({ title: String(f.get('title')).trim(), role: (String(f.get('role')) || null) as SourceRole | null, authority: String(f.get('authority')) as SourceAuthority, language: String(f.get('language')).trim() || 'en', file })
      .finally(() => setBusy(false));
  };
  return (
    <Dialog labelledBy="source-dialog-title" onClose={onClose}>
      <div className="mb-4 flex items-start justify-between gap-2">
        <h2 id="source-dialog-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">{heading}</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <form onSubmit={submit} className="space-y-3" aria-label={heading}>
        <label className="flex flex-col text-sm">Title<Input name="title" aria-label="Title" defaultValue={editing?.title ?? ''} required autoFocus dir="auto" /></label>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_6rem]">
          <label className="flex flex-col text-sm">What it is
            <select name="role" aria-label="What it is" defaultValue={editing?.role ?? 'standards'} className={select}>
              {!editing && <option value="">Not sure: the analysis decides</option>}
              {(Object.keys(ROLE_LABEL) as SourceRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-sm">Authority
            <select name="authority" aria-label="Authority" defaultValue={editing?.authority ?? 'binding'} className={select}>
              {(Object.keys(AUTHORITY_LABEL) as SourceAuthority[]).map((a) => <option key={a} value={a}>{AUTHORITY_LABEL[a]}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-sm">Language<Input name="language" aria-label="Language" defaultValue={editing?.language ?? 'en'} /></label>
        </div>
        {!editing && (
          <label className="flex flex-col text-sm">Original file (optional)
            <input aria-label="Original file" type="file" accept={FILE_ACCEPT} className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        )}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{editing ? 'Save' : 'Add source'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The pages of a source: pick one to read its text; on a draft, correct it, remove it or add another. */
function Pages({ api, doc, editable, onChange, focus }: { api: FrameworkApi; doc: { id: string; title: string; textStatus: string }; editable: boolean; onChange: () => void; /** A page to show (a gap's link). */ focus?: { page: number; n: number } }) {
  const qc = useQueryClient();
  const pages = useQuery({ queryKey: ['source-pages', doc.id, doc.textStatus], queryFn: () => api.pages(doc.id) });
  const [pick, setPick] = useState<number | null>(focus?.page ?? null);
  useEffect(() => { if (focus) setPick(focus.page); }, [focus]);
  const [error, setError] = useState('');
  const run = useAction(setError);
  const confirm = useConfirm();
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['source-pages', doc.id] }); onChange(); };
  const list = pages.data ?? [];
  const current = list.find((p) => p.pageNo === pick) ?? list[0];
  const save = async (pageNo: number, text: string) => { setError(''); if (await run(() => api.setPage(doc.id, pageNo, text))) { await refresh(); setPick(pageNo); return true; } return false; };
  return (
    <div className="space-y-2">
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {list.length === 0 ? <p className="text-sm text-muted-foreground">No page text yet. Quotes in notes are checked against the text of these pages.</p> : (
        <>
          <div role="tablist" aria-label={`Pages of ${doc.title}`} className="flex flex-wrap gap-1">
            {list.map((p) => (
              <button key={p.pageNo} type="button" role="tab" aria-selected={current?.pageNo === p.pageNo} onClick={() => setPick(p.pageNo)} title={p.needsOcr ? 'Needs OCR' : undefined}
                className={`min-w-9 rounded-md border px-2 py-1 text-xs ${current?.pageNo === p.pageNo ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}>{p.pageNo}</button>
            ))}
          </div>
          {current?.needsOcr && <p role="note" className="text-xs text-amber-700">Page {current.pageNo} has no readable text layer; it needs OCR, or type its text in.</p>}
          {current && (editable ? (
            <form key={`${current.pageNo}-${current.text.length}`} className="space-y-2" aria-label={`Page ${current.pageNo}`}
              onSubmit={(e) => { e.preventDefault(); void save(current.pageNo, String(new FormData(e.currentTarget).get('text'))); }}>
              <textarea name="text" aria-label={`Text of page ${current.pageNo}`} rows={8} dir="auto" defaultValue={current.text} className="w-full rounded-md border border-border p-2 text-sm" />
              <div className="flex gap-2">
                <Button type="submit" variant="outline">Save page {current.pageNo}</Button>
                <Button type="button" variant="ghost" onClick={() => void confirm({ title: `Remove page ${current.pageNo}?`, message: `The text of page ${current.pageNo} of ${doc.title} will be removed. You can restore it from the Trash for 30 days.`, confirmLabel: 'Remove page', tone: 'danger' }).then((ok) => { if (ok) void run(() => api.deletePage(doc.id, current.pageNo)).then(refresh).then(() => setPick(null)); })}>Remove page</Button>
              </div>
            </form>
          ) : <p className="whitespace-pre-line rounded-md border border-border bg-background p-3 text-sm" dir="auto" data-testid="page-text">{current.text}</p>)}
        </>
      )}
      {editable && (
        <form className="flex flex-wrap items-start gap-2 border-t border-border pt-3" aria-label={`Add page to ${doc.title}`}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget); const form = e.currentTarget;
            void save(Number(f.get('pageNo')), String(f.get('text'))).then((ok) => { if (ok) form.reset(); });
          }}>
          <Input name="pageNo" type="number" min={1} required aria-label="Page number" placeholder="Page" className="w-24" defaultValue={String((list[list.length - 1]?.pageNo ?? 0) + 1)} key={list.length} />
          <textarea name="text" required rows={2} dir="auto" aria-label="Page text" placeholder="Paste the page's text as it reads in the original" className="min-w-64 flex-1 rounded-md border border-border p-2 text-sm" />
          <Button type="submit">Add page</Button>
        </form>
      )}
    </div>
  );
}

/** The adapter row as the old source row the dialog edits. */
const asSource = (d: DocumentRow): SourceDocument => ({
  id: d.id, frameworkVersionId: d.scopeId ?? '', title: d.name, role: d.role ?? 'other', authority: d.authority ?? 'binding', language: d.language, filePath: '', sha256: '',
  pageCount: d.pageCount, textStatus: d.status, roleOrigin: d.roleOrigin ?? 'manual', fileName: d.fileName, mime: d.mime, size: d.size,
});

/**
 * A version's Docs tab (TASK-075): the accreditor's documents its requirements and notes come from, in the shared Docs tab (who
 * uploaded each and when, status, drag-and-drop upload, open, read again, delete to the Trash), with what the old Sources section
 * held: each source's role and authority, its original file, the text of its pages (quotes are verified against that text) and the
 * Analysis panel. Editable while the version is a draft.
 */
export function VersionDocs({ api, version, me, onShowRequirement, onShowReport, focusPage }: {
  api: FrameworkApi; version: Version; me: Me | undefined; onShowRequirement?: (id: string) => void; onShowReport?: (runId: string) => void;
  /** Opens a source on a page and scrolls to it (a link from the report). */ focusPage?: { documentId: string; page: number; n: number };
}) {
  const qc = useQueryClient();
  const docs = api.docs;
  const writer = can(me, 'framework:write');
  const editable = version.status === 'draft' && writer;
  const [list, setList] = useState<DocumentRow[]>([]);
  const targets = useQuery({ queryKey: ['import-targets', 'framework_version', version.id], queryFn: () => docs.targets({ kind: 'framework_version', id: version.id }) });
  const [open, setOpen] = useState<Set<string>>(new Set());
  // A gap's link to a source page: open that source on that page and scroll to it.
  const [focus, setFocus] = useState<{ documentId: string; page: number; n: number } | null>(null);
  const showPage = useCallback((documentId: string, page: number) => {
    setOpen((s) => new Set([...s, documentId]));
    setFocus((f) => ({ documentId, page, n: (f?.n ?? 0) + 1 }));
  }, []);
  useEffect(() => { if (focusPage) showPage(focusPage.documentId, focusPage.page); }, [focusPage, showPage]);
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(`source-${focus.documentId}`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focus, list.length]);
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'edit'; doc: DocumentRow } | null>(null);
  const [error, setError] = useState('');
  const run = useAction(setError);
  const refresh = () => qc.invalidateQueries({ queryKey: ['docs', 'framework_version', version.id] });
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const close = () => { setDialog(null); setError(''); };
  const pickFile = (doc: DocumentRow) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = FILE_ACCEPT;
    input.onchange = () => { const f = input.files?.[0]; if (f) void run(() => api.uploadSourceFile(doc.id, f)).then(refresh); };
    input.click();
  };
  const written = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['docs', 'framework_version', version.id] });
    void qc.invalidateQueries({ queryKey: ['requirements', version.id] });
    void qc.invalidateQueries({ queryKey: ['version', version.id] });
  }, [qc, version.id]);
  const fixedNote = version.status !== 'draft' ? `The sources of a ${version.status === 'in_review' ? 'version in review' : 'published version'} are fixed with it; start a new version to change them.` : undefined;

  return (
    <>
    <DocsTab
      scopeKind="framework_version" scopeId={version.id} targets={targets.data ?? []} canWrite={writer} editable={version.status === 'draft'} {...(fixedNote ? { fixedNote } : {})} api={docs}
      label="Docs" onDocuments={setList}
      header={(version.status === 'draft' || version.status === 'in_review') && (
        <AnalysisPanel api={api} versionId={version.id} editable={editable} hasSources={list.length > 0} onWritten={written}
          documentTitle={(id) => list.find((d) => d.id === id)?.name ?? 'a source'} onShowPage={showPage} {...(onShowRequirement ? { onShowRequirement } : {})} {...(onShowReport ? { onShowReport } : {})} />
      )}
      actions={editable ? <Button type="button" onClick={() => setDialog({ kind: 'add' })}>+ Source</Button> : null}
      renderRow={(d, ctx) => {
        const role = d.roleOrigin === 'unset' || !d.role ? 'Role not set' : `${ROLE_LABEL[d.role as SourceRole] ?? d.role}${d.roleOrigin === 'ai' ? ' (AI)' : ''}`;
        const pages = d.pageCount ?? 0;
        return (
          <AccordionCard label={d.name} tag={role} title={d.name} testId="source-document" domId={`source-${d.id}`} open={open.has(d.id)} onToggle={() => toggle(d.id)}
            menuLabel={`Actions for ${d.name}`}
            menu={editable ? [
              { label: 'Edit', onSelect: () => setDialog({ kind: 'edit', doc: d }) },
              { label: d.hasFile ? 'Replace file' : 'Upload file', onSelect: () => pickFile(d) },
              { label: 'Delete', onSelect: () => ctx.remove(d) },
            ] : []}
            meta={<span className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
              <span>{AUTHORITY_LABEL[d.authority as SourceAuthority] ?? d.authority}</span>
              <span>{pages} page{pages === 1 ? '' : 's'}</span>
              {d.hasFile && <span className="rounded bg-muted px-1.5 py-0.5">File</span>}
              <StatusChip doc={d} />
            </span>}>
            <div className="space-y-1">
              <Shaded>Original</Shaded>
              {d.hasFile
                ? <p className="text-sm"><a className="underline" href={api.sourceFileUrl(d.id)} target="_blank" rel="noreferrer"><ContentText>{d.fileName ?? 'file'}</ContentText></a> <span className="text-xs text-muted-foreground">{d.size !== null ? formatBytes(d.size) : ''}</span></p>
                : <p className="text-sm text-muted-foreground">No file uploaded.{editable ? ' Use the ⋯ menu to upload it.' : ''}</p>}
              <p className="text-xs text-muted-foreground"><UploadedBy doc={d} /></p>
              {d.hasFile && (
                <div className="flex flex-wrap items-center gap-2">
                  {editable && <Button type="button" variant="outline" disabled={d.status === 'queued'} onClick={() => ctx.readAgain(d)}>{d.status === 'not_read' || d.status === 'queued' ? 'Read this file' : 'Read this file again'}</Button>}
                  <span role="status" aria-label={`Reading status of ${d.name}`} className="text-xs text-muted-foreground">{readStatus(d)}</span>
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Shaded>Pages</Shaded>
              <Pages api={api} doc={{ id: d.id, title: d.name, textStatus: d.status }} editable={editable} onChange={() => void refresh()} {...(focus?.documentId === d.id ? { focus } : {})} />
            </div>
          </AccordionCard>
        );
      }}
    />
    {error && !dialog && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {dialog?.kind === 'add' && (
      <SourceDialog editing={null} error={error} onClose={close} onSave={async (v) => {
        setError('');
        const doc = await run(() => api.addDocument(version.id, { title: v.title, ...(v.role ? { role: v.role } : {}), authority: v.authority, language: v.language }));
        if (!doc) return;
        if (v.file && !(await run(() => api.uploadSourceFile(doc.id, v.file!)))) { await refresh(); return; }
        await refresh();
        setOpen((s) => new Set([...s, doc.id]));
        close();
      }} />
    )}
    {dialog?.kind === 'edit' && (
      <SourceDialog editing={asSource(dialog.doc)} error={error} onClose={close} onSave={async (v) => {
        setError('');
        if (await run(() => api.updateDocument(dialog.doc.id, { title: v.title, ...(v.role ? { role: v.role } : {}), authority: v.authority, language: v.language }))) { await refresh(); close(); }
      }} />
    )}
    </>
  );
}
