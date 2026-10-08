import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@ams/shared';
import { AccordionCard, Shaded, useEscape } from '../../components/accordion';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import type { FrameworkApi, SourceAuthority, SourceDocument, SourceRole, Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';

export const ROLE_LABEL: Record<SourceRole, string> = {
  standards: 'Standards', policy_procedure: 'Policy and procedure', guidance: 'Guidance', report_template: 'Report template',
  evidence_guidance: 'Evidence guidance', amendment: 'Amendment', sample_report: 'Sample report', correspondence: 'Correspondence', other: 'Other',
};
export const AUTHORITY_LABEL: Record<SourceAuthority, string> = { binding: 'Binding', interpretive: 'Interpretive', informational: 'Informational' };
const select = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm';
const kb = (n: number | null) => (n === null ? '' : n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Adds a source (with its original, optionally) or changes how one is described. */
function SourceDialog({ editing, error, onSave, onClose }: {
  editing: SourceDocument | null; error: string; onSave: (v: { title: string; role: SourceRole; authority: SourceAuthority; language: string; file: File | null }) => Promise<unknown>; onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  useEscape(onClose);
  const heading = editing ? 'Edit source' : 'New source';
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    void onSave({ title: String(f.get('title')).trim(), role: String(f.get('role')) as SourceRole, authority: String(f.get('authority')) as SourceAuthority, language: String(f.get('language')).trim() || 'en', file })
      .finally(() => setBusy(false));
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="source-dialog-title" className="w-full max-w-xl rounded-lg bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="source-dialog-title" className="text-xl font-semibold">{heading}</h2>
          <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
        </div>
        <form onSubmit={submit} className="space-y-3" aria-label={heading}>
          <label className="flex flex-col text-sm">Title<Input name="title" aria-label="Title" defaultValue={editing?.title ?? ''} required autoFocus dir="auto" /></label>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_6rem]">
            <label className="flex flex-col text-sm">What it is
              <select name="role" aria-label="What it is" defaultValue={editing?.role ?? 'standards'} className={select}>
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
              <input aria-label="Original file" type="file" accept="application/pdf,.pdf,.docx,.doc" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          )}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{editing ? 'Save' : 'Add source'}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The pages of a source: pick one to read its text; on a draft, correct it, remove it or add another. */
function Pages({ api, doc, editable, onChange }: { api: FrameworkApi; doc: SourceDocument; editable: boolean; onChange: () => void }) {
  const qc = useQueryClient();
  const pages = useQuery({ queryKey: ['source-pages', doc.id], queryFn: () => api.pages(doc.id) });
  const [pick, setPick] = useState<number | null>(null);
  const [error, setError] = useState('');
  const run = useAction(setError);
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
              <button key={p.pageNo} type="button" role="tab" aria-selected={current?.pageNo === p.pageNo} onClick={() => setPick(p.pageNo)}
                className={`min-w-9 rounded-md border px-2 py-1 text-xs ${current?.pageNo === p.pageNo ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}>{p.pageNo}</button>
            ))}
          </div>
          {current && (editable ? (
            <form key={`${current.pageNo}-${current.text.length}`} className="space-y-2" aria-label={`Page ${current.pageNo}`}
              onSubmit={(e) => { e.preventDefault(); void save(current.pageNo, String(new FormData(e.currentTarget).get('text'))); }}>
              <textarea name="text" aria-label={`Text of page ${current.pageNo}`} rows={8} dir="auto" defaultValue={current.text} className="w-full rounded-md border border-border p-2 text-sm" />
              <div className="flex gap-2">
                <Button type="submit" variant="outline">Save page {current.pageNo}</Button>
                <Button type="button" variant="ghost" onClick={() => { if (window.confirm(`Remove page ${current.pageNo}?`)) void run(() => api.deletePage(doc.id, current.pageNo)).then(refresh).then(() => setPick(null)); }}>Remove page</Button>
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

/**
 * A version's sources: the accreditor's documents its requirements and notes come from, with each original file and the
 * text of its pages (quotes are verified against that text). Editable while the version is a draft.
 */
export function SourcesSection({ api, version, me }: { api: FrameworkApi; version: Version; me: Me | undefined }) {
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ['documents', version.id], queryFn: () => api.documents(version.id) });
  const editable = version.status === 'draft' && can(me, 'framework:write');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'edit'; doc: SourceDocument } | null>(null);
  const [error, setError] = useState('');
  const run = useAction(setError);
  const refresh = () => qc.invalidateQueries({ queryKey: ['documents', version.id] });
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const close = () => { setDialog(null); setError(''); };
  const pickFile = (doc: SourceDocument) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/pdf,.pdf,.docx,.doc';
    input.onchange = () => { const f = input.files?.[0]; if (f) void run(() => api.uploadSourceFile(doc.id, f)).then(refresh); };
    input.click();
  };
  const list = docs.data ?? [];
  return (
    <section aria-label="Sources" className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{list.length} source{list.length === 1 ? '' : 's'}</span>
        {editable && <Button type="button" className="ms-auto" onClick={() => setDialog({ kind: 'add' })}>+ Source</Button>}
      </div>
      {version.status !== 'draft' && <p className="text-xs text-muted-foreground">The sources of a {version.status === 'in_review' ? 'version in review' : 'published version'} are fixed with it; start a new version to change them.</p>}
      {error && !dialog && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {docs.data && list.length === 0 && <p className="text-sm text-muted-foreground">No sources yet.</p>}
      <div className="space-y-2">
        {list.map((d) => {
          const role = ROLE_LABEL[d.role as SourceRole] ?? d.role;
          const pages = d.storedPages ?? d.pageCount ?? 0;
          return (
            <AccordionCard key={d.id} label={d.title} tag={role} title={d.title} testId="source-document" open={open.has(d.id)} onToggle={() => toggle(d.id)}
              menuLabel={`Actions for ${d.title}`}
              menu={editable ? [
                { label: 'Edit', onSelect: () => setDialog({ kind: 'edit', doc: d }) },
                { label: d.hasFile ? 'Replace file' : 'Upload file', onSelect: () => pickFile(d) },
                { label: 'Delete', onSelect: () => { if (window.confirm(`Delete ${d.title} and its pages?`)) void run(() => api.deleteDocument(d.id)).then(refresh); } },
              ] : []}
              meta={<span className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
                <span>{AUTHORITY_LABEL[d.authority as SourceAuthority] ?? d.authority}</span>
                <span>{pages} page{pages === 1 ? '' : 's'}</span>
                {d.hasFile && <span className="rounded bg-muted px-1.5 py-0.5">File</span>}
              </span>}>
              <div className="space-y-1">
                <Shaded>Original</Shaded>
                {d.hasFile
                  ? <p className="text-sm"><a className="underline" href={api.sourceFileUrl(d.id)} target="_blank" rel="noreferrer"><ContentText>{d.fileName ?? 'file'}</ContentText></a> <span className="text-xs text-muted-foreground">{kb(d.size)}</span></p>
                  : <p className="text-sm text-muted-foreground">No file uploaded.{editable ? ' Use the ⋯ menu to upload it.' : ''}</p>}
              </div>
              <div className="space-y-1">
                <Shaded>Pages</Shaded>
                <Pages api={api} doc={d} editable={editable} onChange={() => void refresh()} />
              </div>
            </AccordionCard>
          );
        })}
      </div>
      {dialog?.kind === 'add' && (
        <SourceDialog editing={null} error={error} onClose={close} onSave={async (v) => {
          setError('');
          const doc = await run(() => api.addDocument(version.id, { title: v.title, role: v.role, authority: v.authority, language: v.language }));
          if (!doc) return;
          if (v.file && !(await run(() => api.uploadSourceFile(doc.id, v.file!)))) { await refresh(); return; }
          await refresh();
          setOpen((s) => new Set([...s, doc.id]));
          close();
        }} />
      )}
      {dialog?.kind === 'edit' && (
        <SourceDialog editing={dialog.doc} error={error} onClose={close} onSave={async (v) => {
          setError('');
          if (await run(() => api.updateDocument(dialog.doc.id, { title: v.title, role: v.role, authority: v.authority, language: v.language }))) { await refresh(); close(); }
        }} />
      )}
    </section>
  );
}
