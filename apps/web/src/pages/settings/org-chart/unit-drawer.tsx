// One unit of the org chart: its names in both languages, type, head, description, lock and programs. Opens from a row of
// the tree or a box of the chart; "Add unit" opens it empty (under a parent or at the top). Read-only for people who cannot
// write the organization. Saving sends only what changed; the Undo toast comes from the server's X-Undo header.
import { useState, type FormEvent } from 'react';
import type { OrgUnit, OrgUnitType, UpdateOrgUnit, UserSummary } from '@ams/shared';
import { useConfirm } from '../../../components/confirm-dialog';
import { ContentText } from '../../../components/content-text';
import { Dialog } from '../../../components/dialog';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import type { SettingsApi } from '../../../lib/settings-api';
import { useAction } from '../../../lib/use-action';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
export type DrawerMode = { kind: 'edit'; unit: OrgUnit } | { kind: 'add'; parent: OrgUnit | null };

export const SOURCE_WORDS = { manual: 'Entered by a person', image: 'Read from an image', directory: 'Synced from the directory' } as const;

export function UnitDrawer({ api, mode, types, people, editable, onClose, onSaved, onOpenPrograms }: {
  api: SettingsApi; mode: DrawerMode; types: OrgUnitType[]; people: UserSummary[]; editable: boolean;
  onClose: () => void; onSaved: (unitId?: string) => Promise<unknown> | void; onOpenPrograms: () => void;
}) {
  const unit = mode.kind === 'edit' ? mode.unit : null;
  const confirm = useConfirm();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [nameEn, setNameEn] = useState(unit?.nameEn ?? '');
  const [nameAr, setNameAr] = useState(unit?.nameAr ?? '');
  const [chosenType, setType] = useState(unit?.type ?? '');
  // The type of a new unit starts as Department (or the first type); computed here so a list that loads late still counts.
  const type = chosenType || (types.find((t) => t.key === 'department') ?? types[0])?.key || '';
  const [headUser, setHeadUser] = useState(unit?.headUserId ?? '');
  const [headName, setHeadName] = useState(unit?.headName ?? '');
  const [description, setDescription] = useState(unit?.description ?? '');
  const [locked, setLocked] = useState(unit?.locked ?? false);
  const [active, setActive] = useState(unit?.active ?? true);
  const act = useAction(setError);
  const heading = unit ? unit.nameEn : mode.kind === 'add' && mode.parent ? `New unit under ${mode.parent.nameEn}` : 'New unit';

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!nameEn.trim() || !type || !editable) return;
    setError(''); setBusy(true);
    try {
      const head = headUser ? { headUserId: headUser } : headName.trim() ? { headName: headName.trim() } : null;
      if (!unit) {
        const r = await act(() => api.createOrgUnit({
          parentId: mode.kind === 'add' ? (mode.parent?.id ?? null) : null, type, nameEn: nameEn.trim(),
          ...(nameAr.trim() ? { nameAr: nameAr.trim() } : {}), ...(description.trim() ? { description: description.trim() } : {}), ...(head ?? {}),
        }));
        if (r) { await onSaved(r.id); onClose(); }
        return;
      }
      const patch: UpdateOrgUnit = {};
      if (nameEn.trim() !== unit.nameEn) patch.nameEn = nameEn.trim();
      if (nameAr.trim() !== (unit.nameAr ?? '')) patch.nameAr = nameAr.trim() || null;
      if (type !== unit.type) patch.type = type;
      if (description.trim() !== (unit.description ?? '')) patch.description = description.trim() || null;
      if (locked !== unit.locked) patch.locked = locked;
      if (active !== unit.active) patch.active = active;
      const sameHead = (headUser || null) === unit.headUserId && (headUser ? true : (headName.trim() || null) === unit.headName);
      if (!sameHead) { patch.headUserId = headUser || null; patch.headName = headUser ? null : (headName.trim() || null); }
      if (Object.keys(patch).length === 0) { onClose(); return; }
      const r = await act(() => api.updateOrgUnit(unit.id, patch));
      if (r) { await onSaved(unit.id); onClose(); }
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!unit) return;
    setError(''); setBusy(true);
    try {
      const preview = await act(() => api.previewDeleteOrgUnits([unit.id]));
      if (!preview) return; // refused (programs attached): the reason is shown
      const ok = await confirm({ title: `Delete ${unit.nameEn}?`, message: preview.message, confirmLabel: 'Delete', tone: 'danger' });
      if (!ok) return;
      const r = await act(() => api.deleteOrgUnits([unit.id]));
      if (r) { await onSaved(); onClose(); }
    } finally { setBusy(false); }
  };

  const field = 'flex flex-col gap-1 text-sm';
  const off = !editable;
  return (
    <Dialog labelledBy="unit-drawer-title" onClose={onClose} size="lg">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="unit-drawer-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl"><ContentText>{heading}</ContentText></h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      {off && <p role="note" data-testid="read-only-note" className="mb-3 text-sm text-muted-foreground">You can view this; ask an administrator to change it.</p>}
      <form onSubmit={(e) => void save(e)} className="grid gap-3 sm:grid-cols-2" aria-label={unit ? `Unit ${unit.nameEn}` : 'New unit'}>
        <label className={field}>Name (English)<Input aria-label="Unit name (English)" value={nameEn} onChange={(e) => setNameEn(e.target.value)} disabled={off} required autoFocus={!off} dir="auto" /></label>
        <label className={field}>Name (Arabic)<Input aria-label="Unit name (Arabic)" dir="auto" value={nameAr} onChange={(e) => setNameAr(e.target.value)} disabled={off} /></label>
        <label className={field}>Type
          <select aria-label="Unit type" className={select} value={type} onChange={(e) => setType(e.target.value)} disabled={off}>
            {types.map((t) => <option key={t.key} value={t.key}>{t.labelEn}{t.labelAr ? ` · ${t.labelAr}` : ''}</option>)}
          </select>
        </label>
        <label className={field}>Head (a person)
          <select aria-label="Head (person)" className={select} value={headUser} onChange={(e) => { setHeadUser(e.target.value); if (e.target.value) setHeadName(''); }} disabled={off}>
            <option value="">No person chosen</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </select>
        </label>
        <label className={`${field} sm:col-span-2`}>Head (a name, when the head is not a user of this system)
          <Input aria-label="Head (name)" dir="auto" value={headUser ? '' : headName} onChange={(e) => setHeadName(e.target.value)} disabled={off || !!headUser} placeholder="Dr X" />
        </label>
        <label className={`${field} sm:col-span-2`}>Description
          <textarea aria-label="Description" rows={3} dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} disabled={off} className="rounded-md border border-border bg-background p-2 text-sm" />
        </label>
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input type="checkbox" aria-label="Locked" checked={locked} onChange={(e) => setLocked(e.target.checked)} disabled={off} className="mt-1" />
          <span><span className="font-medium">Locked.</span> Imports and directory sync never change a locked unit.</span>
        </label>
        {unit && (
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" aria-label="Active" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={off} className="mt-1" />
            <span><span className="font-medium">Active.</span> An inactive unit stays on record but takes no new programs or sub-units.</span>
          </label>
        )}
        {unit && (
          <div className="text-sm text-muted-foreground sm:col-span-2" data-testid="unit-meta">
            Source: {SOURCE_WORDS[unit.source]}{unit.editedByPerson ? '; edited by a person' : ''}. {unit.memberCount} {unit.memberCount === 1 ? 'person holds' : 'people hold'} a role for this unit.
          </div>
        )}
        {unit && (
          <div className="sm:col-span-2" data-testid="unit-programs">
            <h3 className="mb-1 text-sm font-medium">Programs ({unit.programCount})</h3>
            {unit.programs.length === 0 ? <p className="text-sm text-muted-foreground">No programs in this unit.</p> : (
              <ul className="list-disc space-y-0.5 ps-5 text-sm">
                {unit.programs.map((p) => (
                  <li key={p.id}>
                    <a href="/settings/organization?tab=programs" className="underline" onClick={(e) => { e.preventDefault(); onClose(); onOpenPrograms(); }}><ContentText>{p.nameEn}</ContentText></a>
                    {p.nameAr && <> · <ContentText className="text-muted-foreground">{p.nameAr}</ContentText></>}
                    {!p.active && <span className="ms-2 rounded border border-border px-1.5 text-xs">Inactive</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && <p role="alert" className="text-sm text-red-700 sm:col-span-2">{error}</p>}
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          {editable && unit && <Button type="button" className="bg-red-700 text-white hover:bg-red-800" disabled={busy} onClick={() => void remove()}>Delete</Button>}
          <span className="ms-auto flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{editable ? 'Cancel' : 'Close'}</Button>
            {editable && <Button type="submit" disabled={busy || !nameEn.trim()}>{unit ? 'Save' : 'Add unit'}</Button>}
          </span>
        </div>
      </form>
    </Dialog>
  );
}
