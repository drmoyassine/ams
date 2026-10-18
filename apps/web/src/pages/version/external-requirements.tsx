import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@ams/shared';
import { AccordionCard, Shaded } from '../../components/accordion';
import { AiMarker, QuoteNotFoundBadge } from '../../components/badges';
import { BottomSheet } from '../../components/bottom-sheet';
import { useConfirm } from '../../components/confirm-dialog';
import { ContentText } from '../../components/content-text';
import { Dialog } from '../../components/dialog';
import { EvidenceLinkList } from '../../components/evidence-links';
import { LinkEvidenceDialog } from '../../components/link-evidence-dialog';
import { RequirementsLayout } from '../../components/requirements-layout';
import { ReviewBadge } from '../../components/badges';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { BulkBar, RowGutter, TreeProvider, TreeRow, TreeToolbar, useRowFocus } from '../../components/tree/tree';
import { usePublishScreen } from '../../lib/assistant-screen';
import { useEvidenceApi, type EvidenceApi } from '../../lib/evidence-api';
import { distinctTitle, requirementLabel } from '../../lib/format';
import type { FrameworkApi, MergeResult, Requirement, SplitResult, Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';
import { confirmAndDelete } from '../../lib/delete-requirements';
import { LOOK_HINT, LOOK_KINDS, LOOK_LABEL, lookCounts, lookItems, nextLookItem, visibleRequirements, type LookKind } from './needs-look';
import { AddNote, NotePanel } from './requirements-tab';
import { MapToIqfDialog, RELATIONS } from './map-to-iqf-dialog';
import { EvidenceSummary, RequirementHover, useRequirementContexts } from './requirement-hover';
import { MergeDialog, MoveDialog, SplitDialog, nameOf, tagOf } from './review-dialogs';
import { SourceViewer, useWide, type Citation } from './source-viewer';
import { WrittenByAssistant } from '../../components/assistant/written-marker';
import { TranslationBlock, useShownText } from './translations';

const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The requirement or note whose source is shown beside the list. */
type Selection = { kind: 'requirement' | 'note'; id: string; requirementId: string } | null;

interface DialogValues { code: string; title: string; description: string; assessable: boolean; level: string; parentId: string }

/** Adds or edits a requirement: code, title, the description (the requirement's own wording, verbatim from the source), and where it sits. */
function RequirementDialog({ editing, parent, levels, rows, error, onSave, onClose }: {
  editing: Requirement | null; parent: Requirement | null; levels: string[]; rows: Requirement[]; error: string;
  onSave: (v: DialogValues) => Promise<unknown>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const depth = parent ? (parent.depth ?? 0) + 1 : 0;
  const defaultLevel = levels[Math.min(depth, levels.length - 1)] ?? 'Requirement';
  const heading = editing ? `Edit ${tagOf(editing)}` : parent ? `New item under ${tagOf(parent)}` : 'New requirement';
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    void onSave({
      code: String(f.get('code')).trim(), title: String(f.get('title')).trim(), description: String(f.get('description')).trim(),
      assessable: f.get('assessable') === 'on', level: String(f.get('level') ?? defaultLevel), parentId: String(f.get('parent') ?? ''),
    }).finally(() => setBusy(false));
  };
  const select = 'rounded-md border border-border bg-background px-2 py-2 text-sm';
  return (
    <Dialog labelledBy="req-dialog-title" onClose={onClose}>
      <div className="mb-4 flex items-start justify-between gap-2">
        <h2 id="req-dialog-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">{heading}</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <form onSubmit={submit} className="space-y-3" aria-label={heading}>
        <div className="flex gap-2">
          <label className="flex w-40 flex-col text-sm">Code<Input name="code" aria-label="Code" defaultValue={editing?.code ?? ''} required dir="auto" placeholder="e.g. CFR 1.1" /></label>
          <label className="flex flex-1 flex-col text-sm">Title<Input name="title" aria-label="Title" defaultValue={editing?.title ?? ''} required autoFocus dir="auto" /></label>
        </div>
        {!editing && (
          <div className="flex gap-2">
            <label className="flex flex-1 flex-col text-sm">Level
              <select name="level" aria-label="Level" defaultValue={defaultLevel} className={select}>
                {(levels.length ? levels : ['Requirement']).map((l) => <option key={l}>{l}</option>)}
              </select>
            </label>
            <label className="flex flex-1 flex-col text-sm">Under
              <select name="parent" aria-label="Under" defaultValue={parent?.id ?? ''} className={select}>
                <option value="">Top level</option>
                {rows.map((r) => <option key={r.id} value={r.id}>{nameOf(r)}</option>)}
              </select>
            </label>
          </div>
        )}
        <label className="flex flex-col text-sm">Description (verbatim from the source)
          <textarea name="description" aria-label="Description" rows={5} dir="auto" defaultValue={editing?.officialText ?? ''} className="rounded-md border border-border p-2 text-sm" />
        </label>
        <label className="text-sm"><input type="checkbox" name="assessable" aria-label="Assessable" defaultChecked={editing ? editing.isAssessable : true} /> Assessable (not just a heading)</label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <p className="text-xs text-muted-foreground">{editing ? 'The change is part of this draft until the version is published.' : 'It is added to this draft; publishing the version is the review.'}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{editing ? 'Save' : 'Add requirement'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

interface NodeProps {
  api: FrameworkApi; version: Version; me: Me | undefined; r: Requirement; all: Requirement[]; levels: string[];
  /** Children of every requirement (null: the top level), in order, built once. */
  kids: Map<string | null, Requirement[]>; collapsed: ReadonlySet<string>;
  editable: boolean; open: Set<string>; toggle: (id: string) => void; act: (fn: () => Promise<unknown>) => Promise<unknown>;
  onAddChild: (r: Requirement) => void; onEdit: (r: Requirement) => void; setError: (m: string) => void; invalidateTree: () => Promise<unknown>;
  /** The item whose source is shown, and how to show another's (`sheet`: also open the bottom sheet on a small screen). */
  selected: Selection; onSelect: (s: NonNullable<Selection>, sheet?: boolean) => void;
  /** Why an item needs a look, by requirement or note id; the requirements to show while a filter is on (null: all). */
  look: Map<string, LookKind[]>; visible: Set<string> | null;
  onMerge: (r: Requirement) => void; onSplit: (r: Requirement) => void; onMove: (r: Requirement) => void;
  /** Map to IQF and Link evidence work on published versions too: both live outside the frozen version. */
  onMap: (r: Requirement) => void; onLinkEvidence: (r: Requirement) => void;
  /** The page's one batched answer: per requirement code, its mapped IQF items and evidence (the hover card and the card's body). */
  evidence: EvidenceApi; contexts: ReturnType<typeof useRequirementContexts>;
}

/**
 * What a card shows when it is open: the description, the source and the notes. Its own component so that the queries
 * (the requirement's notes, the version's documents) exist only for cards that are open, not for every row of a long list.
 */
function NodeBody({ p, showSource }: { p: NodeProps; showSource: () => void }) {
  const { api, version, r, editable, selected, look } = p;
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['requirement', r.id], queryFn: () => api.requirement(r.id) });
  const docs = useQuery({ queryKey: ['documents', version.id], queryFn: () => api.documents(version.id), enabled: editable });
  const invalidate = async () => { await qc.invalidateQueries({ queryKey: ['requirement', r.id] }); await p.invalidateTree(); };
  const links = useQuery({ queryKey: ['internal-evidence', r.id], queryFn: () => p.evidence.internalLinks(r.id) });
  const [linkError, setLinkError] = useState('');
  const ctx = p.contexts.data?.byCode[r.code];
  const refreshLinks = () => {
    void qc.invalidateQueries({ queryKey: ['internal-evidence', r.id] });
    void qc.invalidateQueries({ queryKey: ['requirement-context', version.id] });
  };
  return (
    <>
        <div className="space-y-1" data-testid="requirement-detail">
          <Shaded>Description</Shaded>
          {r.officialText ? <p className="whitespace-pre-line text-sm"><ContentText>{r.officialText}</ContentText></p> : <p className="text-sm text-muted-foreground">No description.</p>}
          <TranslationBlock entityId={r.id} field="title" className="mt-1" />
          {r.officialText && <TranslationBlock entityId={r.id} field="statement" className="mt-1" />}
          <WrittenByAssistant versionId={version.id} requirementId={r.id} canWrite={editable} onChanged={p.invalidateTree} />
          {!r.isAssessable && <p className="text-xs text-muted-foreground">A heading only; it is not assessed itself.</p>}
          {r.sourceQuote && (
            <blockquote className="mt-1 border-s-2 border-border ps-2 text-xs text-muted-foreground" data-testid="requirement-source">
              <ContentText>{r.sourceQuote}</ContentText> <span>(page {r.sourcePage})</span>
            </blockquote>
          )}
          {r.sourceDocumentId && (
            <Button type="button" variant="outline" className="mt-1 px-3 py-1" aria-label={`Show the source of ${tagOf(r)}`} aria-pressed={selected?.kind === 'requirement' && selected.id === r.id} onClick={showSource}>Source</Button>
          )}
        </div>
        <div className="space-y-1">
          <Shaded>Notes</Shaded>
          <ul className="space-y-2">
            {(detail.data?.notes ?? []).map((n) => (
              <NotePanel key={n.id} api={api} note={n} editable={editable} canReview={false} perLineReview={false} invalidate={invalidate} setError={p.setError}
                selected={selected?.kind === 'note' && selected.id === n.id} reasons={(look.get(n.id) ?? []).filter((k) => k !== 'quoteNotFound').map((k) => LOOK_LABEL[k])}
                onShowSource={() => p.onSelect({ kind: 'note', id: n.id, requirementId: r.id }, true)} />
            ))}
            {detail.data?.notes.length === 0 && <li className="text-sm text-muted-foreground">No notes.</li>}
          </ul>
          {editable && <AddNote api={api} requirementId={r.id} docs={docs.data ?? []} invalidate={invalidate} setError={p.setError} />}
        </div>
        <div className="space-y-1" data-testid="requirement-iqf">
          <Shaded>Mapped to IQF</Shaded>
          {!ctx || ctx.mappings.length === 0
            ? <p className="text-sm text-muted-foreground">Not mapped to your quality framework yet.</p>
            : (
              <ul className="space-y-1 text-sm" aria-label="Mapped IQF items">
                {ctx.mappings.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words"><ContentText>{requirementLabel(m.internalCode, m.internalTitle ?? '')}</ContentText></span>
                    <span className="text-xs text-muted-foreground">{RELATIONS[m.relation]}</span>
                    <ReviewBadge status={m.reviewStatus} />
                  </li>
                ))}
              </ul>
            )}
        </div>
        <div className="space-y-1" data-testid="requirement-evidence">
          <Shaded>Evidence</Shaded>
          {linkError && <p role="alert" className="text-sm text-red-700">{linkError}</p>}
          <EvidenceLinkList links={links.data ?? []} api={p.evidence} canReview={can(p.me, 'evidence:review')} canRemove={can(p.me, 'evidence:write')} onChange={refreshLinks} setError={setLinkError} />
          {ctx && ctx.inheritedCount > 0 && <EvidenceSummary ctx={ctx} showDirect={false} />}
        </div>
    </>
  );
}

