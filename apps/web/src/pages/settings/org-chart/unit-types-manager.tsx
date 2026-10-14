// "Unit types": the kinds of unit this institution's org chart has (college, school, department ...). Add, rename (English and
// Arabic), move up or down, and remove a type that no unit uses. Every change is saved at once and can be undone.
import { useState, type FormEvent } from 'react';
import type { OrgUnitType } from '@ams/shared';
import { Dialog } from '../../../components/dialog';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import type { SettingsApi } from '../../../lib/settings-api';
import { useAction } from '../../../lib/use-action';

function TypeRow({ type, index, count, editable, busy, onSave, onMove, onRemove }: {
  type: OrgUnitType; index: number; count: number; editable: boolean; busy: boolean;
  onSave: (labelEn: string, labelAr: string) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void;
}) {
  const [en, setEn] = useState(type.labelEn);
  const [ar, setAr] = useState(type.labelAr ?? '');
  const dirty = en.trim() !== type.labelEn || ar.trim() !== (type.labelAr ?? '');
  return (
    <li className="flex flex-wrap items-end gap-2 rounded-md border border-border p-2" data-testid="unit-type-row">
      <label className="flex min-w-32 flex-1 flex-col text-xs">Name (English)
        <Input aria-label={`Name of ${type.labelEn} (English)`} value={en} onChange={(e) => setEn(e.target.value)} disabled={!editable} />
      </label>
      <label className="flex min-w-32 flex-1 flex-col text-xs">Name (Arabic)
        <Input aria-label={`Name of ${type.labelEn} (Arabic)`} dir="auto" value={ar} onChange={(e) => setAr(e.target.value)} disabled={!editable} />
      </label>
      <span className="pb-2 text-xs text-muted-foreground" data-testid="unit-type-count">{type.unitCount} {type.unitCount === 1 ? 'unit' : 'units'}</span>
      {editable && (
        <span className="flex items-center gap-1">
          <Button type="button" variant="outline" className="px-2 py-1" disabled={!dirty || !en.trim() || busy} onClick={() => onSave(en.trim(), ar.trim())} aria-label={`Save ${type.labelEn}`}>Save</Button>
          <Button type="button" variant="ghost" className="px-2 py-1" disabled={index === 0 || busy} onClick={() => onMove(-1)} aria-label={`Move ${type.labelEn} up`}>↑</Button>
          <Button type="button" variant="ghost" className="px-2 py-1" disabled={index === count - 1 || busy} onClick={() => onMove(1)} aria-label={`Move ${type.labelEn} down`}>↓</Button>
          <Button type="button" variant="ghost" className="px-2 py-1 text-red-700" disabled={type.unitCount > 0 || count <= 1 || busy}
            title={type.unitCount > 0 ? `Used by ${type.unitCount} ${type.unitCount === 1 ? 'unit' : 'units'}: change their type first` : 'Remove this type'}
            onClick={onRemove} aria-label={`Remove ${type.labelEn}`}>Remove</Button>
        </span>
      )}
    </li>
  );
}

export function UnitTypesManager({ api, types, editable, onChanged, onClose }: {
  api: SettingsApi; types: OrgUnitType[]; editable: boolean; onChanged: () => Promise<unknown> | void; onClose: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [en, setEn] = useState('');
  const [ar, setAr] = useState('');
  const act = useAction(setError);
  const run = async (fn: () => Promise<unknown>) => {
    setError(''); setBusy(true);
    try { await act(fn); await onChanged(); } finally { setBusy(false); }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!en.trim()) return;
    void run(async () => { const r = await api.createOrgUnitType({ labelEn: en.trim(), ...(ar.trim() ? { labelAr: ar.trim() } : {}) }); setEn(''); setAr(''); return r; });
  };
  const move = (i: number, dir: -1 | 1) => {
    const ids = types.map((t) => t.id);
    const [x] = ids.splice(i, 1);
    ids.splice(i + dir, 0, x!);
    void run(() => api.reorderOrgUnitTypes(ids));
  };
  return (
    <Dialog labelledBy="unit-types-title" onClose={onClose} size="lg">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="unit-types-title" className="min-w-0 pt-1 text-lg font-semibold sm:text-xl">Unit types</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">The kinds of unit in your organization chart. Renaming a type renames it on every unit that has it. A type can be removed only when no unit uses it.</p>
      {!editable && <p role="note" className="mb-3 text-sm text-muted-foreground">You can view this; ask an administrator to change it.</p>}
      {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
      <ul className="space-y-2" aria-label="Unit types">
        {types.map((t, i) => (
          <TypeRow key={`${t.id}:${t.labelEn}:${t.labelAr ?? ''}`} type={t} index={i} count={types.length} editable={editable} busy={busy}
            onSave={(labelEn, labelAr) => void run(() => api.updateOrgUnitType(t.id, { labelEn, labelAr: labelAr || null }))}
            onMove={(d) => move(i, d)} onRemove={() => void run(() => api.removeOrgUnitType(t.id))} />
        ))}
      </ul>
      {editable && (
        <form onSubmit={add} className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-3" aria-label="Add a unit type">
          <label className="flex min-w-32 flex-1 flex-col text-xs">New type (English)<Input aria-label="New type name (English)" value={en} onChange={(e) => setEn(e.target.value)} /></label>
          <label className="flex min-w-32 flex-1 flex-col text-xs">New type (Arabic)<Input aria-label="New type name (Arabic)" dir="auto" value={ar} onChange={(e) => setAr(e.target.value)} /></label>
          <Button type="submit" disabled={!en.trim() || busy}>Add type</Button>
        </form>
      )}
      <div className="mt-4 flex justify-end"><Button type="button" variant="outline" onClick={onClose}>Done</Button></div>
    </Dialog>
  );
}
