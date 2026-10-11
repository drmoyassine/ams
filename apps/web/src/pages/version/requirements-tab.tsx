import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AiMarker, AuthorityBadge, QuoteNotFoundBadge, ReviewBadge } from '../../components/badges';
import { ContentText } from '../../components/content-text';
import { requirementLabel } from '../../lib/format';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { ApiError, type FrameworkApi, type Note, type Requirement, type SourceDocument, type Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import { EvidenceLinkList } from '../../components/evidence-links';
import { LinkEvidenceDialog } from '../../components/link-evidence-dialog';
import { useEvidenceApi, type EvidenceApi } from '../../lib/evidence-api';
import type { Me } from '@ams/shared';

type Props = { api: FrameworkApi; version: Version; me: Me | undefined; evidence?: EvidenceApi };

export function useAction(onError: (m: string) => void, invalidate: () => Promise<unknown>) {
  return useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => { onError(''); try { await fn(); await invalidate(); } catch (e) { if (e instanceof ApiError) onError(e.message); else throw e; } },
  });
}

/**
 * One note of a requirement. `perLineReview` is for the internal framework only: an external standard's notes are not
 * approved one by one; publishing the version is the review (DEC-022), so they show no review status or approve/reject.
 */
export function NotePanel({ api, note, editable, canReview, perLineReview = true, invalidate, setError, onShowSource, selected = false, reasons = [] }: {
  api: FrameworkApi; note: Note; editable: boolean; canReview: boolean; perLineReview?: boolean; invalidate: () => Promise<unknown>; setError: (m: string) => void;
  /** External standards' split view: shows the note's source page beside the list. */
  onShowSource?: () => void; selected?: boolean; /** Why this note needs a look (see needs-look.ts), in words. */ reasons?: string[];
}) {
  const act = useAction(setError, invalidate);
  return (
    <li id={`note-${note.id}`} tabIndex={-1} className={`scroll-mt-4 rounded border p-3 ${selected ? 'border-primary' : 'border-border'}`} data-testid="note" aria-current={selected ? 'true' : undefined}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <AuthorityBadge authority={note.authority} />
        <span className="text-xs text-muted-foreground">{note.type.replace('_', ' ')}</span>
        {perLineReview && <ReviewBadge status={note.reviewStatus} />}
        {note.authority === 'required' && <span className="text-xs" data-testid="quote-state">{note.quoteVerified ? 'Quote verified' : 'Quote NOT verified'}</span>}
        {note.origin === 'ai' && <AiMarker />}
        {note.sourceQuote && !note.quoteVerified && <QuoteNotFoundBadge />}
        {reasons.filter((r) => r !== 'Quote not found').map((r) => <span key={r} data-testid="look-reason" className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900">{r}</span>)}
      </div>
      <p className="text-sm"><ContentText>{note.text}</ContentText></p>
      {note.sourceQuote && <blockquote className="mt-1 border-s-2 border-border ps-2 text-xs text-muted-foreground"><ContentText>{note.sourceQuote}</ContentText> <span>(page {note.sourcePage})</span></blockquote>}
      <div className="mt-2 flex flex-wrap gap-2">
        {onShowSource && note.sourceDocumentId && <Button type="button" variant="outline" className="px-3 py-1" aria-label={`Show the source of this note`} onClick={onShowSource}>Source</Button>}
        {perLineReview && canReview && editable && <>
          <Button type="button" variant="ghost" onClick={() => act.mutate(() => api.reviewNote(note.id, 'approved'))}>Approve note</Button>
          <Button type="button" variant="ghost" onClick={() => act.mutate(() => api.reviewNote(note.id, 'rejected'))}>Reject note</Button>
        </>}
        {editable && note.authority === 'ai_suggested' && ['required', 'example', 'suggested', 'institution_defined'].map((a) => (
          <Button key={a} type="button" variant="ghost" onClick={() => act.mutate(() => api.setAuthority(note.id, a as 'required'))}>Promote to {a.replace('_', '-')}</Button>
        ))}
        {editable && <Button type="button" variant="ghost" onClick={() => act.mutate(() => api.deleteNote(note.id))}>Delete note</Button>}
      </div>
    </li>
  );
}

export function AddNote({ api, requirementId, docs, invalidate, setError }: { api: FrameworkApi; requirementId: string; docs: SourceDocument[]; invalidate: () => Promise<unknown>; setError: (m: string) => void }) {
  const act = useAction(setError, invalidate);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const doc = String(f.get('doc'));
    const authority = String(f.get('authority')) as 'required';
    act.mutate(() => api.addNote(requirementId, {
      type: String(f.get('type')) as Note['type'], text: String(f.get('text')), authority,
      ...(doc ? { source: { documentId: doc, page: Number(f.get('page')), quote: String(f.get('quote')) } } : {}),
    }));
  };
  const select = 'rounded-md border border-border bg-background px-2 py-2 text-sm';
  return (
    <form onSubmit={submit} className="mt-3 space-y-2 rounded border border-dashed border-border p-3" aria-label="Add note">
      <textarea name="text" required aria-label="Note text" rows={2} className="w-full rounded-md border border-border p-2 text-sm" />
      <div className="flex flex-wrap gap-2">
        <select name="type" aria-label="Note type" className={select}><option value="guidance">Guidance</option><option value="evidence_expectation">Evidence expectation</option><option value="data_request">Data request</option><option value="quantitative_norm">Quantitative norm</option></select>
        <select name="authority" aria-label="Authority" className={select}><option value="suggested">Suggested</option><option value="example">Example</option><option value="required">Required</option><option value="institution_defined">Institution-defined</option></select>
        <select name="doc" aria-label="Source document" className={select}><option value="">No source</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select>
        <Input name="page" type="number" min={1} aria-label="Source page" placeholder="Page" className="w-24" />
      </div>
      <Input name="quote" aria-label="Source quote" placeholder="Verbatim quote from the page (required for Required notes)" />
      <Button type="submit">Add note</Button>
    </form>
  );
}

/** Evidence attached to an item of the internal framework: offered from here to every requirement mapped onto it. */
export function InternalEvidence({ requirementId, me, evidence }: { requirementId: string; me: Me | undefined; evidence?: EvidenceApi }) {
  const api = useEvidenceApi(evidence);
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const links = useQuery({ queryKey: ['internal-evidence', requirementId], queryFn: () => api.internalLinks(requirementId) });
  const [linking, setLinking] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['internal-evidence', requirementId] }); };
  return (
    <section aria-label="Evidence" className="space-y-2 border-t border-border pt-3">
      <h4 className="font-medium">Evidence</h4>
      <p className="text-xs text-muted-foreground">Attach evidence here once. Every accreditor requirement mapped to this item is offered it.</p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <EvidenceLinkList links={links.data ?? []} api={api} canReview={can(me, 'evidence:review')} canRemove={can(me, 'evidence:write')} onChange={refresh} setError={setError} />
      {can(me, 'evidence:write') && <Button type="button" variant="ghost" onClick={() => setLinking(true)}>+ Link evidence</Button>}
      {linking && <LinkEvidenceDialog api={api} title="this item" onClose={() => setLinking(false)} onLink={(evidenceVersionId, rationale) => api.linkInternal(requirementId, { evidenceVersionId, rationale }).then(refresh)} />}
    </section>
  );
}

