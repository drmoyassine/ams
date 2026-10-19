// Building a blank draft cycle by hand (the 078 draft-building services): add a stage, an output to a stage, an input to a stage.
import { useState, type FormEvent } from 'react';
import { CYCLE_OUTPUT_KINDS, CYCLE_PICK_KINDS, type AddInput, type AddOutput, type AddStage, type CycleDetail, type CycleOutputKind, type CyclePickKind, type CycleStage } from '@ams/shared';
import { Dialog } from '../../components/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import type { Directory } from '../../components/cycles/directory';
import { fieldCls, selectCls } from '../../components/cycles/labels';
import { useTranslation } from '../../i18n';
import { kindLabels, pickLabels, type T } from '../settings/quality-management/labels';
import { DialogTitle } from './dialogs';

const footer = 'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end';
const area = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground';

export function AddStageDialog({ cycle, dir, busy, error, onSubmit, onClose }: { cycle: CycleDetail; dir: Directory; busy: boolean; error: string; onSubmit: (v: AddStage) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [process, setProcess] = useState('');
  const [checklist, setChecklist] = useState('');
  const [unit, setUnit] = useState(cycle.responsibleUnitId);
  const [owner, setOwner] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const units = dir.units.some((u) => u.id === cycle.responsibleUnitId) ? dir.units : [...dir.units, { id: cycle.responsibleUnitId, nameEn: cycle.responsibleUnitName ?? '', nameAr: null, detail: null }];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const items = checklist.split('\n').map((x) => x.trim()).filter(Boolean);
    onSubmit({
      name: name.trim(), ...(nameAr.trim() ? { nameAr: nameAr.trim() } : {}), process, checklist: items, responsibleUnitId: unit,
      ...(owner ? { ownerUserId: owner } : {}), ...(start ? { startDate: start } : {}), ...(end ? { endDate: end } : {}),
    });
  };
  return (
    <Dialog labelledBy="add-stage-title" onClose={onClose}>
      <DialogTitle id="add-stage-title" onClose={onClose}>{t('qmc.addStage.title')}</DialogTitle>
      <form className="space-y-3" aria-label={t('qmc.addStage.title')} onSubmit={submit}>
        <label className={fieldCls}>{t('qmc.f.name')}<Input aria-label={t('qmc.f.name')} dir="auto" required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className={fieldCls}>{t('qmc.f.nameAr')}<Input aria-label={t('qmc.f.nameAr')} dir="auto" value={nameAr} onChange={(e) => setNameAr(e.target.value)} /></label>
        <label className={fieldCls}>{t('qmc.f.process')}<textarea aria-label={t('qmc.f.process')} dir="auto" rows={3} className={area} value={process} onChange={(e) => setProcess(e.target.value)} /></label>
        <label className={fieldCls}>{t('qmc.f.checklist')}<textarea aria-label={t('qmc.f.checklist')} dir="auto" rows={3} className={area} value={checklist} onChange={(e) => setChecklist(e.target.value)} /></label>
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
        <div className={footer}>
          <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={busy || !name.trim()}>{t('qmc.addStage.submit')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function AddOutputDialog({ stage, dir, busy, error, onSubmit, onClose }: { stage: CycleStage; dir: Directory; busy: boolean; error: string; onSubmit: (v: AddOutput) => void; onClose: () => void }) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CycleOutputKind>('note');
  const [required, setRequired] = useState(true);
  const [approver, setApprover] = useState('');
  const labels = kindLabels(t);
  return (
    <Dialog labelledBy="add-output-title" onClose={onClose}>
      <DialogTitle id="add-output-title" onClose={onClose}>{t('qmc.addOutput.title', { name: stage.name })}</DialogTitle>
      <form className="space-y-3" aria-label={t('qmc.addOutput.label')} onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit({ name: name.trim(), kind, required, ...(kind === 'approval' && approver ? { approverUserId: approver } : {}) }); }}>
        <label className={fieldCls}>{t('qmc.f.name')}<Input aria-label={t('qmc.f.name')} dir="auto" required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className={fieldCls}>{t('qmc.f.kind')}
          <select aria-label={t('qmc.f.kind')} className={selectCls} value={kind} onChange={(e) => setKind(e.target.value as CycleOutputKind)}>
            {CYCLE_OUTPUT_KINDS.map((k) => <option key={k} value={k}>{labels[k]}</option>)}
          </select>
        </label>
        {kind === 'approval' && (
          <label className={fieldCls}>{t('qmc.out.approver')}
            <select aria-label={t('qmc.out.approver')} className={selectCls} value={approver} onChange={(e) => setApprover(e.target.value)}>
              <option value="">{t('qmc.choosePerson')}</option>
              {dir.people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />{t('qmc.f.required')}</label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className={footer}>
          <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={busy || !name.trim()}>{t('qmc.addOutput.submit')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

type InputSource = 'output' | 'previous' | 'pick';

export function AddInputDialog({ cycle, stage, busy, error, onSubmit, onClose }: { cycle: CycleDetail; stage: CycleStage; busy: boolean; error: string; onSubmit: (v: AddInput) => void; onClose: () => void }) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const earlier = cycle.stages.filter((s) => s.displayOrder < stage.displayOrder);
  const outputs = earlier.flatMap((s) => s.outputs.map((o) => ({ ...o, stageName: s.name, stageKey: s.key })));
  const [name, setName] = useState('');
  const [source, setSource] = useState<InputSource>(outputs.length ? 'output' : 'pick');
  const [outputId, setOutputId] = useState('');
  const [previousOf, setPreviousOf] = useState('');
  const [pick, setPick] = useState<CyclePickKind>('any');
  const [required, setRequired] = useState(true);
  const labels = pickLabels(t);
  const all = cycle.stages.flatMap((s) => s.outputs.map((o) => ({ id: o.id, stageKey: s.key, outputKey: o.key, label: `${s.name} → ${o.name}` })));
  const ready = !!name.trim() && (source === 'pick' || (source === 'output' && !!outputId) || (source === 'previous' && !!previousOf));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const base = { name: name.trim(), required };
    if (source === 'output') onSubmit({ ...base, fromOutputId: outputId });
    else if (source === 'previous') { const o = all.find((x) => x.id === previousOf)!; onSubmit({ ...base, previousCycle: { stage: o.stageKey, output: o.outputKey } }); }
    else onSubmit({ ...base, pick });
  };
  return (
    <Dialog labelledBy="add-input-title" onClose={onClose}>
      <DialogTitle id="add-input-title" onClose={onClose}>{t('qmc.addInput.title', { name: stage.name })}</DialogTitle>
      <form className="space-y-3" aria-label={t('qmc.addInput.label')} onSubmit={submit}>
        <label className={fieldCls}>{t('qmc.f.name')}<Input aria-label={t('qmc.f.name')} dir="auto" required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className={fieldCls}>{t('qmc.f.reads')}
          <select aria-label={t('qmc.f.reads')} className={selectCls} value={source} onChange={(e) => setSource(e.target.value as InputSource)}>
            {outputs.length > 0 && <option value="output">{t('qmc.addInput.fromOutput')}</option>}
            {cycle.previousCycleId && <option value="previous">{t('qmc.addInput.fromPrevious')}</option>}
            <option value="pick">{t('qmc.addInput.fromPick')}</option>
          </select>
        </label>
        {source === 'output' && (
          <label className={fieldCls}>{t('qmc.addInput.output')}
            <select aria-label={t('qmc.addInput.output')} className={selectCls} required value={outputId} onChange={(e) => setOutputId(e.target.value)}>
              <option value="">{t('qmc.addInput.chooseOutput')}</option>
              {outputs.map((o) => <option key={o.id} value={o.id}>{o.stageName} → {o.name}</option>)}
            </select>
          </label>
        )}
        {source === 'previous' && (
          <label className={fieldCls}>{t('qmc.addInput.output')}
            <select aria-label={t('qmc.addInput.output')} className={selectCls} required value={previousOf} onChange={(e) => setPreviousOf(e.target.value)}>
              <option value="">{t('qmc.addInput.chooseOutput')}</option>
              {all.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
        )}
        {source === 'pick' && (
          <label className={fieldCls}>{t('qmc.addInput.pickKind')}
            <select aria-label={t('qmc.addInput.pickKind')} className={selectCls} value={pick} onChange={(e) => setPick(e.target.value as CyclePickKind)}>
              {CYCLE_PICK_KINDS.map((k) => <option key={k} value={k}>{labels[k]}</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />{t('qmc.f.required')}</label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className={footer}>
          <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={busy || !ready}>{t('qmc.addInput.submit')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
