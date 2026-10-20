// One stage of the template editor: its header (number, name, what it holds, move up/down, remove) and, when open, its details:
// names, process text, checklist, who owns it, when it starts and how long it takes, and its outputs and inputs. The owner rule is simple
// (DEC-030): the cycle's owner (the default), a named role, or the head of the evidence's owner unit; a rule an older template holds
// ("head of the unit", "head of the unit above") stays readable and can be kept or changed. The unit rule is no longer edited here (a
// template keeps the one it has; a cycle's units follow from its owner).
// Every control carries the stage (and output or input) number in its label, so a screen reader hears where it is. Read-only
// pages show the same card with every field disabled and no editing buttons.
import type { PersonRule } from '@ams/shared';
import { CYCLE_OUTPUT_KINDS, CYCLE_PICK_KINDS, ROLES } from '@ams/shared';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { useTranslation } from '../../../i18n';
import { allOutputs, earlierOutputs, move, newInput, newOutput, removeOutput, type EInput, type EOutput, type EStage, type Problem } from './editor-model';
import { kindLabels, personRuleLabels, pickLabels, problemText, roleLabels, type T } from './labels';

const control = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-60';
const labelCls = 'flex min-w-0 flex-col gap-1 text-xs text-muted-foreground';
const iconBtn = 'px-2 py-1';
/** The rules the editor offers; the older ones are listed only while a template still holds one. */
const PERSON_KINDS: PersonRule['kind'][] = ['cycle_lead', 'role', 'head_of_evidence_unit'];

