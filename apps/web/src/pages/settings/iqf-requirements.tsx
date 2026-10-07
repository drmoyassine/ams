import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@ams/shared';
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
const Shaded = ({ children }: { children: string }) => <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{children}</span>;

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

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

/** The ⋯ menu of an accordion card. */
function ActionsMenu({ label, items }: { label: string; items: { label: string; onSelect: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', key); };
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
        className="rounded px-2 py-1 text-lg leading-none text-muted-foreground hover:bg-muted">⋯</button>
      {open && (
        <div role="menu" aria-label={label} className="absolute end-0 z-20 mt-1 min-w-44 rounded-md border border-border bg-background py-1 shadow-lg">
          {items.map((i) => (
            <button key={i.label} type="button" role="menuitem" className="block w-full px-3 py-1.5 text-start text-sm hover:bg-muted" onClick={() => { setOpen(false); i.onSelect(); }}>{i.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shown on hover: title, description and linked evidence, without opening the card. */
function HoverDetails({ r, evidence }: { r: Requirement; evidence: EvidenceApi }) {
  const links = useQuery({ queryKey: ['internal-evidence', r.id], queryFn: () => evidence.internalLinks(r.id) });
  return (
    <div role="tooltip" className="pointer-events-none absolute start-4 top-full z-30 mt-1 w-[min(32rem,90vw)] rounded-md border border-border bg-background p-3 text-sm shadow-lg">
      <p className="font-semibold"><ContentText>{`${tag(r)} · ${r.title}`}</ContentText></p>
      <p className="mt-1 line-clamp-4 text-muted-foreground"><ContentText>{r.officialText || 'No description yet.'}</ContentText></p>
      <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Linked evidence</p>
      {links.data === undefined ? <p className="text-xs text-muted-foreground">…</p> : links.data.length === 0
        ? <p className="text-xs text-muted-foreground">None yet.</p>
        : <ul className="list-disc ps-4 text-xs">{links.data.map((l) => <li key={l.id}><ContentText>{l.evidenceTitle}</ContentText> <span className="text-muted-foreground">({l.reviewStatus})</span></li>)}</ul>}
    </div>
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
  const [hover, setHover] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
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
    <section aria-label={tag(r)} className={`rounded-lg border border-border ${r.parentId ? 'bg-background' : 'bg-muted/30'}`} data-testid={r.parentId ? 'iqf-substandard' : 'iqf-standard'}>
      <div className="relative flex items-center gap-2 pe-2"
        onMouseEnter={() => { timer.current = setTimeout(() => setHover(true), 400); }}
        onMouseLeave={() => { clearTimeout(timer.current); setHover(false); }}>
        <button type="button" aria-expanded={isOpen} onClick={() => toggle(r.id)} className="flex flex-1 items-center gap-3 px-4 py-3 text-start">
          <Shaded>{tag(r)}</Shaded>
          <span className={`flex-1 ${r.parentId ? '' : 'font-semibold'}`}><ContentText>{r.title}</ContentText></span>
          {!r.parentId && children.length > 0 && <span className="text-xs text-muted-foreground">{children.length} sub-standard{children.length === 1 ? '' : 's'}</span>}
          <span aria-hidden="true" className={`text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`}>›</span>
        </button>
        <ActionsMenu label={`Actions for ${tag(r)}`} items={menu} />
        {hover && !isOpen && <HoverDetails r={r} evidence={evidence} />}
      </div>
      {isOpen && (
        <div className="space-y-4 border-t border-border px-4 py-4">
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
        </div>
      )}
    </section>
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
