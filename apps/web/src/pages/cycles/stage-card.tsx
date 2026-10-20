// One stage of a cycle: who is responsible (unit and owner), when, its status, what it reads (inputs, missing ones flagged and never
// blocking), the process (instructions and a checklist) and what it produces (output slots), with the stage's own actions: start,
// complete (says what is missing), skip with a reason, reopen, and - for people who manage the cycle - edit. While the cycle is a draft
// it can also be built by hand: add an output or an input, remove the stage.
import { useState } from 'react';
import { can } from '../../lib/me';
import type { CycleStage } from '@ams/shared';
import { useConfirm } from '../../components/confirm-dialog';
import { Button } from '../../components/ui/button';
import { Chip, STAGE_TONE, day, dayOfStamp, stageStatusLabels } from '../../components/cycles/labels';
import { useTranslation } from '../../i18n';
import type { T } from '../settings/quality-management/labels';
import { AddInputDialog, AddOutputDialog } from './draft-dialogs';
import { EditStageDialog, ReasonDialog } from './dialogs';
import type { CycleEnv } from './env';
import { InputRow } from './input-row';
import { OutputSlot } from './output-slot';

const small = 'px-3 py-1';

export function StageCard({ stage, index, env, open, onToggle }: { stage: CycleStage; index: number; env: CycleEnv; open: boolean; onToggle: () => void }) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const confirm = useConfirm();
  const { cycle, api, busy, run, dir, me } = env;
  const [dialog, setDialog] = useState<'edit' | 'skip' | 'output' | 'input' | null>(null);
  const [explain, setExplain] = useState<string[] | null>(null);
  const statuses = stageStatusLabels(t);
  const draft = cycle.status === 'draft';
  const closed = cycle.status === 'completed' || cycle.status === 'cancelled';
  const own = !!me?.userId && stage.ownerUserId === me.userId;
  const mayReopen = cycle.status === 'active' || cycle.status === 'completed' ? (env.manage || own || can(me, 'cycle:work')) : false;
  const err = env.error && env.error.at === stage.id ? env.error.text : '';
  const missingRequired = stage.outputs.filter((o) => o.required && o.state !== 'final');
  const nameOf = (id: string | null) => dir.personName(id);

  const complete = () => {
    // Say what is missing instead of sending a request that will be refused.
    if (missingRequired.length) { setExplain(missingRequired.map((o) => o.name)); return; }
    setExplain(null);
    void run(() => api.completeStage(stage.id), { at: stage.id });
  };
  const removeStage = async () => {
    if (!(await confirm({ title: t('qmc.stage.removeTitle', { name: stage.name }), message: t('qmc.stage.removeMessage'), confirmLabel: t('common.remove'), tone: 'danger' }))) return;
    await run(() => api.deleteStage(stage.id), { at: stage.id });
  };

  return (
    <li id={`stage-${stage.id}`} data-testid="stage-card" data-status={stage.status} aria-label={t('qmc.stage.cardLabel', { name: stage.name })} className="scroll-mt-4 rounded-lg border border-border">
      <div className="space-y-2 p-3 sm:p-4">
        <div className="flex flex-wrap items-start gap-2">
          <button type="button" aria-expanded={open} aria-label={t(open ? 'qmc.stage.hideNamed' : 'qmc.stage.showNamed', { name: stage.name })} onClick={onToggle}
            className="min-w-0 flex-1 text-start">
            <span className="break-words text-base font-medium" dir="auto">{index + 1}. {stage.name}</span>
            {stage.nameAr && <span className="block break-words text-sm text-muted-foreground" dir="auto">{stage.nameAr}</span>}
          </button>
          <div className="flex flex-wrap items-center gap-1">
            <Chip tone={STAGE_TONE[stage.status]} testId="stage-status">{statuses[stage.status]}</Chip>
            {stage.late && <Chip tone="bad" testId="stage-late">{t('qmc.late')}</Chip>}
          </div>
        </div>
        <dl className="grid gap-x-5 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex min-w-0 flex-wrap gap-1"><dt className="text-muted-foreground">{t('qmc.stage.owner')}:</dt>
            <dd className="min-w-0 break-words" dir="auto" data-testid="stage-owner">{stage.ownerName ?? <Chip tone="warn" testId="owner-missing">{t('qmc.stage.noOwner')}</Chip>}
              {stage.ownerUserId && <> <Chip tone="neutral" testId="owner-source">{stage.ownerUserId === cycle.leadUserId ? t('qmc.stage.ownerFollows') : t('qmc.stage.ownerOwn')}</Chip></>}</dd></div>
          <div className="flex gap-1"><dt className="text-muted-foreground">{t('qmc.stage.starts')}:</dt><dd>{day(stage.startDate) || t('qmc.noDate')}</dd></div>
          <div className="flex gap-1"><dt className="text-muted-foreground">{t('qmc.stage.ends')}:</dt><dd>{day(stage.endDate) || t('qmc.noDate')}</dd></div>
        </dl>
        {stage.status === 'skipped' && stage.skipReason && <p className="break-words text-sm" data-testid="skip-reason"><span className="text-muted-foreground">{t('qmc.stage.skipReason')}: </span><span dir="auto">{stage.skipReason}</span></p>}
        {!open && stage.outputs.length > 0 && (
          <p className="text-xs text-muted-foreground">{t('qmc.stage.outputsSummary', { done: stage.outputs.filter((o) => o.state === 'final').length, count: stage.outputs.length })}</p>
        )}
      </div>

      {open && (
        <div className="space-y-4 border-t border-border p-3 sm:p-4">
          {err && <p role="alert" className="text-sm text-red-700">{err}</p>}

          <section aria-label={t('qmc.in.title')} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold">{t('qmc.in.title')}</h4>
              {draft && env.manage && <Button type="button" variant="outline" className={small} onClick={() => setDialog('input')}>{t('qmc.addInput.open')}</Button>}
            </div>
            {stage.inputs.length === 0 ? <p className="text-sm text-muted-foreground">{t('qmc.in.none')}</p> : (
              <>
                {stage.inputs.some((i) => !i.satisfied && i.required) && <p className="text-xs text-muted-foreground">{t('qmc.in.neverBlocks')}</p>}
                <ul className="space-y-2">{stage.inputs.map((i) => <InputRow key={i.id} input={i} stage={stage} env={env} />)}</ul>
              </>
            )}
          </section>

          <section aria-label={t('qmc.process.title')} className="space-y-2">
            <h4 className="text-sm font-semibold">{t('qmc.process.title')}</h4>
            {stage.process ? <p className="whitespace-pre-wrap break-words text-sm" dir="auto" data-testid="process-text">{stage.process}</p> : <p className="text-sm text-muted-foreground">{t('qmc.process.none')}</p>}
            {stage.checklist.length > 0 && (
              <ul className="space-y-1" aria-label={t('qmc.process.checklist')}>
                {stage.checklist.map((item, i) => {
                  const mayTick = cycle.status === 'active' && stage.canWork && (stage.status === 'not_started' || stage.status === 'in_progress');
                  return (
                    <li key={i} className="flex items-start gap-2 text-sm" data-testid="checklist-item">
                      <input type="checkbox" className="mt-1 shrink-0" checked={item.done} disabled={busy || !mayTick} aria-label={item.text}
                        onChange={(e) => void run(() => api.toggleChecklist(stage.id, i, e.target.checked), { at: stage.id })} />
                      <span className="min-w-0">
                        <span className="break-words" dir="auto">{item.text}</span>
                        {item.done && <span className="block text-xs text-muted-foreground">{t('qmc.process.tickedBy', { name: nameOf(item.doneBy) ?? t('qmc.unknownPerson'), date: dayOfStamp(item.doneAt) })}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-label={t('qmc.out.title')} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold">{t('qmc.out.title')}</h4>
              {draft && env.manage && <Button type="button" variant="outline" className={small} onClick={() => setDialog('output')}>{t('qmc.addOutput.open')}</Button>}
            </div>
            {stage.outputs.length === 0 ? <p className="text-sm text-muted-foreground">{t('qmc.out.none')}</p> : <ul className="space-y-2">{stage.outputs.map((o) => <OutputSlot key={o.id} o={o} stage={stage} env={env} />)}</ul>}
          </section>

          {explain && (
            <div role="alert" data-testid="complete-explain" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
              <p>{t('qmc.stage.cannotComplete')}</p>
              <ul className="list-disc ps-5">{explain.map((n) => <li key={n} dir="auto">{n}</li>)}</ul>
            </div>
          )}

          {!closed && (
            <div className="flex flex-wrap gap-2" role="group" aria-label={t('qmc.stage.actions')}>
              {cycle.status === 'active' && stage.canWork && stage.status === 'not_started' && <Button type="button" disabled={busy} aria-label={t('qmc.stage.startNamed', { name: stage.name })} onClick={() => void run(() => api.startStage(stage.id), { at: stage.id })}>{t('qmc.stage.start')}</Button>}
              {cycle.status === 'active' && stage.canWork && stage.status === 'in_progress' && <Button type="button" disabled={busy} aria-label={t('qmc.stage.completeNamed', { name: stage.name })} onClick={complete}>{t('qmc.stage.complete')}</Button>}
              {cycle.status === 'active' && stage.canWork && (stage.status === 'not_started' || stage.status === 'in_progress') && <Button type="button" variant="outline" disabled={busy} aria-label={t('qmc.stage.skipNamed', { name: stage.name })} onClick={() => setDialog('skip')}>{t('qmc.stage.skip')}</Button>}
              {mayReopen && (stage.status === 'completed' || stage.status === 'skipped') && <Button type="button" variant="outline" disabled={busy} aria-label={t('qmc.stage.reopenNamed', { name: stage.name })} onClick={() => void run(() => api.reopenStage(stage.id), { at: stage.id })}>{t('qmc.stage.reopen')}</Button>}
              {env.manage && <Button type="button" variant="outline" disabled={busy} aria-label={t('qmc.stage.editNamed', { name: stage.name })} onClick={() => setDialog('edit')}>{t('qmc.stage.edit')}</Button>}
              {draft && env.manage && <Button type="button" variant="ghost" className="text-red-700" disabled={busy} aria-label={t('qmc.stage.removeNamed', { name: stage.name })} onClick={() => void removeStage()}>{t('common.remove')}</Button>}
            </div>
          )}
          {closed && mayReopen && (stage.status === 'completed' || stage.status === 'skipped') && cycle.status === 'completed' && (
            <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy} aria-label={t('qmc.stage.reopenNamed', { name: stage.name })} onClick={() => void run(() => api.reopenStage(stage.id), { at: stage.id })}>{t('qmc.stage.reopen')}</Button></div>
          )}
        </div>
      )}

      {dialog === 'edit' && (
        <EditStageDialog stage={stage} cycleOwner={{ id: cycle.leadUserId, name: cycle.leadName }} dir={dir} busy={busy} error={err} onClose={() => setDialog(null)}
          onSubmit={(v) => void run(() => api.updateStage(stage.id, v), { at: stage.id }).then((r) => { if (r) setDialog(null); })} />
      )}
      {dialog === 'skip' && (
        <ReasonDialog title={t('qmc.stage.skipTitle', { name: stage.name })} intro={t('qmc.stage.skipIntro')} label={t('qmc.stage.skipReason')} confirm={t('qmc.stage.skip')} busy={busy} error={err} onClose={() => setDialog(null)}
          onSubmit={(reason) => void run(() => api.skipStage(stage.id, reason), { at: stage.id }).then((r) => { if (r) setDialog(null); })} />
      )}
      {dialog === 'output' && (
        <AddOutputDialog stage={stage} dir={dir} busy={busy} error={err} onClose={() => setDialog(null)}
          onSubmit={(v) => void run(() => api.addOutput(stage.id, v), { at: stage.id }).then((r) => { if (r) setDialog(null); })} />
      )}
      {dialog === 'input' && (
        <AddInputDialog cycle={cycle} stage={stage} busy={busy} error={err} onClose={() => setDialog(null)}
          onSubmit={(v) => void run(() => api.addInput(stage.id, v), { at: stage.id }).then((r) => { if (r) setDialog(null); })} />
      )}
    </li>
  );
}
