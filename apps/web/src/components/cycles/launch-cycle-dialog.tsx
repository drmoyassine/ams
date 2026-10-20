// Launching a cycle (TASK-080, simplified by DEC-030, narrowed by DEC-031): "Review and launch" of a run a plan proposed (Cycles, Due to
// launch, and My work). Evidence is no longer collected by cycles (it has its own schedule, DEC-031), so no screen starts a new cycle from
// scratch any more: cycles for reports and Quality Assurance are coming, and plans that already exist still propose runs. The template,
// the item and the period are the plan's; the dialog asks the owner and the start date.
// The owner is the one person responsible: every stage follows them until it is given its own owner on the cycle page. The cycle is made
// as a DRAFT with its stages resolved from the template's rules; the review then shows only what the rules could not settle ("Choose an
// owner for stage X"; nothing is ever guessed) and "Start the cycle" activates it, or it stays a draft.
import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CycleDetail, DueRun, Me } from '@ams/shared';
import { useTranslation } from '../../i18n';
import { useCyclesApi } from '../../lib/cycles-api';
import { useAction } from '../../lib/use-action';
import { ContentText } from '../content-text';
import { Dialog } from '../dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useDirectory, type CycleApis } from './directory';
import { Chip, fieldCls, selectCls } from './labels';

