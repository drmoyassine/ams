// One output slot of a stage: a note (edit), a document (upload, replace, download), an approval (decided only by the named approver:
// "Internally approved", "Internally approved with conditions", "Returned for changes"; a comment is required for the last two) or a
// report (a stub until the report engine exists: it says so, and can be marked final by hand). Each shows its state: missing, draft, final.
import { useEffect, useState } from 'react';
import type { CycleDecision, CycleOutput, CycleStage } from '@ams/shared';
import { Button } from '../../components/ui/button';
import { Chip, OUTPUT_TONE, dayOfStamp, decisionLabels, fieldCls, outputStateLabels, selectCls } from '../../components/cycles/labels';
import { useTranslation } from '../../i18n';
import { formatBytes } from '../../lib/intl';
import type { T } from '../settings/quality-management/labels';
import { kindLabels } from '../settings/quality-management/labels';
import type { CycleEnv } from './env';

const small = 'px-3 py-1';

export function OutputSlot({ o, stage, env }: { o: CycleOutput; stage: CycleStage; env: CycleEnv }) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const { cycle, run, busy } = env;
  const draft = cycle.status === 'draft';
  const open = cycle.status === 'active' && stage.canWork && stage.status === 'in_progress';
  const fillable = open && o.state !== 'final';
  const states = outputStateLabels(t);
  const hint = !open && cycle.status === 'active' && o.state !== 'final' && stage.status === 'not_started' && stage.canWork ? t('qmc.out.startFirst') : null;
  return (
    <li data-testid="output-slot" data-kind={o.kind} data-state={o.state} className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 break-words text-sm font-medium" dir="auto">{o.name}</p>
        <Chip tone="neutral">{kindLabels(t)[o.kind]}</Chip>
        <Chip tone={OUTPUT_TONE[o.state]} testId="output-state">{states[o.state]}</Chip>
        {!o.required && <span className="text-xs text-muted-foreground">{t('qmc.out.optional')}</span>}
        {draft && env.manage && (
          <Button type="button" variant="ghost" className={`${small} ms-auto text-red-700`} disabled={busy} aria-label={t('qmc.out.removeNamed', { name: o.name })} onClick={() => void run(() => env.api.deleteOutput(o.id), { at: stage.id })}>{t('common.remove')}</Button>
        )}
      </div>
      {o.kind === 'note' && <NoteBody o={o} env={env} fillable={fillable} open={open} stageId={stage.id} />}
      {o.kind === 'document' && <DocumentBody o={o} env={env} fillable={fillable} open={open} stageId={stage.id} />}
      {o.kind === 'report' && <ReportBody o={o} env={env} fillable={fillable} open={open} stageId={stage.id} />}
      {o.kind === 'approval' && <ApprovalBody o={o} stage={stage} env={env} />}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </li>
  );
}

interface BodyProps { o: CycleOutput; env: CycleEnv; fillable: boolean; open: boolean; stageId: string }

/** "Mark final" and "Reopen" buttons, the same for every kind that is not an approval. */
function FinalButtons({ o, env, fillable, open, stageId, canFinal }: BodyProps & { canFinal: boolean }) {
  const { t } = useTranslation();
  const { run, busy, api } = env;
  return (
    <>
      {fillable && o.state !== 'final' && <Button type="button" variant="outline" className={small} disabled={busy || !canFinal} aria-label={t('qmc.out.markFinalNamed', { name: o.name })} onClick={() => void run(() => api.finalizeOutput(o.id), { at: stageId })}>{t('qmc.out.markFinal')}</Button>}
      {open && o.state === 'final' && <Button type="button" variant="outline" className={small} disabled={busy} aria-label={t('qmc.out.reopenNamed', { name: o.name })} onClick={() => void run(() => api.reopenOutput(o.id), { at: stageId })}>{t('qmc.out.reopen')}</Button>}
    </>
  );
}

function NoteBody({ o, env, fillable, open, stageId }: BodyProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(o.note ?? '');
  useEffect(() => { setText(o.note ?? ''); }, [o.note]);
  const { run, busy, api } = env;
  // A final note (or one nobody may edit now) is read-only until it is reopened.
  if (!fillable) {
    return (
      <div className="space-y-2">
        {o.note ? <p className="whitespace-pre-wrap break-words text-sm" dir="auto" data-testid="note-text">{o.note}</p> : <p className="text-sm text-muted-foreground">{t('qmc.out.noText')}</p>}
        <div className="flex flex-wrap gap-2"><FinalButtons o={o} env={env} fillable={fillable} open={open} stageId={stageId} canFinal /></div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <label className={fieldCls}>{o.name}
        <textarea aria-label={t('qmc.out.noteOf', { name: o.name })} dir="auto" rows={3} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className={small} disabled={busy || text === (o.note ?? '')} aria-label={t('qmc.out.saveNoteNamed', { name: o.name })} onClick={() => void run(() => api.setNote(o.id, text), { at: stageId })}>{t('qmc.out.saveNote')}</Button>
        <FinalButtons o={o} env={env} fillable={fillable} open={open} stageId={stageId} canFinal={!!o.note?.trim() && text === (o.note ?? '')} />
      </div>
    </div>
  );
}

function DocumentBody({ o, env, fillable, open, stageId }: BodyProps) {
  const { t } = useTranslation();
  const { run, busy, api } = env;
  return (
    <div className="space-y-2">
      {o.file
        ? (
          <p className="min-w-0 break-words text-sm" data-testid="file-line">
            <a className="underline" href={api.fileUrl(o.id)} download dir="auto">{o.file.name}</a>
            <span className="ms-2 text-xs text-muted-foreground">{formatBytes(o.file.size)}</span>
          </p>
        )
        : <p className="text-sm text-muted-foreground">{t('qmc.out.noFile')}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {fillable && (
          <label className="inline-flex cursor-pointer items-center rounded-md border border-border px-3 py-1 text-sm font-medium hover:bg-muted focus-within:ring-2 focus-within:ring-primary">
            {o.file ? t('qmc.out.replace') : t('qmc.out.upload')}
            <input type="file" className="sr-only" aria-label={t(o.file ? 'qmc.out.replaceNamed' : 'qmc.out.uploadNamed', { name: o.name })} disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run(() => api.uploadFile(o.id, f), { at: stageId }); }} />
          </label>
        )}
        {fillable && o.file && <Button type="button" variant="ghost" className={`${small} text-red-700`} disabled={busy} aria-label={t('qmc.out.removeFileNamed', { name: o.name })} onClick={() => void run(() => api.removeFile(o.id), { at: stageId })}>{t('qmc.out.removeFile')}</Button>}
        <FinalButtons o={o} env={env} fillable={fillable} open={open} stageId={stageId} canFinal={!!o.file} />
      </div>
    </div>
  );
}

