// The words and chips of the cycle screens for each value set (literal t() keys, so `pnpm i18n:extract` sees them). Internal approval
// is only ever worded "Internally approved" (DEC-005); nothing here says met, compliant or a score.
import type { ReactNode } from 'react';
import type { CycleDecision, CycleOutputState, CycleRefKind, CycleStageStatus, CycleStatus, CycleSubjectKind } from '@ams/shared';
import { formatDate } from '../../lib/intl';
import { cn } from '../../lib/utils';
import type { T } from '../../pages/settings/quality-management/labels';

export const cycleStatusLabels = (t: T): Record<CycleStatus, string> => ({
  draft: t('qmc.status.draft'), active: t('qmc.status.active'), completed: t('qmc.status.completed'), cancelled: t('qmc.status.cancelled'),
});
export const stageStatusLabels = (t: T): Record<CycleStageStatus, string> => ({
  not_started: t('qmc.stage.notStarted'), in_progress: t('qmc.stage.inProgress'), completed: t('qmc.stage.completed'), skipped: t('qmc.stage.skipped'),
});
export const outputStateLabels = (t: T): Record<CycleOutputState, string> => ({ missing: t('qmc.output.missing'), draft: t('qmc.output.draft'), final: t('qmc.output.final') });
/** "Internally approved", "Internally approved with conditions", "Returned for changes": an internal sign-off, never an official status (DEC-005). */
export const decisionLabels = (t: T): Record<CycleDecision, string> => ({
  approved: t('qmc.decision.approved'), approved_with_conditions: t('qmc.decision.conditions'), returned: t('qmc.decision.returned'),
});
export const refKindLabels = (t: T): Record<CycleRefKind, string> => ({ document: t('qmc.ref.document'), evidence_item: t('qmc.ref.evidence_item'), requirement: t('qmc.ref.requirement') });
export const subjectKindLabels = (t: T): Record<CycleSubjectKind, string> => ({ institution: t('qmc.subject.institution'), org_unit: t('qmc.subject.org_unit'), program: t('qmc.subject.program') });

const TONES = {
  neutral: 'border-border bg-muted text-muted-foreground',
  info: 'border-sky-300 bg-sky-50 text-sky-900',
  good: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  warn: 'border-amber-300 bg-amber-50 text-amber-900',
  bad: 'border-red-300 bg-red-50 text-red-900',
} as const;
export type Tone = keyof typeof TONES;

export const CYCLE_TONE: Record<CycleStatus, Tone> = { draft: 'neutral', active: 'info', completed: 'good', cancelled: 'bad' };
export const STAGE_TONE: Record<CycleStageStatus, Tone> = { not_started: 'neutral', in_progress: 'info', completed: 'good', skipped: 'neutral' };
export const OUTPUT_TONE: Record<CycleOutputState, Tone> = { missing: 'warn', draft: 'info', final: 'good' };

/** A small status chip: text always, colour as a help. */
export function Chip({ tone = 'neutral', children, testId, title }: { tone?: Tone; children: ReactNode; testId?: string; title?: string }) {
  return <span data-testid={testId} title={title} className={cn('inline-flex max-w-full items-center rounded border px-2 py-0.5 text-xs', TONES[tone])}>{children}</span>;
}

/** A calendar day ("2026-10-05") in the active language, never shifted by the time zone. */
export const day = (d: string | null | undefined): string => (d ? formatDate(`${d}T00:00:00Z`, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
/** The same, for the moment something happened. */
export const dayOfStamp = (iso: string | null | undefined): string => (iso ? formatDate(iso) : '');
export const fieldCls = 'flex flex-col gap-1 text-xs text-muted-foreground';
export const selectCls = 'w-full min-w-0 rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground';
