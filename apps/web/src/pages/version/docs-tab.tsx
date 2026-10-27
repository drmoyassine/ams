import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentRow, Me } from '@ams/shared';
import { Shaded } from '../../components/accordion';
import { useConfirm } from '../../components/confirm-dialog';
import { Dialog } from '../../components/dialog';
import { DocsTab } from '../../components/docs';
import { useFilePicker } from '../../components/files';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { AnalysisPanel } from './analysis-panel';
import type { FrameworkApi, SourceAuthority, SourceDocument, SourceRole, Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';

export const ROLE_LABEL: Record<SourceRole, string> = {
  standards: 'Standards', policy_procedure: 'Policy and procedure', guidance: 'Guidance', report_template: 'Report template',
  evidence_guidance: 'Evidence guidance', amendment: 'Amendment', sample_report: 'Sample report', correspondence: 'Correspondence', other: 'Other',
};
export const AUTHORITY_LABEL: Record<SourceAuthority, string> = { binding: 'Binding', interpretive: 'Interpretive', informational: 'Informational' };
const select = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm';
/** Changes how a document is described: its title, what it is, its authority and its language. (New documents come in by dropping the files.) */
function DetailsDialog({ doc, error, onSave, onClose }: {
  doc: SourceDocument; error: string; onSave: (v: { title: string; role: SourceRole | null; authority: SourceAuthority; language: string }) => Promise<unknown>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    void onSave({ title: String(f.get('title')).trim(), role: (String(f.get('role')) || null) as SourceRole | null, authority: String(f.get('authority')) as SourceAuthority, language: String(f.get('language')).trim() || 'en' })
      .finally(() => setBusy(false));
  };
  return (
    <Dialog labelledBy="source-dialog-title" onClose={onClose}>
      <div className="mb-4 flex items-start justify-between gap-2">
        <h2 id="source-dialog-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">Edit details</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <form onSubmit={submit} className="space-y-3" aria-label="Edit details">
        <label className="flex flex-col text-sm">Title<Input name="title" aria-label="Title" defaultValue={doc.title} required autoFocus dir="auto" /></label>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_6rem]">
          <label className="flex flex-col text-sm">What it is
            <select name="role" aria-label="What it is" defaultValue={doc.role} className={select}>
              {(Object.keys(ROLE_LABEL) as SourceRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-sm">Authority
            <select name="authority" aria-label="Authority" defaultValue={doc.authority} className={select}>
              {(Object.keys(AUTHORITY_LABEL) as SourceAuthority[]).map((a) => <option key={a} value={a}>{AUTHORITY_LABEL[a]}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-sm">Language<Input name="language" aria-label="Language" defaultValue={doc.language} /></label>
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>Save</Button>
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
 * A version's Docs tab (TASK-075): the shared Docs tab (drop files to add documents; who uploaded each and when, status, open, read
 * again, delete to the Trash) with what only standards have: each document's role and authority (the analysis fills the role when
 * it was left open; Edit details changes both), Replace file, the text of its pages (quotes are verified against it; closed until
 * opened) and, below the list, the Analysis panel. Editable while the version is a draft.
 */
export function VersionDocs({ api, version, me, onShowRequirement, onShowReport, focusPage, internal }: {
  api: FrameworkApi; version: Version; me: Me | undefined; onShowRequirement?: (id: string) => void; onShowReport?: (runId: string) => void;
  /** Opens a document on a page and scrolls to it (a link from the report). */ focusPage?: { documentId: string; page: number; n: number };
  /** The institution's own framework (TASK-107): the tab is called Documents, not Docs. */ internal?: boolean;
}) {
  const qc = useQueryClient();
  const docs = api.docs;
  const writer = can(me, 'framework:write');
  const editable = version.status === 'draft' && writer;
  const [list, setList] = useState<DocumentRow[]>([]);
  const targets = useQuery({ queryKey: ['import-targets', 'framework_version', version.id], queryFn: () => docs.targets({ kind: 'framework_version', id: version.id }) });
  const [open, setOpen] = useState<Set<string>>(new Set());
  // A gap's link to a document page: open that document's page text on that page and scroll to it.
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
  const [editing, setEditing] = useState<DocumentRow | null>(null);
  const [error, setError] = useState('');
  const run = useAction(setError);
  const refresh = () => qc.invalidateQueries({ queryKey: ['docs', 'framework_version', version.id] });
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const close = () => { setEditing(null); setError(''); };
  const replacing = useRef<DocumentRow | null>(null);
  const picker = useFilePicker({ label: 'Replace file', onFiles: ([f]) => { const doc = replacing.current; if (doc && f) void run(() => api.uploadSourceFile(doc.id, f)).then(refresh); } });
  const written = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['docs', 'framework_version', version.id] });
    void qc.invalidateQueries({ queryKey: ['requirements', version.id] });
    void qc.invalidateQueries({ queryKey: ['version', version.id] });
  }, [qc, version.id]);
  const fixedNote = version.status !== 'draft' ? `The documents of a ${version.status === 'in_review' ? 'version in review' : 'published version'} are fixed with it; start a new version to change them.` : undefined;

  return (
    <>
    <DocsTab
      scopeKind="framework_version" scopeId={version.id} targets={targets.data ?? []} canWrite={writer} editable={version.status === 'draft'} {...(fixedNote ? { fixedNote } : {})} api={docs}
      label={internal ? 'Documents' : 'Docs'} onDocuments={setList}
      footer={(version.status === 'draft' || version.status === 'in_review') && (
        <AnalysisPanel api={api} versionId={version.id} editable={editable} hasSources={list.length > 0} onWritten={written}
          documentTitle={(id) => list.find((d) => d.id === id)?.name ?? 'a document'} onShowPage={showPage} {...(onShowRequirement ? { onShowRequirement } : {})} {...(onShowReport ? { onShowReport } : {})} />
      )}
      rowExtras={(d) => ({
        domId: `source-${d.id}`,
        chips: (
          <>
            <Shaded>{d.roleOrigin === 'unset' || !d.role ? 'Role not set' : `${ROLE_LABEL[d.role as SourceRole] ?? d.role}${d.roleOrigin === 'ai' ? ' (AI)' : ''}`}</Shaded>
            <Shaded>{AUTHORITY_LABEL[d.authority as SourceAuthority] ?? d.authority ?? ''}</Shaded>
          </>
        ),
        menu: editable ? [
          { label: 'Edit details', onSelect: () => setEditing(d) },
          { label: d.hasFile ? 'Replace file' : 'Upload file', onSelect: () => { replacing.current = d; picker.open(); } },
        ] : [],
        detailsLabel: 'Page text', open: open.has(d.id), onToggle: () => toggle(d.id),
        details: (
          <>
            <p className="text-xs text-muted-foreground">Quotes in notes are checked against this text. Correct it where the reading went wrong.</p>
            <Pages api={api} doc={{ id: d.id, title: d.name, textStatus: d.status }} editable={editable} onChange={() => void refresh()} {...(focus?.documentId === d.id ? { focus } : {})} />
          </>
        ),
      })}
    />
    {picker.input}
    {error && !editing && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {editing && (
      <DetailsDialog doc={asSource(editing)} error={error} onClose={close} onSave={async (v) => {
        setError('');
        if (await run(() => api.updateDocument(editing.id, { title: v.title, ...(v.role ? { role: v.role } : {}), authority: v.authority, language: v.language }))) { await refresh(); close(); }
      }} />
    )}
    </>
  );
}
