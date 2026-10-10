import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@ams/shared';
import { AccordionCard, HoverCard, Shaded } from '../../components/accordion';
import { AiMarker, QuoteNotFoundBadge } from '../../components/badges';
import { ContentText } from '../../components/content-text';
import { Dialog } from '../../components/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { distinctTitle } from '../../lib/format';
import type { FrameworkApi, Requirement, Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';
import { AddNote, NotePanel } from './requirements-tab';

/** The shaded tag: the code, with the level in front when the code alone is only a number ("Criterion 3", "Item 3(1)"). */
const tagOf = (r: Requirement) => (/[\p{L}]/u.test(r.code) ? r.code : `${r.levelLabel} ${r.code}`);
/** What follows the tag: the title, unless it only repeats the code. */
const titleOf = (r: Requirement) => distinctTitle(r.code, r.title);
const nameOf = (r: Requirement) => [tagOf(r), titleOf(r)].filter(Boolean).join(' · ');

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
  editable: boolean; open: Set<string>; toggle: (id: string) => void; act: (fn: () => Promise<unknown>) => Promise<unknown>;
  onAddChild: (r: Requirement) => void; onEdit: (r: Requirement) => void; setError: (m: string) => void; invalidateTree: () => Promise<unknown>;
}

/** One requirement as a card; its children follow indented below it. */
function Node(p: NodeProps) {
  const { api, version, r, all, levels, editable, open, toggle, act } = p;
  const qc = useQueryClient();
  const isOpen = open.has(r.id);
  const children = all.filter((x) => x.parentId === r.id);
  const top = !r.parentId;
  const detail = useQuery({ queryKey: ['requirement', r.id], queryFn: () => api.requirement(r.id), enabled: isOpen });
  const docs = useQuery({ queryKey: ['documents', version.id], queryFn: () => api.documents(version.id), enabled: isOpen && editable });
  const invalidate = async () => { await qc.invalidateQueries({ queryKey: ['requirement', r.id] }); await p.invalidateTree(); };
  const childLevel = levels[Math.min((r.depth ?? 0) + 1, levels.length - 1)];
  const menu = [
    ...(editable ? [{ label: childLevel ? `Add ${childLevel.toLowerCase()}` : 'Add item', onSelect: () => p.onAddChild(r) }, { label: 'Edit', onSelect: () => p.onEdit(r) }] : []),
    ...(editable ? [{ label: 'Delete', onSelect: () => { if (window.confirm(`Delete ${nameOf(r)}?`)) void act(() => api.deleteRequirement(r.id)); } }] : []),
  ];
  return (
    <>
      <AccordionCard label={tagOf(r)} tag={tagOf(r)} title={titleOf(r)} strong={top} tone={top ? 'shaded' : 'plain'} testId="requirement-card" domId={`requirement-${r.id}`}
        open={isOpen} onToggle={() => toggle(r.id)} menuLabel={`Actions for ${tagOf(r)}`} menu={menu}
        meta={<span className="flex items-center gap-2">
          {children.length > 0 && <span className="text-xs text-muted-foreground">{children.length} {children.length === 1 ? 'item' : 'items'}</span>}
          <span className="text-xs text-muted-foreground">{r.levelLabel}</span>
          {r.origin === 'ai' && <AiMarker />}
          {r.origin === 'ai' && r.sourceQuote && !r.quoteVerified && <QuoteNotFoundBadge />}
        </span>}
        hover={(
          <HoverCard>
            <p className="font-semibold"><ContentText>{nameOf(r)}</ContentText></p>
            <p className="mt-1 line-clamp-4 text-muted-foreground"><ContentText>{r.officialText || 'No description.'}</ContentText></p>
          </HoverCard>
        )}>
        <div className="space-y-1" data-testid="requirement-detail">
          <Shaded>Description</Shaded>
          {r.officialText ? <p className="whitespace-pre-line text-sm"><ContentText>{r.officialText}</ContentText></p> : <p className="text-sm text-muted-foreground">No description.</p>}
          {!r.isAssessable && <p className="text-xs text-muted-foreground">A heading only; it is not assessed itself.</p>}
          {r.sourceQuote && (
            <blockquote className="mt-1 border-s-2 border-border ps-2 text-xs text-muted-foreground" data-testid="requirement-source">
              <ContentText>{r.sourceQuote}</ContentText> <span>(page {r.sourcePage})</span>
            </blockquote>
          )}
        </div>
        <div className="space-y-1">
          <Shaded>Notes</Shaded>
          <ul className="space-y-2">
            {(detail.data?.notes ?? []).map((n) => <NotePanel key={n.id} api={api} note={n} editable={editable} canReview={false} perLineReview={false} invalidate={invalidate} setError={p.setError} />)}
            {detail.data?.notes.length === 0 && <li className="text-sm text-muted-foreground">No notes.</li>}
          </ul>
          {editable && <AddNote api={api} requirementId={r.id} docs={docs.data ?? []} invalidate={invalidate} setError={p.setError} />}
        </div>
      </AccordionCard>
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
 * tag, items indented under their parent, a ⋯ menu to add, edit or delete (while the version is a draft), and
 * "+ Requirement" opening a dialog. Lines are not approved one by one: publishing the version is the review (DEC-022), so
 * the cards show provenance (AI, source page and quote, a quote not found) but no review status. Notes (guidance, expectations) sit inside each card. Evidence is not linked here:
 * it is linked once to the internal standards these map onto.
 */
export function ExternalRequirements({ api, version, me, focusId }: { api: FrameworkApi; version: Version; me: Me | undefined; /** A card to open and scroll to (a gap's link). */ focusId?: string | null }) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ kind: 'add'; parent: Requirement | null } | { kind: 'edit'; item: Requirement } | null>(null);
  const tree = useQuery({ queryKey: ['requirements', version.id], queryFn: () => api.requirements(version.id) });
  const invalidateTree = () => qc.invalidateQueries({ queryKey: ['requirements', version.id] });
  const run = useAction(setError);
  const act = (fn: () => Promise<unknown>) => { setError(''); return run(fn).then(invalidateTree); };
  const draft = version.status === 'draft';
  const editable = draft && can(me, 'framework:write');
  const all = tree.data ?? [];
  const tops = all.filter((r) => !r.parentId);
  const levels = (version.levelLabels as string[] | undefined) ?? [];
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const close = () => { setDialog(null); setError(''); };
  const loaded = !!tree.data;
  useEffect(() => {
    if (!focusId || !loaded) return;
    setOpen((s) => new Set([...s, focusId]));
    const el = document.getElementById(`requirement-${focusId}`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focusId, loaded]);

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
  const nodeProps = {
    api, version, me, all, levels, editable, open, toggle, act, setError, invalidateTree,
    onAddChild: (parent: Requirement) => setDialog({ kind: 'add', parent }), onEdit: (item: Requirement) => setDialog({ kind: 'edit', item }),
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{all.length} requirement{all.length === 1 ? '' : 's'}</span>
        {all.length > 0 && <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => setOpen(open.size ? new Set() : new Set(all.map((r) => r.id)))}>{open.size ? 'Collapse all' : 'Expand all'}</Button>}
        {editable && <Button type="button" className="ms-auto" onClick={() => setDialog({ kind: 'add', parent: null })}>+ Requirement</Button>}
      </div>
      {!draft && <p className="text-xs text-muted-foreground">This version is {version.status === 'in_review' ? 'in review' : 'published'} and fixed. Use Start a new version to change it.</p>}
      {error && !dialog && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {tree.data && all.length === 0 && <p className="text-sm text-muted-foreground">No requirements yet.</p>}
      <div className="space-y-2" aria-label="Requirements" role="list">
        {tops.map((r) => <div role="listitem" key={r.id} className="space-y-2"><Node {...nodeProps} r={r} /></div>)}
      </div>
      {dialog?.kind === 'add' && <RequirementDialog editing={null} parent={dialog.parent} levels={levels} rows={all} error={error} onClose={close} onSave={saveNew} />}
      {dialog?.kind === 'edit' && <RequirementDialog editing={dialog.item} parent={null} levels={levels} rows={all} error={error} onClose={close} onSave={(v) => saveEdit(dialog.item, v)} />}
    </div>
  );
}
