import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import type { EvidenceApi } from '../../lib/evidence-api';
import type { FrameworkApi, Requirement, Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';
import { InternalEvidence } from '../version/requirements-tab';

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

/** Adds a standard or a sub-standard to the draft. */
function ItemDialog({ parent, code, onSave, onClose }: {
  parent: Requirement | null; code: string; onSave: (v: { code: string; title: string; description: string }) => Promise<unknown>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const what = parent ? 'sub-standard' : 'standard';
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
          <h2 id="iqf-item-title" className="text-xl font-semibold">New {what}{parent ? <span className="ms-2 text-base font-normal text-muted-foreground">under {tag(parent)}</span> : null}</h2>
          <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
        </div>
        <form onSubmit={submit} className="space-y-3" aria-label={`New ${what}`}>
          <div className="flex gap-2">
            <label className="flex w-24 flex-col text-sm">Code<Input name="code" aria-label="Code" defaultValue={code} required /></label>
            <label className="flex flex-1 flex-col text-sm">Title<Input name="title" aria-label="Title" required autoFocus dir="auto" /></label>
          </div>
          <label className="flex flex-col text-sm">Description
            <textarea name="description" aria-label="Description" rows={5} dir="auto" className="rounded-md border border-border p-2 text-sm" placeholder={`What this ${what} expects`} />
          </label>
          <p className="text-xs text-muted-foreground">It is saved to the draft version and takes effect when the version is published.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>Save as draft</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** One standard or sub-standard as a full-width accordion: its description, its evidence and, for a standard, its sub-standards. */
function Item({ api, r, all, editable, open, toggle, me, evidence, act, onAddChild }: {
  api: FrameworkApi; r: Requirement; all: Requirement[]; editable: boolean; open: Set<string>; toggle: (id: string) => void; me: Me | undefined;
  evidence?: EvidenceApi; act: (fn: () => Promise<unknown>) => Promise<unknown>; onAddChild: (parent: Requirement) => void;
}) {
  const [editing, setEditing] = useState(false);
  const isOpen = open.has(r.id);
  const children = all.filter((x) => x.parentId === r.id);
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void act(() => api.patchRequirement(r.id, { code: String(f.get('code')).trim(), title: String(f.get('title')).trim(), officialText: String(f.get('description')) })).then(() => setEditing(false));
  };
  return (
    <section aria-label={tag(r)} className={`rounded-lg border border-border ${r.parentId ? 'bg-background' : 'bg-muted/30'}`} data-testid={r.parentId ? 'iqf-substandard' : 'iqf-standard'}>
      <button type="button" aria-expanded={isOpen} onClick={() => toggle(r.id)} className="flex w-full items-center gap-3 px-4 py-3 text-start">
        <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{tag(r)}</span>
        <span className={`flex-1 ${r.parentId ? '' : 'font-semibold'}`}><ContentText>{r.title}</ContentText></span>
        {!r.parentId && children.length > 0 && <span className="text-xs text-muted-foreground">{children.length} sub-standard{children.length === 1 ? '' : 's'}</span>}
        <span aria-hidden="true" className={`text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`}>›</span>
      </button>
      {isOpen && (
        <div className="space-y-4 border-t border-border px-4 py-4">
          {editing ? (
            <form onSubmit={save} className="space-y-2" aria-label={`Edit ${tag(r)}`}>
              <div className="flex gap-2">
                <label className="flex w-24 flex-col text-sm">Code<Input name="code" aria-label="Code" defaultValue={r.code} /></label>
                <label className="flex flex-1 flex-col text-sm">Title<Input name="title" aria-label="Title" defaultValue={r.title} dir="auto" /></label>
              </div>
              <label className="flex flex-col text-sm">Description
                <textarea name="description" aria-label="Description" rows={4} dir="auto" defaultValue={r.officialText ?? ''} className="rounded-md border border-border p-2 text-sm" />
              </label>
              <div className="flex gap-2"><Button type="submit">Save</Button><Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
            </form>
          ) : (
            <div className="space-y-2">
              {r.officialText ? <p className="whitespace-pre-line text-sm"><ContentText>{r.officialText}</ContentText></p> : <p className="text-sm text-muted-foreground">No description yet.</p>}
              {editable && (
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => setEditing(true)}>Edit</Button>
                  <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => void act(() => api.deleteRequirement(r.id))}>Delete</Button>
                </div>
              )}
            </div>
          )}
          <InternalEvidence requirementId={r.id} me={me} {...(evidence ? { evidence } : {})} />
          {!r.parentId && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <h4 className="font-medium">Sub-standards</h4>
                {editable && <Button type="button" variant="ghost" className="ms-auto px-2 py-1" onClick={() => onAddChild(r)}>+ Sub-standard</Button>}
              </div>
              {children.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
              {children.map((c) => <Item key={c.id} api={api} r={c} all={all} editable={editable} open={open} toggle={toggle} me={me} act={act} onAddChild={onAddChild} {...(evidence ? { evidence } : {})} />)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The internal framework's requirements: standards and their sub-standards as full-width accordions, each with a
 * description and its evidence. New ones are added in a dialog and saved to the draft version.
 */
export function IqfRequirements({ api, version, me, evidence }: { api: FrameworkApi; version: Version; me: Me | undefined; evidence?: EvidenceApi }) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<{ parent: Requirement | null } | null>(null);
  const rows = useQuery({ queryKey: ['requirements', version.id], queryFn: () => api.requirements(version.id) });
  const run = useAction(setError);
  const act = (fn: () => Promise<unknown>) => { setError(''); return run(fn).then(() => qc.invalidateQueries({ queryKey: ['requirements', version.id] })); };
  const editable = version.status === 'draft' && can(me, 'framework:write');
  const all = rows.data ?? [];
  const standards = all.filter((r) => !r.parentId);
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{standards.length} standard{standards.length === 1 ? '' : 's'}</span>
        {standards.length > 0 && <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => setOpen(open.size ? new Set() : new Set(all.map((r) => r.id)))}>{open.size ? 'Collapse all' : 'Expand all'}</Button>}
        {editable && <Button type="button" className="ms-auto" onClick={() => setAdding({ parent: null })}>+ Standard</Button>}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {rows.data && standards.length === 0 && <p className="text-sm text-muted-foreground">No standards yet.</p>}
      <div className="space-y-2" aria-label="Standards" role="list">
        {standards.map((s) => (
          <div role="listitem" key={s.id}>
            <Item api={api} r={s} all={all} editable={editable} open={open} toggle={toggle} me={me} act={act} onAddChild={(p) => setAdding({ parent: p })} {...(evidence ? { evidence } : {})} />
          </div>
        ))}
      </div>
      {adding && (
        <ItemDialog parent={adding.parent} code={nextCode(all, adding.parent)} onClose={() => setAdding(null)}
          onSave={async ({ code, title, description }) => {
            const parent = adding.parent;
            await act(async () => {
              const r = await api.createRequirement(version.id, {
                code, title, levelLabel: parent ? 'Sub-standard' : 'Standard', ...(description ? { officialText: description } : {}), ...(parent ? { parentId: parent.id } : {}),
              });
              setOpen((s) => new Set([...s, ...(parent ? [parent.id] : []), r.id]));
              setAdding(null);
            });
          }} />
      )}
    </div>
  );
}
