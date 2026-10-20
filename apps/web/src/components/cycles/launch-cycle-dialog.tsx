// Launching a cycle (TASK-080): the one dialog behind "New cycle" in Quality Management and "Create cycle" in the ⋯ menu of a standard.
// Step 1 asks what the cycle is about (the anchor: a unit, a program, the institution or a standard; fixed when the dialog is opened
// from a standard), which published template fits (or none: a blank cycle to build by hand), who does the work, when it starts and who
// leads it. The cycle is made as a DRAFT with its stages resolved from the template's rules. Step 2 shows that resolution BEFORE the
// cycle starts: the unit and owner of every stage and the approver of every approval, the ones the rules could not settle flagged and
// editable (nothing is ever guessed). "Start the cycle" then activates it; "Keep as a draft" leaves it for later.
import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CycleAnchorKind, CycleDetail, CycleStage, DueRun, Me } from '@ams/shared';
import { useTranslation } from '../../i18n';
import { useCyclesApi } from '../../lib/cycles-api';
import { useApi } from '../../lib/me';
import { useAction } from '../../lib/use-action';
import { ContentText } from '../content-text';
import { Dialog } from '../dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useDirectory, type CycleApis } from './directory';
import { anchorLabels } from '../../pages/settings/quality-management/labels';
import type { T } from '../../pages/settings/quality-management/labels';
import { Chip, fieldCls, selectCls } from './labels';

const today = () => new Date().toISOString().slice(0, 10);

/** What the cycle is about, when the dialog is opened from a thing (a standard) rather than from the list. */
export interface LaunchAnchor { kind: CycleAnchorKind; id: string; label: string; title?: string }
/** The kinds the list's "New cycle" offers; the others are started from their own ⋯ menus. */
type PickKind = 'org_unit' | 'program' | 'institution' | 'requirement';
const PICK_KINDS: PickKind[] = ['org_unit', 'program', 'institution', 'requirement'];

