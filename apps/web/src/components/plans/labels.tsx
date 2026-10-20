// The words for cycle plans (TASK-081): a recurrence in a phrase, where a plan comes from, what an anchor is. Literal t() keys so
// `pnpm i18n:extract` sees them. A plan only PROPOSES runs (DEC-029); nothing here says met, compliant or a score (DEC-005).
import type { TFunction } from 'i18next';
import type { CycleRecurrence, PeriodGap, PlanAnchorKind } from '@ams/shared';
import { day } from '../cycles/labels';

/** "Every term", "Every 2 years", "Every 6 months", "When the previous one ends (date set by a decision)". */
export function recurrenceText(t: TFunction, r: CycleRecurrence | null | undefined): string {
  if (!r) return '';
  if ('after' in r) return t('plans.every.decision');
  if (r.unit === 'term') return r.every === 1 ? t('plans.every.term') : t('plans.every.terms', { count: r.every });
  if (r.unit === 'year') return r.every === 1 ? t('plans.every.year') : t('plans.every.years', { count: r.every });
  return r.every === 1 ? t('plans.every.month') : t('plans.every.months', { count: r.every });
}

export function planAnchorLabels(t: TFunction): Record<PlanAnchorKind, string> {
  return {
    institution: t('plans.anchor.institution'), org_unit: t('plans.anchor.org_unit'), program: t('plans.anchor.program'), framework: t('plans.anchor.framework'),
    requirement: t('plans.anchor.requirement'), evidence_item: t('plans.anchor.evidence_item'),
  };
}

/** The sentence for a stretch the calendar does not cover: said plainly, never guessed. */
export function gapText(t: TFunction, g: Pick<PeriodGap, 'from' | 'to' | 'reason'>): string {
  const what = g.reason === 'no_term' ? t('plans.gap.noTerm') : g.reason === 'no_year' ? t('plans.gap.noYear') : t('plans.gap.noDate');
  return g.reason === 'no_date' ? what : `${what} ${t('plans.gap.from', { from: day(g.from) })}`;
}