function Detail({ api, version, req, me, docs, setError, invalidateTree, evidence }: Props & { req: Requirement; docs: SourceDocument[]; setError: (m: string) => void; invalidateTree: () => Promise<unknown> }) {
  const qc = useQueryClient();
  const editable = version.status === 'draft';
  const canWrite = editable && can(me, 'framework:write');
  const canReview = editable && can(me, 'framework:review');
  const detail = useQuery({ queryKey: ['requirement', req.id], queryFn: () => api.requirement(req.id) });
  const invalidate = async () => { await qc.invalidateQueries({ queryKey: ['requirement', req.id] }); await invalidateTree(); };
  const act = useAction(setError, invalidate);
  const del = useAction(setError, invalidateTree);
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    act.mutate(() => api.patchRequirement(req.id, { code: String(f.get('code')), title: String(f.get('title')), officialText: String(f.get('officialText')), isAssessable: f.get('assessable') === 'on' }));
  };
  return (
    <div className="space-y-3" data-testid="requirement-detail">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold"><ContentText>{req.code} — {req.title}</ContentText></h3>
        <ReviewBadge status={req.reviewStatus} />
      </div>
      <form key={`${req.id}-${req.title}-${req.officialText}-${req.code}`} onSubmit={save} className="space-y-2">
        <label className="block text-sm">Code <Input name="code" defaultValue={req.code} readOnly={!canWrite} dir="auto" /></label>
        <label className="block text-sm">Title <Input name="title" defaultValue={req.title} readOnly={!canWrite} dir="auto" /></label>
        <label className="block text-sm">Description (verbatim from the source)
          <textarea name="officialText" dir="auto" rows={4} defaultValue={req.officialText ?? ''} readOnly={!canWrite} className="w-full rounded-md border border-border p-2 text-sm" />
        </label>
        <label className="text-sm"><input type="checkbox" name="assessable" defaultChecked={req.isAssessable} disabled={!canWrite} /> Assessable (not just a heading)</label>
        <div className="flex flex-wrap gap-2">
          {canWrite && <Button type="submit">Save (returns it to review)</Button>}
          {canReview && <>
            <Button type="button" variant="ghost" onClick={() => act.mutate(() => api.reviewRequirement(req.id, 'approved'))}>Approve</Button>
            <Button type="button" variant="ghost" onClick={() => act.mutate(() => api.reviewRequirement(req.id, 'rejected'))}>Reject</Button>
          </>}
          {canWrite && version.internal && <>
            <Button type="button" variant="ghost" aria-label="Indent" title="Move under the item above it (one level deeper)" onClick={() => act.mutate(() => api.indentRequirement(req.id))}>Indent →</Button>
            <Button type="button" variant="ghost" aria-label="Outdent" title="Move out to follow its parent (one level up)" onClick={() => act.mutate(() => api.outdentRequirement(req.id))}>← Outdent</Button>
          </>}
          {canWrite && <Button type="button" variant="ghost" onClick={() => del.mutate(() => api.deleteRequirement(req.id))}>Delete</Button>}
        </div>
      </form>
      <h4 className="font-medium">Notes</h4>
      <ul className="space-y-2">
        {(detail.data?.notes ?? []).map((n) => <NotePanel key={n.id} api={api} note={n} editable={canWrite || canReview} canReview={canReview} invalidate={invalidate} setError={setError} />)}
        {detail.data?.notes.length === 0 && <li className="text-sm text-muted-foreground">No notes.</li>}
      </ul>
      {canWrite && <AddNote api={api} requirementId={req.id} docs={docs} invalidate={invalidate} setError={setError} />}
      {version.internal && <InternalEvidence requirementId={req.id} me={me} {...(evidence ? { evidence } : {})} />}
    </div>
  );
}