/** One requirement as a card; its children follow indented below it. */
function Node(p: NodeProps) {
  const { api, r, levels, editable, open, toggle, act, look } = p;
  const confirm = useConfirm();
  const isOpen = open.has(r.id);
  const allChildren = p.kids.get(r.id) ?? [];
  const children = p.collapsed.has(r.id) ? [] : allChildren.filter((x) => !p.visible || p.visible.has(x.id));
  const focus = useRowFocus(r.id);
  const top = !r.parentId;
  const childLevel = levels[Math.min((r.depth ?? 0) + 1, levels.length - 1)];
  const showSource = () => p.onSelect({ kind: 'requirement', id: r.id, requirementId: r.id }, true);
  const shownTitle = useShownText(r.id, 'title', r.title);
  const reasons = (look.get(r.id) ?? []).filter((k) => k !== 'quoteNotFound');
  const menu = [
    ...(r.sourceDocumentId ? [{ label: 'Show source', onSelect: showSource }] : []),
    ...(editable ? [{ label: childLevel ? `Add ${childLevel.toLowerCase()}` : 'Add item', onSelect: () => p.onAddChild(r) }, { label: 'Edit', onSelect: () => p.onEdit(r) }] : []),
    ...(can(p.me, 'framework:write') ? [{ label: 'Map to IQF…', onSelect: () => p.onMap(r) }] : []),
    ...(can(p.me, 'evidence:write') ? [{ label: 'Link evidence', onSelect: () => p.onLinkEvidence(r) }] : []),
    ...(editable ? [
      { label: 'Merge into another requirement', onSelect: () => p.onMerge(r) },
      { label: 'Split', onSelect: () => p.onSplit(r) },
      { label: 'Move to…', onSelect: () => p.onMove(r) },
      { label: 'Delete', onSelect: () => void act(() => confirmAndDelete(api, confirm, [r.id], `Delete ${nameOf(r)}?`)) },
    ] : []),
  ];
  return (
    <>
      <TreeRow id={r.id}>
      <AccordionCard label={tagOf(r)} tag={tagOf(r)} title={distinctTitle(r.code, shownTitle)} strong={top} tone={top ? 'shaded' : 'plain'} testId="requirement-card" domId={`requirement-${r.id}`}
        gutter={<RowGutter id={r.id} />} toggleProps={focus}
        open={isOpen} onToggle={() => toggle(r.id)} menuLabel={`Actions for ${tagOf(r)}`} menu={menu}
        meta={<span className="flex flex-wrap items-center gap-2">
          {allChildren.length > 0 && <span className="text-xs text-muted-foreground">{allChildren.length} {allChildren.length === 1 ? 'item' : 'items'}</span>}
          <span className="text-xs text-muted-foreground">{r.levelLabel}</span>
          {r.origin === 'ai' && <AiMarker />}
          {r.sourceQuote && !r.quoteVerified && <QuoteNotFoundBadge />}
          {reasons.map((k) => <span key={k} title={LOOK_HINT[k]} data-testid="look-reason" className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900">{LOOK_LABEL[k]}</span>)}
        </span>}
        hover={<RequirementHover r={r} name={nameOf(r)} contexts={p.contexts} />}>
        <NodeBody p={p} showSource={showSource} />
      </AccordionCard>
      </TreeRow>
      {children.length > 0 && (
        <div role="list" aria-label={`Items of ${tagOf(r)}`} className="ms-8 space-y-2 border-s-2 border-border ps-3">
          {children.map((c) => <div role="listitem" key={c.id}><Node {...p} r={c} /></div>)}
        </div>
      )}
    </>
  );
}

/**
 * An external standard's requirements, laid out like the internal framework's: full-width closable cards with a shaded
 * tag, items indented under their parent, a ⋯ menu to add, edit, merge, split, move or delete (while the version is a draft),
 * and "+ Requirement" opening a dialog. Lines are not approved one by one: publishing the version is the review (DEC-022), so
 * the cards show provenance (AI, source page and quote, a quote not found) but no review status. Notes (guidance, expectations)
 * sit inside each card. Evidence is linked once to the internal standards these map onto ("Map to IQF…" from the ⋯ menu) and counts for
 the requirement through approved mappings; "Link evidence" adds evidence for this requirement only, at the library level (by code,
 so it carries over to new versions). Both work on a published version too: they live outside the frozen version.
 *
 * Split view (PRD 15.1 step 6): selecting a requirement or note shows where it comes from, the stored page text of its source
 * with the cited quote highlighted: beside the list on wide screens (each scrolls on its own), in a bottom sheet opened from
 * the card's Source button on small ones. "Needs a look" chips filter the list to what a person should check first.
 */
export function ExternalRequirements({ api, version, me, focusId, onOpenSource, evidence: evidenceOverride }: {
  api: FrameworkApi; version: Version; me: Me | undefined; /** A card to open and scroll to (a gap's link). */ focusId?: string | null; evidence?: EvidenceApi;
  /** Opens a source page in the Docs tab. */ onOpenSource?: (documentId: string, page: number) => void;
}) {
  const qc = useQueryClient();
  const wide = useWide();
  const evidence = useEvidenceApi(evidenceOverride);
  const contexts = useRequirementContexts(evidence, version.id);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsedSet] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<{ kind: 'add'; parent: Requirement | null } | { kind: 'edit'; item: Requirement } | { kind: 'merge' | 'split' | 'move' | 'map' | 'link'; item: Requirement } | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  usePublishScreen('selected-card', selected ? { selectedIds: [selected.requirementId] } : null);
  const [sheet, setSheet] = useState(false);
  const [filter, setFilter] = useState<LookKind | null>(null);
  const [lastLook, setLastLook] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<{ kind: 'requirement' | 'note'; id: string } | null>(null);
  const tree = useQuery({ queryKey: ['requirements', version.id], queryFn: () => api.requirements(version.id) });
  const review = useQuery({ queryKey: ['review-items', version.id], queryFn: () => api.reviewItems(version.id) });
  const documents = useQuery({ queryKey: ['documents', version.id], queryFn: () => api.documents(version.id) });
  const invalidateTree = async () => {
    await qc.invalidateQueries({ queryKey: ['requirements', version.id] });
    await qc.invalidateQueries({ queryKey: ['review-items', version.id] });
  };
  const run = useAction(setError);
  const act = (fn: () => Promise<unknown>) => { setError(''); return run(fn).then(invalidateTree); };
  const draft = version.status === 'draft';
  const editable = draft && can(me, 'framework:write');
  const all = useMemo(() => tree.data ?? [], [tree.data]);
  const kids = useMemo(() => {
    const m = new Map<string | null, Requirement[]>();
    for (const r of all) { const k = r.parentId ?? null; const l = m.get(k); if (l) l.push(r); else m.set(k, [r]); }
    return m;
  }, [all]);
  const tops = kids.get(null) ?? [];
  const setCollapsed = useCallback((id: string, c: boolean) => setCollapsedSet((s) => { const n = new Set(s); if (c) n.add(id); else n.delete(id); return n; }), []);
  const levels = (version.levelLabels as string[] | undefined) ?? [];
  const select = (s: NonNullable<Selection>, withSheet = false) => { setSelected(s); if (withSheet && !wide) setSheet(true); };
  const toggle = (id: string) => {
    const opening = !open.has(id);
    setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    if (opening) setSelected({ kind: 'requirement', id, requirementId: id }); // the viewer beside the list follows the card you open
  };
  const close = () => { setDialog(null); setError(''); };
  const loaded = !!tree.data;
  useEffect(() => {
    if (!focusId || !loaded) return;
    setOpen((s) => new Set([...s, focusId]));
    const el = document.getElementById(`requirement-${focusId}`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focusId, loaded]);

  // ---- Needs a look ----
  const items = useMemo(() => lookItems(review.data, all), [review.data, all]);
  const counts = useMemo(() => lookCounts(items), [items]);
  const look = useMemo(() => new Map(items.map((i) => [i.id, i.reasons] as const)), [items]);
  const visible = useMemo(() => visibleRequirements(filter, items, all), [filter, items, all]);
  const goNext = useCallback(() => {
    const target = nextLookItem(items, lastLook, filter);
    if (!target) return;
    setLastLook(target.id);
    setOpen((s) => new Set([...s, target.requirementId]));
    setSelected({ kind: target.kind, id: target.id, requirementId: target.requirementId });
    setScrollTo({ kind: target.kind, id: target.id });
  }, [items, lastLook, filter]);
  const nextRef = useRef(goNext);
  nextRef.current = goNext;
  const dialogOpen = dialog !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' || e.ctrlKey || e.metaKey || e.altKey || dialogOpen) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      e.preventDefault();
      nextRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialogOpen]);
  // After "Next", bring the item into view and give it the keyboard focus (a note may still be loading: look for a moment).
  useEffect(() => {
    if (!scrollTo) return;
    let tries = 0;
    const find = () => {
      const el = document.getElementById(scrollTo.kind === 'note' ? `note-${scrollTo.id}` : `requirement-${scrollTo.id}`);
      if (el) {
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
        const target = scrollTo.kind === 'note' ? el : el.querySelector<HTMLElement>('button[aria-expanded]');
        target?.focus({ preventScroll: true });
        setScrollTo(null);
        return true;
      }
      return ++tries > 30;
    };
    if (find()) return;
    const t = setInterval(() => { if (find()) clearInterval(t); }, 100);
    return () => clearInterval(t);
  }, [scrollTo]);

  // ---- The source of the selected item ----
  const selectedReq = selected ? all.find((r) => r.id === selected.requirementId) : undefined;
  const selectedDetail = useQuery({ queryKey: ['requirement', selected?.requirementId], queryFn: () => api.requirement(selected!.requirementId), enabled: !!selected });
  const citations: Citation[] = useMemo(() => {
    if (!selected || !selectedReq) return [];
    const title = (id: string) => documents.data?.find((d) => d.id === id)?.title ?? 'Source';
    const own: Citation[] = selectedReq.sourceDocumentId && selectedReq.sourcePage
      ? [{ key: `r:${selectedReq.id}`, label: `${tagOf(selectedReq)} · ${title(selectedReq.sourceDocumentId)}, page ${selectedReq.sourcePage}`, documentId: selectedReq.sourceDocumentId, page: selectedReq.sourcePage, quote: selectedReq.sourceQuote }]
      : [];
    const notes: Citation[] = (selectedDetail.data?.notes ?? []).filter((n) => n.sourceDocumentId && n.sourcePage).map((n) => ({
      key: `n:${n.id}`, label: `Note “${clip(n.text)}” · ${title(n.sourceDocumentId!)}, page ${n.sourcePage}`, documentId: n.sourceDocumentId!, page: n.sourcePage!, quote: n.sourceQuote,
    }));
    const first = selected.kind === 'note' ? `n:${selected.id}` : `r:${selectedReq.id}`;
    return [...own, ...notes].sort((a, b) => Number(b.key === first) - Number(a.key === first));
  }, [selected, selectedReq, selectedDetail.data, documents.data]);
  const viewerTitle = selectedReq ? `${nameOf(selectedReq)}${selected?.kind === 'note' ? ' (note)' : ''}` : '';
  const viewer = selected && selectedReq
    ? <SourceViewer key={`${selected.kind}:${selected.id}`} api={api} title={viewerTitle} citations={citations} {...(onOpenSource ? { onOpenInDocs: onOpenSource } : {})} />
    : <p className="text-sm text-muted-foreground">Select a requirement or a note to see where it comes from: the page of the source, with its quote highlighted.</p>;

  // ---- Saving ----
  const afterChange = async () => {
    await invalidateTree();
    await qc.invalidateQueries({ queryKey: ['requirement'] });
  };
  const saveNew = async (v: DialogValues) => {
    setError('');
    const r = await run(() => api.createRequirement(version.id, {
      code: v.code, title: v.title, levelLabel: v.level, isAssessable: v.assessable, ...(v.description ? { officialText: v.description } : {}),
      ...(v.parentId ? { parentId: v.parentId } : {}),
    }));
    await invalidateTree();
    if (!r) return;
    const created = r as Requirement;
    setOpen((s) => new Set([...s, ...(created.parentId ? [created.parentId] : []), created.id]));
    close();
  };
  const saveEdit = async (item: Requirement, v: DialogValues) => {
    setError('');
    const r = await run(() => api.patchRequirement(item.id, { code: v.code, title: v.title, officialText: v.description, isAssessable: v.assessable }));
    await invalidateTree();
    await qc.invalidateQueries({ queryKey: ['requirement', item.id] });
    if (r) close();
  };
  const saveMerge = async (item: Requirement, intoId: string, useMergedWording: boolean) => {
    setError('');
    const r = await run(() => api.mergeRequirement(item.id, { intoId, useMergedWording })) as MergeResult | undefined;
    await afterChange();
    if (!r) return;
    setOpen((s) => new Set([...s, r.requirement.id]));
    setSelected((cur) => (cur?.requirementId === item.id ? { kind: 'requirement', id: r.requirement.id, requirementId: r.requirement.id } : cur));
    setNotice(`Merged ${tagOf(item)} into ${tagOf(r.requirement)}: ${r.movedNotes} note${r.movedNotes === 1 ? '' : 's'} and ${r.movedChildren} item${r.movedChildren === 1 ? '' : 's'} moved.${r.mappingsOnMergedCode ? ` ${r.mappingsOnMergedCode} link${r.mappingsOnMergedCode === 1 ? '' : 's'} to your standards still name the old code ${item.code}; they were not changed.` : ''}`);
    close();
  };
  const saveSplit = async (item: Requirement, v: { part: string; code: string; title: string }) => {
    setError('');
    const r = await run(() => api.splitRequirement(item.id, { part: v.part, code: v.code, ...(v.title ? { title: v.title } : {}) })) as SplitResult | undefined;
    await afterChange();
    if (!r) return;
    setOpen((s) => new Set([...s, r.original.id, r.created.id]));
    setSelected({ kind: 'requirement', id: r.created.id, requirementId: r.created.id });
    setNotice(`Split ${tagOf(r.original)}: ${tagOf(r.created)} was created${r.created.quoteVerified ? '' : '. Its quote was not found on the source page, so it is marked Quote not found'}.`);
    close();
  };
  const saveMove = async (item: Requirement, parentId: string | null) => {
    setError('');
    const r = await run(() => api.moveRequirement(item.id, { parentId }));
    await invalidateTree();
    if (r) { setOpen((s) => new Set([...s, item.id])); close(); }
  };
  const nodeProps = {
    api, version, me, all, kids, collapsed, levels, editable, open, toggle, act, setError, invalidateTree, selected, onSelect: select, look, visible,
    onAddChild: (parent: Requirement) => setDialog({ kind: 'add', parent }), onEdit: (item: Requirement) => setDialog({ kind: 'edit', item }),
    onMerge: (item: Requirement) => { setError(''); setDialog({ kind: 'merge', item }); },
    onSplit: (item: Requirement) => { setError(''); setDialog({ kind: 'split', item }); },
    onMove: (item: Requirement) => { setError(''); setDialog({ kind: 'move', item }); },
    onMap: (item: Requirement) => { setError(''); setDialog({ kind: 'map', item }); },
    onLinkEvidence: (item: Requirement) => { setError(''); setDialog({ kind: 'link', item }); },
    evidence, contexts,
  };
  const shown = tops.filter((r) => !visible || visible.has(r.id));
  const flagged = items.length;
  /** The ids on screen, in order: what a range selection and the keyboard walk over. */
  const shownIds = useMemo(() => {
    const out: string[] = [];
    const walk = (r: Requirement) => {
      out.push(r.id);
      if (collapsed.has(r.id)) return;
      for (const c of kids.get(r.id) ?? []) if (!visible || visible.has(c.id)) walk(c);
    };
    for (const r of tops) if (!visible || visible.has(r.id)) walk(r);
    return out;
  }, [tops, kids, collapsed, visible]);
  const reason = !can(me, 'framework:write') ? 'You need permission to edit the library to select or move requirements.'
    : `This version is ${version.status === 'in_review' ? 'in review' : version.status} and fixed. Start a new version to select, move or delete requirements.`;

  const list = (
    <div className="space-y-2" aria-label="Requirements" role="list">
      {shown.map((r) => <div role="listitem" key={r.id} className="space-y-2"><Node {...nodeProps} r={r} /></div>)}
      {filter && shown.length === 0 && <p className="text-sm text-muted-foreground">Nothing is marked “{LOOK_LABEL[filter]}”.</p>}
    </div>
  );

  return (
    <TreeProvider api={api} version={version} rows={all} shown={shownIds} editable={editable} reason={reason} label={tagOf} noun={{ one: 'requirement', many: 'requirements' }}
      collapsed={collapsed} onCollapse={setCollapsed} onChanged={invalidateTree} onNotice={setNotice} onError={setError}>
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">{all.length} requirement{all.length === 1 ? '' : 's'}</span>
        {all.length > 0 && <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => setOpen(open.size ? new Set() : new Set(all.map((r) => r.id)))}>{open.size ? 'Collapse all' : 'Expand all'}</Button>}
        <TreeToolbar />
        {editable && <Button type="button" className="ms-auto" onClick={() => setDialog({ kind: 'add', parent: null })}>+ Requirement</Button>}
      </div>
      {!draft && <p className="text-xs text-muted-foreground">This version is {version.status === 'in_review' ? 'in review' : 'published'} and fixed. Use Start a new version to change it.</p>}
      {all.length > 0 && review.data && (
        <section aria-label="Needs a look" className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
          <span className="text-sm font-medium">Needs a look</span>
          {LOOK_KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={filter === k} disabled={counts[k] === 0 && filter !== k} title={LOOK_HINT[k]} onClick={() => setFilter(filter === k ? null : k)}
              className={`rounded-full border px-3 py-1 text-xs disabled:opacity-50 ${filter === k ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}>
              {LOOK_LABEL[k]} <span data-testid={`look-count-${k}`}>({counts[k]})</span>
            </button>
          ))}
          {filter && <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => setFilter(null)}>Show all</Button>}
          <Button type="button" variant="outline" className="ms-auto px-3 py-1" disabled={flagged === 0} aria-keyshortcuts="n" title="Shortcut: n" onClick={goNext}>Next item that needs a look</Button>
          {flagged === 0 && <span className="basis-full text-xs text-muted-foreground">Nothing needs a look: every quote was found and nothing was left unplaced.</span>}
        </section>
      )}
      {error && !dialog && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {notice && (
        <p role="status" className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-900">
          <span className="min-w-0 flex-1 break-words">{notice}</span>
          <button type="button" aria-label="Dismiss" className="shrink-0 underline" onClick={() => setNotice('')}>Dismiss</button>
        </p>
      )}
      <BulkBar rows={all} />
      {tree.data && all.length === 0 && <p className="text-sm text-muted-foreground">No requirements yet.</p>}
      <RequirementsLayout wide={wide} list={list} aside={viewer} asideLabel="Source viewer" asideTestId="source-panel" />
      {!wide && sheet && selected && (
        <BottomSheet labelledBy="source-sheet-title" onClose={() => setSheet(false)}>
          <div className="mb-3 flex items-start justify-between gap-2">
            <h2 id="source-sheet-title" className="min-w-0 pt-1 text-lg font-semibold break-words">Where this comes from</h2>
            <Button type="button" variant="ghost" aria-label="Close" onClick={() => setSheet(false)}>✕</Button>
          </div>
          {viewer}
        </BottomSheet>
      )}
      {dialog?.kind === 'add' && <RequirementDialog editing={null} parent={dialog.parent} levels={levels} rows={all} error={error} onClose={close} onSave={saveNew} />}
      {dialog?.kind === 'edit' && <RequirementDialog editing={dialog.item} parent={null} levels={levels} rows={all} error={error} onClose={close} onSave={(v) => saveEdit(dialog.item, v)} />}
      {dialog?.kind === 'merge' && <MergeDialog api={api} item={dialog.item} rows={all} error={error} onClose={close} onMerge={(into, mine) => saveMerge(dialog.item, into, mine)} />}
      {dialog?.kind === 'split' && <SplitDialog item={dialog.item} error={error} onClose={close} onSplit={(v) => saveSplit(dialog.item, v)} />}
      {dialog?.kind === 'move' && <MoveDialog item={dialog.item} rows={all} error={error} onClose={close} onMove={(parent) => saveMove(dialog.item, parent)} />}
      {dialog?.kind === 'map' && (
        <MapToIqfDialog api={api} version={version} requirement={dialog.item} onClose={close} onSaved={() => {
          setNotice(`Mapping of ${tagOf(dialog.item)} proposed. A reviewer approves it before the evidence on the IQF item counts here.`);
          return Promise.all(['mappings', 'requirement-context', 'iqf-proposals'].map((k) => qc.invalidateQueries({ queryKey: [k, version.id] })));
        }} />
      )}
      {dialog?.kind === 'link' && (
        <LinkEvidenceDialog api={evidence} title={`${tagOf(dialog.item)} · ${dialog.item.title}`} onClose={close}
          onLink={async (evidenceVersionId, rationale) => {
            const id = dialog.item.id;
            await evidence.linkLibrary(id, { evidenceVersionId, rationale });
            setOpen((s) => new Set([...s, id]));
            await qc.invalidateQueries({ queryKey: ['internal-evidence', id] });
            await qc.invalidateQueries({ queryKey: ['requirement-context', version.id] });
            await qc.invalidateQueries({ queryKey: ['evidence'] });
          }} />
      )}
    </div>
    </TreeProvider>
  );
}
