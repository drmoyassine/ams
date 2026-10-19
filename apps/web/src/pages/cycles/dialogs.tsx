// The small dialogs of the cycle screens: a reason (cancelling a cycle, skipping a stage) and editing a stage or the cycle itself.
import { useState, type FormEvent, type ReactNode } from 'react';
import type { CycleDetail, CycleStage } from '@ams/shared';
import { Dialog } from '../../components/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useDirectory } from '../../components/cycles/directory';
import { fieldCls, selectCls } from '../../components/cycles/labels';
import { useTranslation } from '../../i18n';

/** A dialog's title row with its close button. */
export function DialogTitle({ id, children, onClose }: { id: string; children: ReactNode; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="mb-3 flex items-start justify-between gap-2">
      <h2 id={id} className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl" dir="auto">{children}</h2>
      <Button type="button" variant="ghost" aria-label={t('common.close')} onClick={onClose}>✕</Button>
    </div>
  );
}

/** Asks for a reason (required) before something that is kept on the record: cancelling a cycle, skipping a stage. */
export function ReasonDialog({ title, intro, label, confirm, busy, error, onSubmit, onClose }: {
  title: string; intro?: string; label: string; confirm: string; busy: boolean; error: string; onSubmit: (reason: string) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  return (
    <Dialog labelledBy="reason-title" onClose={onClose}>
      <DialogTitle id="reason-title" onClose={onClose}>{title}</DialogTitle>
      <form className="space-y-3" aria-label={title} onSubmit={(e) => { e.preventDefault(); if (reason.trim()) onSubmit(reason.trim()); }}>
        {intro && <p className="text-sm text-muted-foreground">{intro}</p>}
        <label className={fieldCls}>{label}
          <textarea aria-label={label} dir="auto" required rows={3} autoFocus className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={busy || !reason.trim()}>{confirm}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export interface StageEdit { name: string; process: string; responsibleUnitId: string; ownerUserId: string | null; startDate: string | null; endDate: string | null }

/** Name, instructions, responsible unit, owner and dates of one stage (cycle:manage). */
export function EditStageDialog({ stage, dir, busy, error, onSubmit, onClose }: {
  stage: CycleStage; dir: ReturnType<typeof useDirectory>; busy: boolean; error: string; onSubmit: (v: StageEdit) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(stage.name);
  const [process, setProcess] = useState(stage.process);
  const [unit, setUnit] = useState(stage.responsibleUnitId);
  const [owner, setOwner] = useState(stage.ownerUserId ?? '');
  const [start, setStart] = useState(stage.startDate ?? '');
  const [end, setEnd] = useState(stage.endDate ?? '');
  const units = dir.units.some((u) => u.id === stage.responsibleUnitId) ? dir.units : [...dir.units, { id: stage.responsibleUnitId, nameEn: stage.responsibleUnitName ?? '', nameAr: null, detail: null }];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({ name: name.trim(), process, responsibleUnitId: unit, ownerUserId: owner || null, startDate: start || null, endDate: end || null });
  };
  return (
    <Dialog labelledBy="edit-stage-title" onClose={onClose}>
      <DialogTitle id="edit-stage-title" onClose={onClose}>{t('qmc.editStage.title', { name: stage.name })}</DialogTitle>
      <form className="space-y-3" aria-label={t('qmc.editStage.label')} onSubmit={submit}>
        <label className={fieldCls}>{t('qmc.f.name')}<Input aria-label={t('qmc.f.name')} dir="auto" required value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className={fieldCls}>{t('qmc.f.process')}
          <textarea aria-label={t('qmc.f.process')} dir="auto" rows={3} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" value={process} onChange={(e) => setProcess(e.target.value)} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={fieldCls}>{t('qmc.stage.unit')}
            <select aria-label={t('qmc.stage.unit')} className={selectCls} value={unit} onChange={(e) => setUnit(e.target.value)}>{units.map((u) => <option key={u.id} value={u.id}>{u.nameEn}</option>)}</select>
          </label>
          <label className={fieldCls}>{t('qmc.stage.owner')}
            <select aria-label={t('qmc.stage.owner')} className={selectCls} value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">{t('qmc.choosePerson')}</option>
              {dir.people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
            </select>
          </label>
          <label className={fieldCls}>{t('qmc.f.start')}<Input type="date" aria-label={t('qmc.f.start')} value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label className={fieldCls}>{t('qmc.f.end')}<Input type="date" aria-label={t('qmc.f.end')} min={start || undefined} value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={busy || !name.trim()}>{t('common.save')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export interface CycleEdit { title: string; leadUserId: string; responsibleUnitId: string; startDate: string; endDate: string | null; periodLabel: string | null }

/** Title, lead, responsible unit, dates and period of the cycle (cycle:manage). A running cycle's start date is fixed. */
export function EditCycleDialog({ cycle, dir, busy, error, onSubmit, onClose }: {
  cycle: CycleDetail; dir: ReturnType<typeof useDirectory>; busy: boolean; error: string; onSubmit: (v: CycleEdit) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(cycle.title);
  const [lead, setLead] = useState(cycle.leadUserId);
  const [unit, setUnit] = useState(cycle.responsibleUnitId);
  const [start, setStart] = useState(cycle.startDate);
  const [end, setEnd] = useState(cycle.endDate ?? '');
  const [period, setPeriod] = useState(cycle.periodLabel ?? '');
  const units = dir.units.some((u) => u.id === cycle.responsibleUnitId) ? dir.units : [...dir.units, { id: cycle.responsibleUnitId, nameEn: cycle.responsibleUnitName ?? '', nameAr: null, detail: null }];
  return (
    <Dialog labelledBy="edit-cycle-title" onClose={onClose}>
      <DialogTitle id="edit-cycle-title" onClose={onClose}>{t('qmc.editCycle.title')}</DialogTitle>
      <form className="space-y-3" aria-label={t('qmc.editCycle.title')} onSubmit={(e) => { e.preventDefault(); if (title.trim()) onSubmit({ title: title.trim(), leadUserId: lead, responsibleUnitId: unit, startDate: start, endDate: end || null, periodLabel: period.trim() || null }); }}>
        <label className={fieldCls}>{t('qmc.f.title')}<Input aria-label={t('qmc.f.title')} dir="auto" required value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={fieldCls}>{t('qmc.cycle.lead')}
            <select aria-label={t('qmc.cycle.lead')} className={selectCls} value={lead} onChange={(e) => setLead(e.target.value)}>{dir.people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}</select>
          </label>
          <label className={fieldCls}>{t('qmc.cycle.unit')}
            <select aria-label={t('qmc.cycle.unit')} className={selectCls} value={unit} onChange={(e) => setUnit(e.target.value)}>{units.map((u) => <option key={u.id} value={u.id}>{u.nameEn}</option>)}</select>
          </label>
          <label className={fieldCls}>{t('qmc.f.start')}<Input type="date" aria-label={t('qmc.f.start')} required disabled={cycle.status !== 'draft'} value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label className={fieldCls}>{t('qmc.f.end')}<Input type="date" aria-label={t('qmc.f.end')} value={end} onChange={(e) => setEnd(e.target.value)} /></label>
          <label className={`${fieldCls} sm:col-span-2`}>{t('qmc.f.period')}<Input aria-label={t('qmc.f.period')} dir="auto" value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
        </div>
        {cycle.status !== 'draft' && <p className="text-xs text-muted-foreground">{t('qmc.editCycle.startFixed')}</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={busy || !title.trim()}>{t('common.save')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