const today = () => new Date().toISOString().slice(0, 10);
export function LaunchCycleDialog({ proposal, me, apis = {}, onClose, onOpen, onMade }: {
  me: Me | undefined; apis?: CycleApis;
  /** A run a plan proposed (TASK-081): the template, the item and the period are fixed; the owner and the start date can be changed. */
  proposal: DueRun;
  onClose: () => void; onOpen?: (cycleId: string) => void;
  /** Called when the cycle has been made (as a draft), before the person checks it. */
  onMade?: (cycle: CycleDetail) => void;
}) {
  const { t } = useTranslation();
  const api = useCyclesApi(apis.cycles);
  const dir = useDirectory(apis);
  const qc = useQueryClient();
  const [leadPick, setLeadPick] = useState('');
  const [startDate, setStartDate] = useState(proposal.periodStart > today() ? proposal.periodStart : today());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<CycleDetail | null>(null);
  const act = useAction(setError);

  const itemId = proposal.anchorId;
  const templates = useQuery({ queryKey: ['cycle-templates', 'published', proposal.anchorKind], queryFn: () => api.templates({ status: 'published', anchorKind: proposal.anchorKind }) });
  const fits = (templates.data ?? []).filter((x) => x.id === proposal.templateId);
  const templateId = proposal.templateId;
  // The owner: the one picked, else the plan's, else the person opening the dialog.
  const lead = leadPick || proposal.ownerUserId || me?.userId || '';
  const noTemplates = templates.data !== undefined && fits.length === 0;
  const itemName = proposal.anchorName ?? '';
  const canSubmit = !busy && !!itemId && !!templateId && !!lead && !!startDate;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setError('');
    try {
      const r = await act(() => api.launch({
        anchorKind: proposal.anchorKind, anchorId: itemId, startDate, templateId, leadUserId: lead,
        planId: proposal.planId, periodStart: proposal.periodStart, periodLabel: proposal.periodLabel,
        // A run of an older plan may name who it is about (a program) or a unit; a plan on an item names neither.
        ...(proposal.subjectKind && proposal.subjectId ? { subjectKind: proposal.subjectKind, subjectId: proposal.subjectId } : {}),
        ...(proposal.responsibleUnitId ? { responsibleUnitId: proposal.responsibleUnitId } : {}),
      }));
      if (r) {
        setMade(r); onMade?.(r);
        void qc.invalidateQueries({ queryKey: ['cycles'] }); void qc.invalidateQueries({ queryKey: ['due-runs'] }); void qc.invalidateQueries({ queryKey: ['cycle-plans'] }); void qc.invalidateQueries({ queryKey: ['my-work'] });
      }
    } finally { setBusy(false); }
  };

  const title = made ? t('ops.cycle.created') : t('plans.launch.title');
  return (
    <Dialog labelledBy="cycle-dialog-title" size="lg" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="cycle-dialog-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">{title}{itemName && !made && <span className="ms-2 text-base font-normal text-muted-foreground" dir="auto">{itemName}</span>}</h2>
        <Button type="button" variant="ghost" aria-label={t('common.close')} onClick={onClose}>✕</Button>
      </div>

      {made ? (
        <LaunchReview made={made} setMade={setMade} apis={apis} onClose={onClose} onOpen={onOpen} />
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label={title}>
          <p className="text-sm text-muted-foreground">{t('plans.launch.intro', { period: proposal.periodLabel })}</p>
          <p className="text-sm" data-testid="proposal-facts"><span className="text-muted-foreground">{t('plans.launch.subject')}: </span><ContentText>{proposal.subjectName ?? proposal.anchorName ?? ''}</ContentText><span className="text-muted-foreground"> · {t('plans.launch.period')}: </span><ContentText>{proposal.periodLabel}</ContentText></p>
          {noTemplates && <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="no-templates">{t('qmc.new.noTemplates')}</p>}
          <label className={fieldCls}>{t('qmc.new.template')}
            <select aria-label={t('qmc.new.template')} className={selectCls} value={templateId} disabled>
              {fits.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label className={fieldCls}>{t('qmc.new.evidence')}
            <select aria-label={t('qmc.new.evidence')} className={selectCls} value={itemId} disabled required>
              <option value={itemId}>{itemName}</option>
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={fieldCls}>{t('qmc.new.owner')}
              <select aria-label={t('qmc.new.owner')} className={selectCls} value={lead} onChange={(e) => setLeadPick(e.target.value)}>
                {dir.people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
              </select>
            </label>
            <label className={fieldCls}>{t('qmc.new.start')}<Input type="date" required aria-label={t('qmc.new.start')} value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
          </div>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!canSubmit}>{t('qmc.new.create')}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/**
 * Step 2: only what the template's rules could not settle. A stage with no owner and an approval with no approver are asked for in one
 * line each ("Choose an owner for stage X"); everything else follows the cycle's owner and is changed, if need be, on the cycle page.
 * A change is made at once (and can be undone from the toast).
 */
function LaunchReview({ made, setMade, apis, onClose, onOpen }: { made: CycleDetail; setMade: (c: CycleDetail) => void; apis: CycleApis; onClose: () => void; onOpen?: ((id: string) => void) | undefined }) {
  const { t } = useTranslation();
  const api = useCyclesApi(apis.cycles);
  const dir = useDirectory(apis);
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = useAction(setError);
  const needOwner = made.stages.filter((s) => s.ownerUnresolved);
  const needApprover = made.stages.flatMap((s) => s.outputs).filter((o) => o.kind === 'approval' && o.approverUnresolved);
  const unresolved = needOwner.length + needApprover.length;

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
    if (r) { void qc.invalidateQueries({ queryKey: ['my-work'] }); onClose(); onOpen?.(r.id); }
  };
  return (
    <div className="space-y-3" data-testid="launch-review">
      <p className="text-sm"><ContentText className="font-medium">{made.title}</ContentText> {t('ops.cycle.createdDraft')}</p>
      <p className="text-sm text-muted-foreground" data-testid="owner-cascade-note">{t('qmc.launch.check', { name: made.leadName ?? '' })}</p>
      {unresolved > 0
        ? <p role="note" data-testid="unresolved-note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">{t('ops.cycle.unresolved', { count: unresolved })}</p>
        : made.stages.length > 0 && <p role="status" className="text-sm text-emerald-800">{t('qmc.launch.allResolved')}</p>}
      {made.stages.length === 0 && <p className="text-sm text-muted-foreground" data-testid="blank-note">{t('qmc.launch.blank')}</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {unresolved > 0 && (
        <ul className="space-y-2" aria-label={t('qmc.launch.stages')}>
          {needOwner.map((s) => (
            <li key={s.id} data-testid="launch-stage" className="rounded-lg border border-border p-3">
              <label className={fieldCls}>
                <span className="flex flex-wrap items-center gap-2" dir="auto">{t('qmc.launch.chooseOwner', { name: s.name })}<Chip tone="warn" testId="unresolved-owner">{t('qmc.launch.notFound')}</Chip></span>
                <select aria-label={t('qmc.launch.ownerOf', { name: s.name })} className={selectCls} disabled={busy} value={s.ownerUserId ?? ''} onChange={(e) => void run(() => api.updateStage(s.id, { ownerUserId: e.target.value || null }))}>
                  <option value="">{t('qmc.choosePerson')}</option>
                  {dir.people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                </select>
              </label>
            </li>
          ))}
          {needApprover.map((o) => (
            <li key={o.id} data-testid="launch-approver" className="rounded-lg border border-border p-3">
              <label className={fieldCls}>
                <span className="flex flex-wrap items-center gap-2" dir="auto">{t('qmc.launch.approverOf', { name: o.name })}<Chip tone="warn" testId="unresolved-approver">{t('qmc.launch.notFound')}</Chip></span>
                <select aria-label={t('qmc.launch.approverOf', { name: o.name })} className={selectCls} disabled={busy} value={o.approverUserId ?? ''} onChange={(e) => void run(() => api.updateOutput(o.id, { approverUserId: e.target.value || null }))}>
                  <option value="">{t('qmc.choosePerson')}</option>
                  {dir.people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                </select>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
        <Button type="button" variant="ghost" onClick={onClose}>{t('qmc.launch.keepDraft')}</Button>
        <Link to="/quality-management/cycles/$id" params={{ id: made.id }} className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted" onClick={onClose}>{t('qmc.launch.open')}</Link>
        <Button type="button" disabled={busy || made.stages.length === 0} onClick={() => void start()}>{t('qmc.launch.start')}</Button>
      </div>
    </div>
  );
}