export function LaunchCycleDialog({ anchor: anchorProp, subject: subjectProp = '', proposal, me, apis = {}, onClose, onOpen, onMade }: {
  anchor?: LaunchAnchor; /** `org_unit:<id>` or `program:<id>` to start the choice with. */ subject?: string; me: Me | undefined; apis?: CycleApis;
  /** A run a plan proposed (TASK-081): what it is about, who does the work, the template, the period and the plan are fixed; dates, unit and owner can be changed. */
  proposal?: DueRun;
  onClose: () => void; onOpen?: (cycleId: string) => void;
  /** Called when the cycle has been made (as a draft), before the person checks its owners. */
  onMade?: (cycle: CycleDetail) => void;
}) {
  const anchor: LaunchAnchor | undefined = anchorProp ?? (proposal ? { kind: proposal.anchorKind, id: proposal.anchorId, label: proposal.periodLabel, title: proposal.anchorName ?? proposal.planLabel } : undefined);
  const defaultSubject = proposal ? (proposal.subjectKind && proposal.subjectId ? `${proposal.subjectKind}:${proposal.subjectId}` : '') : subjectProp;
  const { t } = useTranslation();
  const api = useCyclesApi(apis.cycles);
  const framework = useApi(apis.framework);
  const dir = useDirectory(apis);
  const qc = useQueryClient();
  const [kind, setKind] = useState<PickKind>('org_unit');
  const [itemId, setItemId] = useState('');
  const [subject, setSubject] = useState(defaultSubject);
  const [unitId, setUnitId] = useState(proposal?.responsibleUnitId ?? '');
  const [templateId, setTemplateId] = useState(proposal?.templateId ?? '');
  const [startDate, setStartDate] = useState(proposal ? (proposal.periodStart > today() ? proposal.periodStart : today()) : today());
  const [lead, setLead] = useState(proposal?.ownerUserId ?? me?.userId ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<CycleDetail | null>(null);
  const act = useAction(setError);
  const anchors = anchorLabels(t as unknown as T);
  const anchorKind: CycleAnchorKind = anchor?.kind ?? kind;
  const anchorId = anchor?.id ?? (kind === 'institution' ? (me?.institutionId ?? '') : itemId);

  const templates = useQuery({ queryKey: ['cycle-templates', 'published', anchorKind], queryFn: () => api.templates({ status: 'published', anchorKind }) });
  // The standards of the internal quality framework (newest published version), for a cycle about a standard.
  const standards = useQuery({
    queryKey: ['launch-standards'], enabled: !anchor && kind === 'requirement',
    queryFn: async () => {
      const qf = await framework.qualityFramework();
      const v = [...qf.versions].reverse().find((x) => x.status === 'published') ?? qf.versions[qf.versions.length - 1];
      return v ? framework.requirements(v.id) : [];
    },
  });
  const fits = (templates.data ?? []).filter((x) => x.status === 'published' && (proposal ? x.id === proposal.templateId : x.anchorKinds.length === 0 || x.anchorKinds.includes(anchorKind)));
  const noTemplates = templates.data !== undefined && fits.length === 0;
  const anchorIsPlace = anchorKind === 'org_unit' || anchorKind === 'program';
  const canSubmit = !busy && !!anchorId && !!startDate && (!!subject || anchorIsPlace || !!unitId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setError('');
    try {
      const [subjectKind, subjectId] = subject ? (subject.split(':') as ['org_unit' | 'program', string]) : [undefined, undefined];
      const r = await act(() => api.launch({
        anchorKind, anchorId, startDate, ...(subjectKind ? { subjectKind, subjectId } : {}),
        ...(templateId ? { templateId } : {}), ...(lead ? { leadUserId: lead } : {}), ...(unitId ? { responsibleUnitId: unitId } : {}),
        ...(proposal ? { planId: proposal.planId, periodStart: proposal.periodStart, periodLabel: proposal.periodLabel } : {}),
      }));
      if (r) { setMade(r); onMade?.(r); void qc.invalidateQueries({ queryKey: ['cycles'] }); void qc.invalidateQueries({ queryKey: ['due-runs'] }); void qc.invalidateQueries({ queryKey: ['cycle-plans'] }); }
    } finally { setBusy(false); }
  };

  const title = made ? t('ops.cycle.created') : proposal ? t('plans.launch.title') : anchor ? t('ops.cycle.title') : t('qmc.new.title');
  return (
    <Dialog labelledBy="cycle-dialog-title" size="lg" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="cycle-dialog-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">{title}{anchor && !made && <span className="ms-2 text-base font-normal text-muted-foreground" dir="auto">{anchor.label}</span>}</h2>
        <Button type="button" variant="ghost" aria-label={t('common.close')} onClick={onClose}>✕</Button>
      </div>

      {made ? (
        <LaunchReview made={made} setMade={setMade} apis={apis} onClose={onClose} onOpen={onOpen} />
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label={title}>
          <p className="text-sm text-muted-foreground">{anchor ? <><ContentText>{anchor.title}</ContentText>. {proposal ? t('plans.launch.intro', { period: proposal.periodLabel }) : t('ops.cycle.intro')}</> : t('qmc.new.intro')}</p>
          {proposal && <p className="text-sm" data-testid="proposal-facts"><span className="text-muted-foreground">{t('plans.launch.subject')}: </span><ContentText>{proposal.subjectName ?? proposal.anchorName ?? ''}</ContentText><span className="text-muted-foreground"> · {t('plans.launch.period')}: </span><ContentText>{proposal.periodLabel}</ContentText></p>}
          {!anchor && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={fieldCls}>{t('qmc.new.anchorKind')}
                <select aria-label={t('qmc.new.anchorKind')} className={selectCls} value={kind} onChange={(e) => { setKind(e.target.value as PickKind); setItemId(''); setTemplateId(''); }}>
                  {PICK_KINDS.map((k) => <option key={k} value={k}>{anchors[k]}</option>)}
                </select>
              </label>
              {kind !== 'institution' && (
                <label className={fieldCls}>{t('qmc.new.anchor')}
                  <select aria-label={t('qmc.new.anchor')} className={selectCls} value={itemId} onChange={(e) => setItemId(e.target.value)} required>
                    <option value="">{t('qmc.new.chooseAnchor')}</option>
                    {kind === 'org_unit' && dir.units.map((u) => <option key={u.id} value={u.id}>{u.nameEn}</option>)}
                    {kind === 'program' && dir.programs.map((p) => <option key={p.id} value={p.id}>{p.nameEn}{p.detail ? ` · ${p.detail}` : ''}</option>)}
                    {kind === 'requirement' && (standards.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.code} {r.title}</option>)}
                  </select>
                </label>
              )}
            </div>
          )}
          {noTemplates && <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="no-templates">{t('ops.cycle.noTemplates')}</p>}
          <label className={fieldCls}>{t('ops.cycle.template')}
            <select aria-label={t('ops.cycle.template')} className={selectCls} value={templateId} disabled={!!proposal} onChange={(e) => setTemplateId(e.target.value)}>
              {!proposal && <option value="">{t('ops.cycle.blank')}</option>}
              {fits.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label className={fieldCls}>{t('ops.cycle.subject')}
            <select aria-label={t('ops.cycle.subject')} required={!anchorIsPlace && !unitId} className={selectCls} value={subject} disabled={!!proposal} onChange={(e) => setSubject(e.target.value)}>
              <option value="">{anchorIsPlace ? t('qmc.new.subjectSame') : t('ops.cycle.chooseSubject')}</option>
              {proposal?.subjectKind === 'institution' && <option value={defaultSubject}>{proposal.subjectName}</option>}
              <optgroup label={t('ops.cycle.units')}>{dir.units.map((u) => <option key={u.id} value={`org_unit:${u.id}`}>{u.nameEn}</option>)}</optgroup>
              <optgroup label={t('ops.cycle.programs')}>{dir.programs.map((p) => <option key={p.id} value={`program:${p.id}`}>{p.nameEn}{p.detail ? ` · ${p.detail}` : ''}</option>)}</optgroup>
            </select>
          </label>
          {(anchorKind === 'institution' || anchorKind === 'requirement') && !subject && (
            <label className={fieldCls}>{t('qmc.new.unit')}
              <select aria-label={t('qmc.new.unit')} required className={selectCls} value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                <option value="">{t('qmc.new.chooseUnit')}</option>
                {dir.units.map((u) => <option key={u.id} value={u.id}>{u.nameEn}</option>)}
              </select>
            </label>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={fieldCls}>{t('ops.cycle.start')}<Input type="date" required aria-label={t('ops.cycle.start')} value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
            <label className={fieldCls}>{t('ops.cycle.lead')}
              <select aria-label={t('ops.cycle.lead')} className={selectCls} value={lead} onChange={(e) => setLead(e.target.value)}>
                {dir.people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
              </select>
            </label>
          </div>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!canSubmit}>{t('ops.cycle.create')}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/**
 * Step 2: what the template's rules resolved. Each stage's unit and owner (and each approval's approver) can be chosen here; the ones
 * that could not be resolved are flagged. A change is made at once (and can be undone from the toast).
 */
function LaunchReview({ made, setMade, apis, onClose, onOpen }: { made: CycleDetail; setMade: (c: CycleDetail) => void; apis: CycleApis; onClose: () => void; onOpen?: ((id: string) => void) | undefined }) {
  const { t } = useTranslation();
  const api = useCyclesApi(apis.cycles);
  const dir = useDirectory(apis);
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = useAction(setError);
  const unresolved = made.stages.filter((s) => s.unitUnresolved || s.ownerUnresolved).length + made.stages.flatMap((s) => s.outputs).filter((o) => o.kind === 'approval' && o.approverUnresolved).length;

  const run = async (fn: () => Promise<CycleDetail>) => {
    setBusy(true); setError('');
    try {
      const r = await act(fn);
      if (r) { setMade(r); void qc.invalidateQueries({ queryKey: ['cycles'] }); void qc.setQueryData(['cycle', r.id], r); }
      return r;
    } finally { setBusy(false); }
  };
  const start = async () => {
    const r = await run(() => api.activate(made.id));
    if (r) { onClose(); onOpen?.(r.id); }
  };
  return (
    <div className="space-y-3" data-testid="launch-review">
      <p className="text-sm"><ContentText className="font-medium">{made.title}</ContentText> {t('ops.cycle.createdDraft')}</p>
      <p className="text-sm text-muted-foreground">{t('qmc.launch.check')}</p>
      {unresolved > 0
        ? <p role="note" data-testid="unresolved-note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">{t('ops.cycle.unresolved', { count: unresolved })}</p>
        : made.stages.length > 0 && <p role="status" className="text-sm text-emerald-800">{t('qmc.launch.allResolved')}</p>}
      {made.stages.length === 0 && <p className="text-sm text-muted-foreground" data-testid="blank-note">{t('qmc.launch.blank')}</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <ol className="space-y-2" aria-label={t('qmc.launch.stages')}>
        {made.stages.map((s, i) => (
          <li key={s.id} data-testid="launch-stage" className="space-y-2 rounded-lg border border-border p-3">
            <p className="min-w-0 break-words text-sm font-medium" dir="auto">{i + 1}. {s.name}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <PersonOrUnit stage={s} dir={dir} busy={busy} onUnit={(id) => void run(() => api.updateStage(s.id, { responsibleUnitId: id }))} onOwner={(id) => void run(() => api.updateStage(s.id, { ownerUserId: id }))} />
            </div>
            {s.outputs.filter((o) => o.kind === 'approval').map((o) => (
              <label key={o.id} className={fieldCls}>
                <span className="flex flex-wrap items-center gap-2">{t('qmc.launch.approverOf', { name: o.name })}{o.approverUnresolved && <Chip tone="warn" testId="unresolved-approver">{t('qmc.launch.notFound')}</Chip>}</span>
                <select aria-label={t('qmc.launch.approverOf', { name: o.name })} className={selectCls} disabled={busy} value={o.approverUserId ?? ''}
                  onChange={(e) => void run(() => api.updateOutput(o.id, { approverUserId: e.target.value || null }))}>
                  <option value="">{t('qmc.choosePerson')}</option>
                  {dir.people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                </select>
              </label>
            ))}
          </li>
        ))}
      </ol>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
        <Button type="button" variant="ghost" onClick={onClose}>{t('qmc.launch.keepDraft')}</Button>
        <Link to="/quality-management/cycles/$id" params={{ id: made.id }} className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted" onClick={onClose}>{t('qmc.launch.open')}</Link>
        <Button type="button" disabled={busy || made.stages.length === 0} onClick={() => void start()}>{t('qmc.launch.start')}</Button>
      </div>
    </div>
  );
}

/** The unit and owner selects of one stage, each flagged while the template's rule could not settle it. */
export function PersonOrUnit({ stage, dir, busy, onUnit, onOwner }: { stage: CycleStage; dir: ReturnType<typeof useDirectory>; busy: boolean; onUnit: (id: string) => void; onOwner: (id: string | null) => void }) {
  const { t } = useTranslation();
  const units = dir.units.some((u) => u.id === stage.responsibleUnitId) ? dir.units : [...dir.units, { id: stage.responsibleUnitId, nameEn: stage.responsibleUnitName ?? '', nameAr: null, detail: null }];
  return (
    <>
      <label className={fieldCls}>
        <span className="flex flex-wrap items-center gap-2">{t('qmc.stage.unit')}{stage.unitUnresolved && <Chip tone="warn" testId="unresolved-unit">{t('qmc.launch.notFound')}</Chip>}</span>
        <select aria-label={t('qmc.launch.unitOf', { name: stage.name })} className={selectCls} disabled={busy} value={stage.responsibleUnitId} onChange={(e) => onUnit(e.target.value)}>
          {units.map((u) => <option key={u.id} value={u.id}>{u.nameEn}</option>)}
        </select>
      </label>
      <label className={fieldCls}>
        <span className="flex flex-wrap items-center gap-2">{t('qmc.stage.owner')}{stage.ownerUnresolved && <Chip tone="warn" testId="unresolved-owner">{t('qmc.launch.notFound')}</Chip>}</span>
        <select aria-label={t('qmc.launch.ownerOf', { name: stage.name })} className={selectCls} disabled={busy} value={stage.ownerUserId ?? ''} onChange={(e) => onOwner(e.target.value || null)}>
          <option value="">{t('qmc.choosePerson')}</option>
          {dir.people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
        </select>
      </label>
    </>
  );
}