function PersonRuleField({ value, onChange, label, t, allowNone = false }: { value: PersonRule | null; onChange: (v: PersonRule | null) => void; label: string; t: T; allowNone?: boolean }) {
  const labels = personRuleLabels(t);
  const roles = roleLabels(t);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className={labelCls}>{allowNone ? t('qmt.f.approver') : t('qmt.f.owner')}
        <select aria-label={label} className={control} value={value?.kind ?? ''}
          onChange={(e) => {
            const k = e.target.value;
            if (k === '') onChange(null);
            else if (k === 'role') onChange({ kind: 'role', role: value?.kind === 'role' ? value.role : 'lead' });
            else onChange({ kind: k } as PersonRule);
          }}>
          {allowNone && <option value="">{t('qmt.f.approverNone')}</option>}
          {PERSON_KINDS.map((k) => <option key={k} value={k}>{labels[k]}</option>)}
          {value && !PERSON_KINDS.includes(value.kind) && <option value={value.kind}>{labels[value.kind]}</option>}
        </select>
      </label>
      {value?.kind === 'role' && (
        <label className={labelCls}>{t('qmt.f.role')}
          <select aria-label={`${label}: ${t('qmt.f.role')}`} className={control} value={value.role} onChange={(e) => onChange({ kind: 'role', role: e.target.value as (typeof ROLES)[number] })}>
            {ROLES.map((r) => <option key={r} value={r}>{roles[r]}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

function OutputRow({ o, n, j, count, editable, onChange, onMove, onRemove, t }: {
  o: EOutput; n: number; j: number; count: number; editable: boolean; onChange: (o: EOutput) => void; onMove: (d: -1 | 1) => void; onRemove: () => void; t: T;
}) {
  const at = { stage: n, n: j + 1 };
  const kinds = kindLabels(t);
  return (
    <li data-testid="output-row" className="space-y-2 rounded-md border border-border p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className={labelCls}>{t('qmt.f.nameEn')}
          <Input aria-label={t('qmt.f.outName', at)} dir="auto" value={o.name} onChange={(e) => onChange({ ...o, name: e.target.value })} />
        </label>
        <label className={labelCls}>{t('qmt.f.nameAr')}
          <Input aria-label={t('qmt.f.outNameAr', at)} dir="auto" value={o.nameAr} onChange={(e) => onChange({ ...o, nameAr: e.target.value })} />
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className={labelCls}>{t('qmt.f.kind')}
          <select aria-label={t('qmt.f.outKind', at)} className={control} value={o.kind} onChange={(e) => onChange({ ...o, kind: e.target.value as EOutput['kind'] })}>
            {CYCLE_OUTPUT_KINDS.map((k) => <option key={k} value={k}>{kinds[k]}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 pt-5 text-sm">
          <input type="checkbox" checked={o.required} onChange={(e) => onChange({ ...o, required: e.target.checked })} aria-label={t('qmt.f.outRequired', at)} />
          {t('qmt.f.required')}
        </label>
      </div>
      {o.kind === 'report' && (
        <label className={labelCls}>{t('qmt.f.reportKey')}
          <Input aria-label={t('qmt.f.outReportKey', at)} value={o.reportTemplateKey} placeholder={t('qmt.f.reportKeyHint')} onChange={(e) => onChange({ ...o, reportTemplateKey: e.target.value })} />
        </label>
      )}
      {o.kind === 'approval' && <PersonRuleField allowNone t={t} label={t('qmt.f.outApprover', at)} value={o.approver} onChange={(approver) => onChange({ ...o, approver })} />}
      {editable && (
        <div className="flex flex-wrap gap-1">
          <Button type="button" variant="ghost" className={iconBtn} disabled={j === 0} aria-label={t('qmt.act.outUp', at)} onClick={() => onMove(-1)}>↑</Button>
          <Button type="button" variant="ghost" className={iconBtn} disabled={j === count - 1} aria-label={t('qmt.act.outDown', at)} onClick={() => onMove(1)}>↓</Button>
          <Button type="button" variant="ghost" className={`${iconBtn} text-red-700`} aria-label={t('qmt.act.outRemove', at)} onClick={onRemove}>{t('common.remove')}</Button>
        </div>
      )}
    </li>
  );
}

function InputRow({ inp, n, j, count, stages, i, editable, onChange, onMove, onRemove, t }: {
  inp: EInput; n: number; j: number; count: number; stages: EStage[]; i: number; editable: boolean; onChange: (v: EInput) => void; onMove: (d: -1 | 1) => void; onRemove: () => void; t: T;
}) {
  const at = { stage: n, n: j + 1 };
  const picks = pickLabels(t);
  // An input reads an output of a stage ABOVE this one, or of the previous run of this template (any stage of it).
  const earlier = earlierOutputs(stages, i);
  const every = allOutputs(stages);
  const options = inp.source === 'stage_output' ? earlier : every;
  const value = `${inp.refStage}|${inp.refOutput}`;
  const listed = options.some((o) => `${o.stageUid}|${o.outputUid}` === value);
  const text = (o: { stageNo: number; stageName: string; outputName: string }) => t('qmt.f.outputOf', { stage: o.stageNo, name: o.stageName.trim() || t('qmt.stage.unnamed'), output: o.outputName.trim() || t('qmt.output.unnamed') });
  const setSource = (source: EInput['source']) => {
    if (source === 'pick') { onChange({ ...inp, source, refStage: '', refOutput: '' }); return; }
    const pool = source === 'stage_output' ? earlier : every;
    const keep = pool.find((o) => `${o.stageUid}|${o.outputUid}` === value) ?? pool[0];
    if (!keep) return;
    onChange({ ...inp, source, refStage: keep.stageUid, refOutput: keep.outputUid });
  };
  return (
    <li data-testid="input-row" className="space-y-2 rounded-md border border-border p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className={labelCls}>{t('qmt.f.nameEn')}
          <Input aria-label={t('qmt.f.inName', at)} dir="auto" value={inp.name} onChange={(e) => onChange({ ...inp, name: e.target.value })} />
        </label>
        <label className={labelCls}>{t('qmt.f.nameAr')}
          <Input aria-label={t('qmt.f.inNameAr', at)} dir="auto" value={inp.nameAr} onChange={(e) => onChange({ ...inp, nameAr: e.target.value })} />
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className={labelCls}>{t('qmt.f.source')}
          <select aria-label={t('qmt.f.inSource', at)} className={control} value={inp.source} onChange={(e) => setSource(e.target.value as EInput['source'])}>
            <option value="stage_output" disabled={earlier.length === 0 && inp.source !== 'stage_output'}>{t('qmt.src.stage')}</option>
            <option value="previous_cycle" disabled={every.length === 0 && inp.source !== 'previous_cycle'}>{t('qmt.src.previous')}</option>
            <option value="pick">{t('qmt.src.pick')}</option>
          </select>
        </label>
        {inp.source === 'pick' ? (
          <label className={labelCls}>{t('qmt.f.pickKind')}
            <select aria-label={t('qmt.f.inPick', at)} className={control} value={inp.pick} onChange={(e) => onChange({ ...inp, pick: e.target.value as EInput['pick'] })}>
              {CYCLE_PICK_KINDS.map((k) => <option key={k} value={k}>{picks[k]}</option>)}
            </select>
          </label>
        ) : (
          <label className={labelCls}>{inp.source === 'stage_output' ? t('qmt.f.fromEarlier') : t('qmt.f.fromPrevious')}
            <select aria-label={t('qmt.f.inFrom', at)} className={control} value={value}
              onChange={(e) => { const [refStage, refOutput] = e.target.value.split('|'); onChange({ ...inp, refStage: refStage!, refOutput: refOutput! }); }}>
              {!listed && <option value={value}>{t('qmt.f.notAbove')}</option>}
              {options.map((o) => <option key={`${o.stageUid}|${o.outputUid}`} value={`${o.stageUid}|${o.outputUid}`}>{text(o)}</option>)}
            </select>
          </label>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={inp.required} onChange={(e) => onChange({ ...inp, required: e.target.checked })} aria-label={t('qmt.f.inRequired', at)} />
        {t('qmt.f.required')}
      </label>
      {editable && (
        <div className="flex flex-wrap gap-1">
          <Button type="button" variant="ghost" className={iconBtn} disabled={j === 0} aria-label={t('qmt.act.inUp', at)} onClick={() => onMove(-1)}>↑</Button>
          <Button type="button" variant="ghost" className={iconBtn} disabled={j === count - 1} aria-label={t('qmt.act.inDown', at)} onClick={() => onMove(1)}>↓</Button>
          <Button type="button" variant="ghost" className={`${iconBtn} text-red-700`} aria-label={t('qmt.act.inRemove', at)} onClick={onRemove}>{t('common.remove')}</Button>
        </div>
      )}
    </li>
  );
}

export interface StageCardProps {
  stage: EStage; index: number; stages: EStage[]; editable: boolean; open: boolean; problems: Problem[];
  onToggle: () => void; onChange: (s: EStage) => void; onMove: (d: -1 | 1) => void; onRemove: () => void;
  /** Replaces all the stages (an output was removed and inputs that read it were detached). */
  onStages: (stages: EStage[], detached: number) => void;
}

export function StageCard({ stage: s, index: i, stages, editable, open, problems, onToggle, onChange, onMove, onRemove, onStages }: StageCardProps) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const n = i + 1;
  const blocking = problems.filter((p) => p.level !== 'note');
  const notes = problems.filter((p) => p.level === 'note');
  const bodyId = `stage-body-${s.uid}`;
  const set = (patch: Partial<EStage>) => onChange({ ...s, ...patch });
  const end = (Number(s.start) || 0) + (Number(s.length) || 0);
  return (
    <li id={`stage-${s.uid}`} data-testid="stage" className="rounded-lg border border-border bg-background">
      <div className="flex flex-wrap items-center gap-2 p-2 sm:p-3">
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-2 py-1 text-start hover:bg-muted">
          <span className="max-w-full break-words text-sm font-medium" dir="auto">{n}. {s.name.trim() || t('qmt.stage.unnamed')}</span>
          <span className="text-xs text-muted-foreground">
            {t('qmt.stage.days', { from: Number(s.start) || 0, to: end })} · {t('qmt.stage.counts', { outputs: s.outputs.length, inputs: s.inputs.length })}
          </span>
        </button>
        {blocking.length > 0 && <span data-testid="stage-issues" className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800">{t('qmt.stage.toFix', { count: blocking.length })}</span>}
        {editable && (
          <span className="flex items-center gap-1">
            <Button type="button" variant="ghost" className={iconBtn} disabled={i === 0} aria-label={t('qmt.act.stageUp', { n })} onClick={() => onMove(-1)}>↑</Button>
            <Button type="button" variant="ghost" className={iconBtn} disabled={i === stages.length - 1} aria-label={t('qmt.act.stageDown', { n })} onClick={() => onMove(1)}>↓</Button>
            <Button type="button" variant="ghost" className={`${iconBtn} text-red-700`} aria-label={t('qmt.act.stageRemove', { n })} onClick={onRemove}>{t('common.remove')}</Button>
          </span>
        )}
      </div>
      {open && (
        <fieldset id={bodyId} disabled={!editable} className="m-0 min-w-0 space-y-4 border-0 border-t border-border p-3 sm:p-4">
          <legend className="sr-only">{t('qmt.stage.legend', { n })}</legend>
          {blocking.length > 0 && (
            <ul data-testid="stage-problems" className="space-y-1 rounded-md bg-red-50 p-2 text-sm text-red-900">
              {blocking.map((p, k) => <li key={k} dir="auto">{problemText(t, p)}</li>)}
            </ul>
          )}
          {notes.length > 0 && (
            <ul className="space-y-1 rounded-md bg-muted p-2 text-sm">
              {notes.map((p, k) => <li key={k} dir="auto">{problemText(t, p)}</li>)}
            </ul>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={labelCls}>{t('qmt.f.nameEn')}
              <Input aria-label={t('qmt.f.stageName', { n })} dir="auto" value={s.name} onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className={labelCls}>{t('qmt.f.nameAr')}
              <Input aria-label={t('qmt.f.stageNameAr', { n })} dir="auto" value={s.nameAr} onChange={(e) => set({ nameAr: e.target.value })} />
            </label>
          </div>
          <label className={labelCls}>{t('qmt.f.process')}
            <textarea aria-label={t('qmt.f.stageProcess', { n })} dir="auto" rows={3} className={control} value={s.process} onChange={(e) => set({ process: e.target.value })} />
          </label>
          <label className={labelCls}>{t('qmt.f.checklist')}
            <textarea aria-label={t('qmt.f.stageChecklist', { n })} dir="auto" rows={3} className={control} value={s.checklist} onChange={(e) => set({ checklist: e.target.value })} />
          </label>
          <div className="grid gap-3 lg:grid-cols-2">
            <PersonRuleField t={t} label={t('qmt.f.stageOwner', { n })} value={s.owner} onChange={(owner) => set({ owner: owner ?? { kind: 'cycle_lead' } })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={labelCls}>{t('qmt.f.start')}
              <Input type="number" min={0} step={1} inputMode="numeric" aria-label={t('qmt.f.stageStart', { n })} value={s.start} onChange={(e) => set({ start: e.target.value })} />
            </label>
            <label className={labelCls}>{t('qmt.f.length')}
              <Input type="number" min={0} step={1} inputMode="numeric" aria-label={t('qmt.f.stageLength', { n })} value={s.length} onChange={(e) => set({ length: e.target.value })} />
            </label>
          </div>

          <section aria-label={t('qmt.f.inputsOf', { n })} className="space-y-2">
            <h4 className="text-sm font-semibold">{t('qmt.f.inputs')}</h4>
            <p className="text-xs text-muted-foreground">{t('qmt.f.inputsHint')}</p>
            {s.inputs.length === 0 && <p className="text-sm text-muted-foreground">{t('qmt.f.noInputs')}</p>}
            <ul className="space-y-2">
              {s.inputs.map((inp, j) => (
                <InputRow key={inp.uid} inp={inp} n={n} j={j} i={i} count={s.inputs.length} stages={stages} editable={editable} t={t}
                  onChange={(v) => set({ inputs: s.inputs.map((x) => (x.uid === inp.uid ? v : x)) })}
                  onMove={(d) => set({ inputs: move(s.inputs, j, d) })} onRemove={() => set({ inputs: s.inputs.filter((x) => x.uid !== inp.uid) })} />
              ))}
            </ul>
            {editable && <Button type="button" variant="outline" onClick={() => set({ inputs: [...s.inputs, newInput(t('qmt.input.newName', { n: s.inputs.length + 1 }))] })}>{t('qmt.act.addInput', { n })}</Button>}
          </section>

          <section aria-label={t('qmt.f.outputsOf', { n })} className="space-y-2">
            <h4 className="text-sm font-semibold">{t('qmt.f.outputs')}</h4>
            <p className="text-xs text-muted-foreground">{t('qmt.f.outputsHint')}</p>
            {s.outputs.length === 0 && <p className="text-sm text-muted-foreground">{t('qmt.f.noOutputs')}</p>}
            <ul className="space-y-2">
              {s.outputs.map((o, j) => (
                <OutputRow key={o.uid} o={o} n={n} j={j} count={s.outputs.length} editable={editable} t={t}
                  onChange={(v) => set({ outputs: s.outputs.map((x) => (x.uid === o.uid ? v : x)) })}
                  onMove={(d) => set({ outputs: move(s.outputs, j, d) })}
                  onRemove={() => { const r = removeOutput(stages, o.uid); onStages(r.stages, r.changed); }} />
              ))}
            </ul>
            {editable && <Button type="button" variant="outline" onClick={() => set({ outputs: [...s.outputs, newOutput(t('qmt.output.newName', { n: s.outputs.length + 1 }))] })}>{t('qmt.act.addOutput', { n })}</Button>}
          </section>
        </fieldset>
      )}
    </li>
  );
}
