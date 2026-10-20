import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@ams/shared';
import { AccordionCard, HoverCard, Shaded } from '../../components/accordion';
import { ContentText } from '../../components/content-text';
import { BulkBar, RowGutter, TreeProvider, TreeRow, TreeToolbar, useRowFocus } from '../../components/tree/tree';
import { EvidenceLinkList } from '../../components/evidence-links';
import { RequestList } from '../../components/evidence-requests';
import { LinkEvidenceDialog } from '../../components/link-evidence-dialog';
import { AssignmentLines } from '../../components/standard-ops/assignment-summary';
import { useStandardOps, type MenuItem, type OpsApis } from '../../components/standard-ops/use-standard-ops';
import { RequirementsLayout } from '../../components/requirements-layout';
import { useConfirm } from '../../components/confirm-dialog';
import { useRequirementContexts } from '../version/requirement-hover';
import { Dialog } from '../../components/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import type { NodeAssignment } from '@ams/shared';
import { useEvidenceApi, type EvidenceApi } from '../../lib/evidence-api';
import type { FrameworkApi, Requirement, Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';
import { confirmAndDelete } from '../../lib/delete-requirements';

/** The next free code: 1, 2, 3 for standards; 3.1, 3.2 under standard 3. */
function nextCode(rows: Requirement[], parent: Requirement | null): string {
  const siblings = rows.filter((r) => (r.parentId ?? null) === (parent?.id ?? null)).map((r) => r.code);
  const prefix = parent ? `${parent.code}.` : '';
  let n = siblings.length + 1;
  while (siblings.includes(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/** "Standard 1.0" for a standard, "Standard 1.1" for one of its sub-standards. */
export const tag = (r: Requirement) => `Standard ${!r.parentId && !r.code.includes('.') ? `${r.code}.0` : r.code}`;

/** Adds or edits a standard or a sub-standard. Where it sits follows from its code (1.2 goes under Standard 1.0). */
function ItemDialog({ editing, parent, code, error, onSave, onClose }: {
  editing: Requirement | null; parent: Requirement | null; code: string; error: string;
  onSave: (v: { code: string; title: string; description: string }) => Promise<unknown>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const what = editing ? (editing.parentId ? 'sub-standard' : 'standard') : parent ? 'sub-standard' : 'standard';
  const heading = editing ? `Edit ${tag(editing)}` : `New ${what}`;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    void onSave({ code: String(f.get('code')).trim(), title: String(f.get('title')).trim(), description: String(f.get('description')).trim() }).finally(() => setBusy(false));
  };
  return (
    <Dialog labelledBy="iqf-item-title" onClose={onClose}>
      <div className="mb-4 flex items-start justify-between gap-2">
        <h2 id="iqf-item-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">{heading}{!editing && parent ? <span className="ms-2 text-base font-normal text-muted-foreground">under {tag(parent)}</span> : null}</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <form onSubmit={submit} className="space-y-3" aria-label={heading}>
        <div className="flex gap-2">
          <label className="flex w-24 flex-col text-sm">Code<Input name="code" aria-label="Code" defaultValue={editing?.code ?? code} required /></label>
          <label className="flex flex-1 flex-col text-sm">Title<Input name="title" aria-label="Title" defaultValue={editing?.title ?? ''} required autoFocus dir="auto" /></label>
        </div>
        <label className="flex flex-col text-sm">Description
          <textarea name="description" aria-label="Description" rows={5} dir="auto" defaultValue={editing?.officialText ?? ''} className="rounded-md border border-border p-2 text-sm" placeholder={`What this ${what} expects`} />
        </label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <p className="text-xs text-muted-foreground">The code places it: 1 is a standard, 1.2 is a sub-standard of Standard 1.0. Changes are saved to the draft version and take effect when it is published.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{editing ? 'Save' : 'Save as draft'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Shown on hover: title, description, linked evidence, scope and champion (with where they come from), without opening the card. */
function HoverDetails({ r, evidence, assignment }: { r: Requirement; evidence: EvidenceApi; assignment: NodeAssignment | undefined }) {
  const links = useQuery({ queryKey: ['internal-evidence', r.id], queryFn: () => evidence.internalLinks(r.id) });
  return (
    <HoverCard>
      <p className="font-semibold"><ContentText>{`${tag(r)} · ${r.title}`}</ContentText></p>
      <p className="mt-1 line-clamp-4 text-muted-foreground"><ContentText>{r.officialText || 'No description yet.'}</ContentText></p>
      <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Linked evidence</p>
      {links.data === undefined ? <p className="text-xs text-muted-foreground">…</p> : links.data.length === 0
        ? <p className="text-xs text-muted-foreground">None yet.</p>
        : <ul className="list-disc ps-4 text-xs">{links.data.map((l) => <li key={l.id}><ContentText>{l.evidenceTitle}</ContentText> <span className="text-muted-foreground">({l.reviewStatus})</span></li>)}</ul>}
      <AssignmentLines assignment={assignment} internal />
    </HoverCard>
  );
}

interface ItemProps {
  api: FrameworkApi; evidence: EvidenceApi; r: Requirement; all: Requirement[]; me: Me | undefined; editable: boolean;
  open: Set<string>; toggle: (id: string) => void; act: (fn: () => Promise<unknown>) => Promise<unknown>;
  onAddChild: (parent: Requirement) => void; onEdit: (r: Requirement) => void; onLink: (r: Requirement) => void;
  /** Assign scope, Assign champion (those the person may use), and what this item's hover card shows of them. */
  opsItems: (r: Requirement) => MenuItem[]; assignment: NodeAssignment | undefined;
}

/** One standard or sub-standard as a full-width accordion card: opening it shows its description and linked evidence. */
function Item(p: ItemProps) {
  const { api, evidence, r, all, me, editable, open, toggle, act } = p;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const isOpen = open.has(r.id);
  const children = all.filter((x) => x.parentId === r.id);
  const focus = useRowFocus(r.id);
  const links = useQuery({ queryKey: ['internal-evidence', r.id], queryFn: () => evidence.internalLinks(r.id), enabled: isOpen });
  const requests = useQuery({ queryKey: ['internal-requests', r.id], queryFn: () => evidence.internalRequests(r.id), enabled: isOpen });
  const [linkError, setLinkError] = useState('');
  // Link evidence · Assign scope · Assign champion, then the authoring items.
  const menu = [
    ...(can(me, 'evidence:write') ? [{ label: 'Link evidence', onSelect: () => p.onLink(r) }] : []),
    ...p.opsItems(r),
    ...(editable && !r.parentId ? [{ label: 'Add sub-standard', onSelect: () => p.onAddChild(r) }] : []),
    ...(editable ? [{ label: 'Edit', onSelect: () => p.onEdit(r) }] : []),
    ...(editable ? [{ label: 'Delete', onSelect: () => void act(() => confirmAndDelete(api, confirm, [r.id], `Delete ${tag(r)}?`)) }] : []),
  ];
  return (
    <AccordionCard label={tag(r)} tag={tag(r)} title={r.title} strong={!r.parentId} tone={r.parentId ? 'plain' : 'shaded'} testId={r.parentId ? 'iqf-substandard' : 'iqf-standard'}
      gutter={<RowGutter id={r.id} />} toggleProps={focus}
      open={isOpen} onToggle={() => toggle(r.id)} menuLabel={`Actions for ${tag(r)}`} menu={menu}
      meta={children.length > 0 ? <span className="text-xs text-muted-foreground">{children.length} {r.parentId ? 'item' : 'sub-standard'}{children.length === 1 ? '' : 's'}</span> : undefined}
      hover={<HoverDetails r={r} evidence={evidence} assignment={p.assignment} />}>
      <div className="space-y-1">
        <Shaded>Description</Shaded>
        {r.officialText ? <p className="whitespace-pre-line text-sm"><ContentText>{r.officialText}</ContentText></p> : <p className="text-sm text-muted-foreground">No description yet.</p>}
      </div>
      <div className="space-y-1">
        <Shaded>Linked evidence</Shaded>
        {linkError && <p role="alert" className="text-sm text-red-700">{linkError}</p>}
        <EvidenceLinkList links={links.data ?? []} api={evidence} canReview={can(me, 'evidence:review')} canRemove={can(me, 'evidence:write')}
          onChange={() => void qc.invalidateQueries({ queryKey: ['internal-evidence', r.id] })} setError={setLinkError} />
      </div>
      {(requests.data?.length ?? 0) > 0 && (
        <div className="space-y-1">
          <Shaded>Requests</Shaded>
          <RequestList requests={requests.data ?? []} api={evidence} canManage={can(me, 'evidence:write')} setError={setLinkError}
            onChange={() => void qc.invalidateQueries({ queryKey: ['internal-requests', r.id] })} />
        </div>
      )}
    </AccordionCard>
  );
}

/**
 * The internal framework's requirements: standards and their sub-standards as full-width accordions, each with a
 * description and its evidence; sub-standards are listed under their standard, indented. A card's ⋯ menu is Link evidence,
 * Assign scope, Assign champion (TASK-086), then adds a sub-standard, edits or deletes it. Evidence is requested
 * through an evidence item's own cycle (Evidence page), so the menu has no "Request evidence". `operational` is the Quality Management view: the same menu and cards,
 * without the authoring (edit, add, delete, move), which stays in Settings -> Internal Quality Framework.
 */
export function IqfRequirements({ api, version, me, evidence: evidenceOverride, operational = false, apis }: {
  api: FrameworkApi; version: Version; me: Me | undefined; evidence?: EvidenceApi; operational?: boolean; apis?: OpsApis;
}) {
  const evidence = useEvidenceApi(evidenceOverride);
  const contexts = useRequirementContexts(evidence, version.id);
  const assignmentOf = useCallback((code: string): NodeAssignment | undefined => {
    const c = contexts.data?.byCode[code];
    return c?.scope && c.champion ? { scope: c.scope, champion: c.champion } : undefined;
  }, [contexts.data]);
  const ops = useStandardOps({ me, version, assignmentOf, tagOf: tag, ...(apis ? { apis } : {}) });
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsedSet] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<{ kind: 'add'; parent: Requirement | null } | { kind: 'edit'; item: Requirement } | { kind: 'link'; item: Requirement } | null>(null);
  const rowsQuery = useQuery({ queryKey: ['requirements', version.id], queryFn: () => api.requirements(version.id) });
  const run = useAction(setError);
  const act = (fn: () => Promise<unknown>) => { setError(''); return run(fn).then(() => qc.invalidateQueries({ queryKey: ['requirements', version.id] })); };
  const can_ = can(me, 'framework:write');
  const editable = !operational && version.status === 'draft' && can_;
  const all = useMemo(() => rowsQuery.data ?? [], [rowsQuery.data]);
  const standards = all.filter((r) => !r.parentId);
  // Rows on screen: everything except what sits under a collapsed branch.
  const shown = useMemo(() => {
    const hidden = new Set<string>();
    const out: string[] = [];
    for (const r of all) {
      if (r.parentId && (collapsed.has(r.parentId) || hidden.has(r.parentId))) { hidden.add(r.id); continue; }
      out.push(r.id);
    }
    return out;
  }, [all, collapsed]);
  const setCollapsed = useCallback((id: string, c: boolean) => setCollapsedSet((s) => { const n = new Set(s); if (c) n.add(id); else n.delete(id); return n; }), []);
  const reason = !can_ ? 'You need permission to edit the framework to select or move standards.'
    : `This version is ${version.status === 'in_review' ? 'in review' : version.status} and fixed. Start a new version to select, move or delete standards.`;
  const toggle = (id: string) => {
    setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const close = () => { setDialog(null); setError(''); };
  const itemProps = {
    api, evidence, all, me, editable, open, toggle, act,
    onAddChild: (parent: Requirement) => setDialog({ kind: 'add', parent }),
    onEdit: (item: Requirement) => setDialog({ kind: 'edit', item }),
    onLink: (item: Requirement) => setDialog({ kind: 'link', item }),
    opsItems: ops.items,
  };
  /** Saves through the API; on success opens what was saved (and its standard) and closes the dialog. */
  const saveItem = async (save: () => Promise<Requirement>) => {
    setError('');
    const r = await run(save);
    await qc.invalidateQueries({ queryKey: ['requirements', version.id] });
    if (!r) return;
    const parentId = r.parentId;
    setOpen((s) => new Set([...s, ...(parentId ? [parentId] : []), r.id]));
    close();
  };
  const branch = (parent: string | null): React.ReactNode => all.filter((r) => (r.parentId ?? null) === parent).map((r) => {
    const kids = all.some((c) => c.parentId === r.id) && !collapsed.has(r.id);
    return (
      <div role="listitem" key={r.id} className="space-y-2">
        <TreeRow id={r.id}><Item {...itemProps} r={r} assignment={assignmentOf(r.code)} /></TreeRow>
        {kids && (
          <div role="list" aria-label={`Sub-standards of ${tag(r)}`} className="ms-8 space-y-2 border-s-2 border-border ps-3">{branch(r.id)}</div>
        )}
      </div>
    );
  });

  return (
    <TreeProvider api={api} version={version} rows={all} shown={shown} editable={editable} reason={reason} label={tag} collapsed={collapsed} onCollapse={setCollapsed}
      onNotice={(t) => { setNotice(t); }} onError={setError}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{standards.length} standard{standards.length === 1 ? '' : 's'}</span>
          {standards.length > 0 && <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => setOpen(open.size ? new Set() : new Set(all.map((r) => r.id)))}>{open.size ? 'Collapse all' : 'Expand all'}</Button>}
          {!operational && <TreeToolbar />}
          {editable && <Button type="button" className="ms-auto" onClick={() => setDialog({ kind: 'add', parent: null })}>+ Standard</Button>}
        </div>
        {!operational && !editable && standards.length > 0 && version.status !== 'draft' && <p className="text-xs text-muted-foreground">{reason}</p>}
        {!operational && <BulkBar rows={all} />}
        {error && !dialog && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {notice && (
          <p className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-900" data-testid="tree-notice">
            <span className="min-w-0 flex-1 break-words">{notice}</span>
            <button type="button" aria-label="Dismiss" className="shrink-0 underline" onClick={() => setNotice('')}>Dismiss</button>
          </p>
        )}
        {rowsQuery.data && standards.length === 0 && <p className="text-sm text-muted-foreground">No standards yet.</p>}
        <RequirementsLayout list={<div className="space-y-2" aria-label="Standards" role="list">{branch(null)}</div>} />
      </div>
      {dialog?.kind === 'add' && (
        <ItemDialog editing={null} parent={dialog.parent} code={nextCode(all, dialog.parent)} error={error} onClose={close}
          onSave={({ code, title, description }) => saveItem(() => api.addQualityItem(version.id, { code, title, ...(description ? { description } : {}) }))} />
      )}
      {dialog?.kind === 'edit' && (
        <ItemDialog editing={dialog.item} parent={null} code={dialog.item.code} error={error} onClose={close}
          onSave={({ code, title, description }) => saveItem(() => api.editQualityItem(dialog.item.id, { code, title, description }))} />
      )}
      {dialog?.kind === 'link' && (
        <LinkEvidenceDialog api={evidence} title={`${tag(dialog.item)} · ${dialog.item.title}`} onClose={close}
          onLink={async (evidenceVersionId, rationale) => {
            const id = dialog.item.id;
            await evidence.linkInternal(id, { evidenceVersionId, rationale });
            setOpen((s) => new Set([...s, id]));
            await qc.invalidateQueries({ queryKey: ['internal-evidence', id] });
            await qc.invalidateQueries({ queryKey: ['evidence'] });
          }} />
      )}
      {ops.dialogs}
    </TreeProvider>
  );
}