/** A report output until the report engine exists (TASK-085): nothing to open, a manual "mark final" in the meantime. */
function ReportBody({ o, env, fillable, open, stageId }: BodyProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {o.reportPending && <p className="text-sm text-muted-foreground" data-testid="report-pending">{t('qmc.out.reportPending')}</p>}
      <div className="flex flex-wrap gap-2"><FinalButtons o={o} env={env} fillable={fillable} open={open} stageId={stageId} canFinal /></div>
    </div>
  );
}

const DECISIONS: CycleDecision[] = ['approved', 'approved_with_conditions', 'returned'];

function ApprovalBody({ o, stage, env }: { o: CycleOutput; stage: CycleStage; env: CycleEnv }) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const { run, busy, api, dir, cycle } = env;
  const [comment, setComment] = useState('');
  const [missing, setMissing] = useState(false);
  const labels = decisionLabels(t);
  const canChangeApprover = env.manage && o.state !== 'final' && (cycle.status === 'draft' || cycle.status === 'active');
  const people = dir.people.some((p) => p.id === o.approverUserId) || !o.approverUserId ? dir.people : [...dir.people, { id: o.approverUserId!, fullName: o.approverName ?? '', email: '' }];
  const decide = (decision: CycleDecision) => {
    if (decision !== 'approved' && !comment.trim()) { setMissing(true); return; }
    setMissing(false);
    void run(() => api.decide(o.id, { decision, ...(comment.trim() ? { comment: comment.trim() } : {}) }), { at: stage.id, notice: decision === 'returned' ? t('qmc.out.returnedNotice') : '' }).then((r) => { if (r) setComment(''); });
  };
  return (
    <div className="space-y-2">
      <p className="text-sm" data-testid="approver-line">
        <span className="text-muted-foreground">{t('qmc.out.approver')}: </span>
        {o.approverUserId ? <span dir="auto">{o.approverName}</span> : <Chip tone="warn" testId="approver-missing">{t('qmc.out.noApprover')}</Chip>}
      </p>
      {canChangeApprover && (
        <label className={fieldCls}>{t('qmc.out.changeApprover')}
          <select aria-label={t('qmc.out.approverOfNamed', { name: o.name })} className={selectCls} disabled={busy} value={o.approverUserId ?? ''} onChange={(e) => void run(() => api.updateOutput(o.id, { approverUserId: e.target.value || null }), { at: stage.id })}>
            <option value="">{t('qmc.choosePerson')}</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </select>
        </label>
      )}
      {o.decision && (
        <div className="rounded-md bg-muted p-2 text-sm" data-testid="decision" data-decision={o.decision}>
          <p className="font-medium">{labels[o.decision]}</p>
          {o.decisionComment && <p className="whitespace-pre-wrap break-words" dir="auto">{o.decisionComment}</p>}
          {o.state === 'final' && o.finalisedByName && <p className="text-xs text-muted-foreground">{t('qmc.out.decidedBy', { name: o.finalisedByName, date: dayOfStamp(o.finalisedAt) })}</p>}
        </div>
      )}
      {o.canDecide && (
        <div className="space-y-2 rounded-md border border-border p-2" data-testid="decision-panel">
          <label className={fieldCls}>{t('qmc.out.comment')}
            <textarea aria-label={t('qmc.out.commentOf', { name: o.name })} dir="auto" rows={2} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" value={comment} onChange={(e) => { setComment(e.target.value); setMissing(false); }} />
          </label>
          {missing && <p role="alert" className="text-sm text-red-700">{t('qmc.out.commentRequired')}</p>}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {DECISIONS.map((d) => <Button key={d} type="button" variant={d === 'approved' ? 'default' : 'outline'} disabled={busy} onClick={() => decide(d)}>{labels[d]}</Button>)}
          </div>
        </div>
      )}
      {!o.canDecide && o.state !== 'final' && o.approverUserId && cycle.status === 'active' && <p className="text-xs text-muted-foreground" data-testid="waiting-approver">{t('qmc.out.waiting', { name: o.approverName ?? '' })}</p>}
    </div>
  );
}
