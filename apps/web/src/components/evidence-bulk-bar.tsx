import { useState } from 'react';
import type { BulkEvidence, EvidenceItem } from '@ams/shared';
import { useConfirm } from './confirm-dialog';
import { useDirectory, type CycleApis } from './cycles/directory';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type { EvidenceApi } from '../lib/evidence-api';

const select = 'h-8 rounded-md border border-border bg-background px-2 text-sm';

/**
 * The bar above the library while items are selected (TASK-119): change the owning unit, owner, confidentiality, student-data flag,
 * period and tags of every selected item at once (all or none), archive or restore them, or delete them (to the Trash, with an Undo).
 */
export function EvidenceBulkBar({ selected, shown, api, apis, onSelectAll, onClear, onDone }: {
  selected: EvidenceItem[]; shown: EvidenceItem[]; api: EvidenceApi; apis?: CycleApis | undefined;
  onSelectAll: () => void; onClear: () => void; onDone: () => void;
}) {
  const dir = useDirectory(apis);
  const confirm = useConfirm();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [unit, setUnit] = useState('');
  const [person, setPerson] = useState('');
  const [conf, setConf] = useState('');
  const [student, setStudent] = useState('');
  const [period, setPeriod] = useState('');
  const [addTags, setAddTags] = useState('');
  const [removeTags, setRemoveTags] = useState('');
  const n = selected.length;
  const tags = (s: string) => [...new Set(s.split(',').map((t) => t.trim()).filter(Boolean))];
  const allArchived = n > 0 && selected.every((e) => e.status === 'archived');

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const apply = () => {
    const set: NonNullable<BulkEvidence['set']> = {
      ...(unit ? { ownerUnitId: unit === '-' ? null : unit } : {}), ...(person ? { ownerUserId: person === '-' ? null : person } : {}),
      ...(conf ? { confidentiality: conf as 'public' | 'internal' | 'restricted' } : {}), ...(student ? { containsStudentData: student === 'yes' } : {}),
      ...(period.trim() ? { periodLabel: period.trim() } : {}),
    };
    const add = tags(addTags); const rem = tags(removeTags);
    if (!Object.keys(set).length && !add.length && !rem.length) { setError('Choose what to change.'); return; }
    void run(async () => {
      await api.bulk({ ids: selected.map((e) => e.id), set, ...(add.length ? { addTags: add } : {}), ...(rem.length ? { removeTags: rem } : {}) });
      setUnit(''); setPerson(''); setConf(''); setStudent(''); setPeriod(''); setAddTags(''); setRemoveTags('');
    });
  };
  const remove = () => {
    void confirm({
      title: `Delete ${n} ${n === 1 ? 'piece' : 'pieces'} of evidence?`, confirmLabel: 'Delete', tone: 'danger',
      message: `${n === 1 ? selected[0]!.title : `${n} items`} will move to the Trash with ${n === 1 ? 'its' : 'their'} links to standards. You can restore ${n === 1 ? 'it' : 'them'} for 30 days. Versions and files are kept.`,
    }).then((ok) => { if (ok) void run(async () => { await api.deleteItems(selected.map((e) => e.id)); onClear(); }); });
  };

  return (
    <div role="region" aria-label="Bulk actions" className="sticky top-0 z-20 space-y-2 rounded-lg border border-primary bg-background p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium" role="status">{n} selected</span>
        {n < shown.length && <Button type="button" variant="ghost" className="px-2 py-1" onClick={onSelectAll}>Select all {shown.length} shown</Button>}
        <Button type="button" variant="ghost" className="px-2 py-1" onClick={onClear}>Clear</Button>
        <span className="ms-auto flex gap-2">
          <Button type="button" variant="outline" className="px-3 py-1" disabled={busy || n === 0} onClick={() => void run(() => api.bulk({ ids: selected.map((e) => e.id), set: { status: allArchived ? 'active' : 'archived' } }))}>{allArchived ? 'Restore' : 'Archive'}</Button>
          <Button type="button" variant="outline" className="px-3 py-1 text-red-700" disabled={busy || n === 0} onClick={remove}>Delete</Button>
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <label className="flex flex-col gap-1 text-xs">Owning unit
          <select aria-label="Set owning unit" className={select} value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="">Leave as is</option><option value="-">No unit</option>
            {dir.units.map((u) => <option key={u.id} value={u.id}>{u.nameEn}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">Owner
          <select aria-label="Set owner" className={select} value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">Leave as is</option><option value="-">No owner</option>
            {dir.people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">Confidentiality
          <select aria-label="Set confidentiality" className={select} value={conf} onChange={(e) => setConf(e.target.value)}>
            <option value="">Leave as is</option><option value="public">Public</option><option value="internal">Internal</option><option value="restricted">Restricted</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">Student data
          <select aria-label="Set student data" className={select} value={student} onChange={(e) => setStudent(e.target.value)}>
            <option value="">Leave as is</option><option value="yes">Contains student data</option><option value="no">No student data</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">Period<Input aria-label="Set period" className="h-8" placeholder="Leave as is" value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
        <label className="flex flex-col gap-1 text-xs">Add tags<Input aria-label="Add tags" className="h-8" placeholder="kpi, RISE" value={addTags} onChange={(e) => setAddTags(e.target.value)} /></label>
        <label className="flex flex-col gap-1 text-xs">Remove tags<Input aria-label="Remove tags" className="h-8" placeholder="draft" value={removeTags} onChange={(e) => setRemoveTags(e.target.value)} /></label>
        <div className="flex items-end"><Button type="button" className="h-8 px-3 py-1" disabled={busy || n === 0} onClick={apply}>Apply to {n}</Button></div>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
