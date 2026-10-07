import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@ams/shared';
import { AccordionCard, HoverCard, Shaded, useEscape } from '../../components/accordion';
import { ContentText } from '../../components/content-text';
import { EvidenceLinkList } from '../../components/evidence-links';
import { RequestEvidenceDialog, RequestList } from '../../components/evidence-requests';
import { LinkEvidenceDialog } from '../../components/link-evidence-dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useEvidenceApi, type EvidenceApi } from '../../lib/evidence-api';
import type { FrameworkApi, Requirement, Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';

/** The next free code: 1, 2, 3 for standards; 3.1, 3.2 under standard 3. */
function nextCode(rows: Requirement[], parent: Requirement | null): string {
  const siblings = rows.filter((r) => (r.parentId ?? null) === (parent?.id ?? null)).map((r) => r.code);
  const prefix = parent ? `${parent.code}.` : '';
  let n = siblings.length + 1;
  while (siblings.includes(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/** "Standard 1.0" for a standard, "Standard 1.1" for one of its sub-standards. */
const tag = (r: Requirement) => `Standard ${!r.parentId && !r.code.includes('.') ? `${r.code}.0` : r.code}`;

/** Adds or edits a standard or a sub-standard. Where it sits follows from its code (1.2 goes under Standard 1.0). */
function ItemDialog({ editing, parent, code, error, onSave, onClose }: {
  editing: Requirement | null; parent: Requirement | null; code: string; error: string;
  onSave: (v: { code: string; title: string; description: string }) => Promise<unknown>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  useEscape(onClose);
  const what = editing ? (editing.parentId ? 'sub-standard' : 'standard') : parent ? 'sub-standard' : 'standard';
  const heading = editing ? `Edit ${tag(editing)}` : `New ${what}`;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    void onSave({ code: String(f.get('code')).trim(), title: String(f.get('title')).trim(), description: String(f.get('description')).trim() }).finally(() => setBusy(false));
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="iqf-item-title" className="w-full max-w-xl rounded-lg bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="iqf-item-title" className="text-xl font-semibold">{heading}{!editing && parent ? <span className="ms-2 text-base font-normal text-muted-foreground">under {tag(parent)}</span> : null}</h2>
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
      </div>
    </div>
  );
}

/** Shown on hover: title, description and linked evidence, without opening the card. */
function HoverDetails({ r, evidence }: { r: Requirement; evidence: EvidenceApi }) {
  const links = useQuery({ queryKey: ['internal-evidence', r.id], queryFn: () => evidence.internalLinks(r.id) });
  return (
    <HoverCard>
      <p className="font-semibold"><ContentText>{`${tag(r)} · ${r.title}`}</ContentText></p>
      <p className="mt-1 line-clamp-4 text-muted-foreground"><ContentText>{r.officialText || 'No description yet.'}</ContentText></p>
      <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Linked evidence</p>
      {links.data === undefined ? <p className="text-xs text-muted-foreground">…</p> : links.data.length === 0
        ? <p className="text-xs text-muted-foreground">None yet.</p>
        : <ul className="list-disc ps-4 text-xs">{links.data.map((l) => <li key={l.id}><ContentText>{l.evidenceTitle}</ContentText> <span className="text-muted-foreground">({l.reviewStatus})</span></li>)}</ul>}
    </HoverCard>
  );
}

interface ItemProps {
  api: FrameworkApi; evidence: EvidenceApi; r: Requirement; all: Requirement[]; me: Me | undefined; editable: boolean;
  open: Set<string>; toggle: (id: string) => void; act: (fn: () => Promise<unknown>) => Promise<unknown>;
  onAddChild: (parent: Requirement) => void; onEdit: (r: Requirement) => void; onLink: (r: Requirement) => void; onRequest: (r: Requirement) => void;
}

/** One standard or sub-standard as a full-width accordion card: opening it shows its description and linked evidence. */
function Item(p: ItemProps) {
  const { api, evidence, r, all, me, editable, open, toggle, act } = p;
  const qc = useQueryClient();
  const isOpen = open.has(r.id);
  const children = all.filter((x) => x.parentId === r.id);
  const links = useQuery({ queryKey: ['internal-evidence', r.id], queryFn: () => evidence.internalLinks(r.id), enabled: isOpen });
  const requests = useQuery({ queryKey: ['internal-requests', r.id], queryFn: () => evidence.internalRequests(r.id), enabled: isOpen });
  const [linkError, setLinkError] = useState('');
  const menu = [
    ...(can(me, 'evidence:write') ? [{ label: 'Link evidence', onSelect: () => p.onLink(r) }, { label: 'Request evidence', onSelect: () => p.onRequest(r) }] : []),
    ...(editable && !r.parentId ? [{ label: 'Add sub-standard', onSelect: () => p.onAddChild(r) }] : []),
    ...(editable ? [{ label: 'Edit', onSelect: () => p.onEdit(r) }] : []),
    ...(editable ? [{ label: 'Delete', onSelect: () => { if (window.confirm(`Delete ${tag(r)} · ${r.title}?`)) void act(() => api.deleteRequirement(r.id)); } }] : []),
  ];
  return (
    <AccordionCard label={tag(r)} tag={tag(r)} title={r.title} strong={!r.parentId} tone={r.parentId ? 'plain' : 'shaded'} testId={r.parentId ? 'iqf-substandard' : 'iqf-standard'}
      open={isOpen} onToggle={() => toggle(r.id)} menuLabel={`Actions for ${tag(r)}`} menu={menu}
      meta={!r.parentId && children.length > 0 ? <span className="text-xs text-muted-foreground">{children.length} sub-standard{children.length === 1 ? '' : 's'}</span> : undefined}
      hover={<HoverDetails r={r} evidence={evidence} />}>
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
 * description and its evidence; sub-standards are listed under their standard, indented. A card's ⋯ menu links or requests
 * evidence, adds a sub-standard, edits or deletes it.
 */
export function IqfRequirements({ api, version, me, evidence: evidenceOverride }: { api: FrameworkApi; version: Version; me: Me | undefined; evidence?: EvidenceApi }) {
  const evidence = useEvidenceApi(evidenceOverride);
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ kind: 'add'; parent: Requirement | null } | { kind: 'edit'; item: Requirement } | { kind: 'link'; item: Requirement } | { kind: 'request'; item: Requirement } | null>(null);
  const rows = useQuery({ queryKey: ['requirements', version.id], queryFn: () => api.requirements(version.id) });
  const run = useAction(setError);
  const act = (fn: () => Promise<unknown>) => { setError(''); return run(fn).then(() => qc.invalidateQueries({ queryKey: ['requirements', version.id] })); };
  const editable = version.status === 'draft' && can(me, 'framework:write');
  const all = rows.data ?? [];
  const standards = all.filter((r) => !r.parentId);
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const close = () => { setDialog(null); setError(''); };
  const itemProps = {
    api, evidence, all, me, editable, open, toggle, act,
    onAddChild: (parent: Requirement) => setDialog({ kind: 'add', parent }),
    onEdit: (item: Requirement) => setDialog({ kind: 'edit', item }),
    onLink: (item: Requirement) => setDialog({ kind: 'link', item }),
    onRequest: (item: Requirement) => setDialog({ kind: 'request', item }),
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

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{standards.length} standard{standards.length === 1 ? '' : 's'}</span>
        {standards.length > 0 && <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => setOpen(open.size ? new Set() : new Set(all.map((r) => r.id)))}>{open.size ? 'Collapse all' : 'Expand all'}</Button>}
        {editable && <Button type="button" className="ms-auto" onClick={() => setDialog({ kind: 'add', parent: null })}>+ Standard</Button>}
      </div>
      {error && !dialog && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {rows.data && standards.length === 0 && <p className="text-sm text-muted-foreground">No standards yet.</p>}
      <div className="space-y-2" aria-label="Standards" role="list">
        {standards.map((s) => (
          <div role="listitem" key={s.id} className="space-y-2">
            <Item {...itemProps} r={s} />
            {all.some((c) => c.parentId === s.id) && (
              <div role="list" aria-label={`Sub-standards of ${tag(s)}`} className="ms-8 space-y-2 border-s-2 border-border ps-3">
                {all.filter((c) => c.parentId === s.id).map((c) => <div role="listitem" key={c.id}><Item {...itemProps} r={c} /></div>)}
              </div>
            )}
          </div>
        ))}
      </div>
      {dialog?.kind === 'add' && (
        <ItemDialog editing={null} parent={dialog.parent} code={nextCode(all, dialog.parent)} error={error} onClose={close}
          onSave={({ code, title, description }) => saveItem(() => api.addQualityItem(version.id, { code, title, ...(description ? { description } : {}) }))} />
      )}
      {dialog?.kind === 'edit' && (
        <ItemDialog editing={dialog.item} parent={null} code={dialog.item.code} error={error} onClose={close}
          onSave={({ code, title, description }) => saveItem(() => api.editQualityItem(dialog.item.id, { code, title, description }))} />
      )}
      {dialog?.kind === 'request' && (
        <RequestEvidenceDialog api={evidence} title={`${tag(dialog.item)} · ${dialog.item.title}`} requirementId={dialog.item.id} onClose={close}
          onDone={() => {
            const id = dialog.item.id;
            setOpen((s) => new Set([...s, id]));
            void qc.invalidateQueries({ queryKey: ['internal-requests', id] });
            void qc.invalidateQueries({ queryKey: ['evidence-requests'] });
          }} />
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
    </div>
  );
}