export function RequirementsTab({ api, version, me, evidence }: Props) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const tree = useQuery({ queryKey: ['requirements', version.id], queryFn: () => api.requirements(version.id) });
  const docs = useQuery({ queryKey: ['documents', version.id], queryFn: () => api.documents(version.id) });
  const invalidateTree = () => qc.invalidateQueries({ queryKey: ['requirements', version.id] });
  const canWrite = version.status === 'draft' && can(me, 'framework:write');
  const rows = tree.data ?? [];
  const current = rows.find((r) => r.id === selected) ?? null;
  const add = useAction(setError, invalidateTree);
  const labels = (version.levelLabels as string[] | undefined) ?? [];

  const create = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parent = String(f.get('parent'));
    add.mutate(() => api.createRequirement(version.id, {
      code: String(f.get('code')), title: String(f.get('title')),
      // In the internal framework the level is the depth; the server names it from the parent.
      levelLabel: version.internal ? (labels[0] ?? 'Level 1') : String(f.get('level')),
      ...(parent ? { parentId: parent } : {}),
    }));
    e.currentTarget.reset();
  };

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div>
        {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
        <ul role="tree" aria-label="Requirements" className="space-y-1">
          {rows.map((r) => (
            <li key={r.id} role="treeitem" aria-selected={selected === r.id} style={{ paddingInlineStart: `${(r.depth ?? 0) * 1.25}rem` }}>
              <button type="button" onClick={() => setSelected(r.id)} className={`w-full rounded px-2 py-1 text-start text-sm hover:bg-muted ${selected === r.id ? 'bg-muted font-medium' : ''}`}>
                <span className="text-muted-foreground">{r.levelLabel}</span> <ContentText>{requirementLabel(r.code, r.title)}</ContentText>
                {r.reviewStatus !== 'approved' && <span className="ms-2 text-xs text-muted-foreground">({r.reviewStatus})</span>}
              </button>
            </li>
          ))}
          {rows.length === 0 && <li className="text-sm text-muted-foreground">No requirements yet.</li>}
        </ul>
        {canWrite && (
          <form onSubmit={create} className="mt-4 space-y-2 rounded border border-dashed border-border p-3" aria-label="Add requirement">
            <div className="grid grid-cols-2 gap-2">
              <Input name="code" required placeholder="Code, e.g. CFR 1.1" aria-label="Code" />
              {!version.internal && <select name="level" aria-label="Level" className="rounded-md border border-border bg-background px-2 py-2 text-sm">{labels.map((l) => <option key={l}>{l}</option>)}{labels.length === 0 && <option>Standard</option>}</select>}
            </div>
            <Input name="title" required placeholder="Title" aria-label="Title" dir="auto" />
            <select name="parent" aria-label="Parent" className="w-full rounded-md border border-border bg-background px-2 py-2 text-sm">
              <option value="">{version.internal ? `Top level (${labels[0] ?? 'Level 1'})` : 'Top level'}</option>{rows.map((r) => <option key={r.id} value={r.id}>{requirementLabel(r.code, r.title)}</option>)}
            </select>
            <Button type="submit">Add requirement</Button>
          </form>
        )}
      </div>
      <div>{current ? <Detail api={api} version={version} req={current} me={me} docs={docs.data ?? []} setError={setError} invalidateTree={invalidateTree} {...(evidence ? { evidence } : {})} /> : <p className="text-sm text-muted-foreground">Select a requirement.</p>}</div>
    </div>
  );
}
