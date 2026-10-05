// The due-rule engine (PRD 7.4). Pure functions on ISO calendar dates ("YYYY-MM-DD"), no clock, no database:
// the same inputs always give the same dates. Nothing here knows which accreditor a rule came from (DEC-002).
import type { DueRule } from '@ams/shared';

export type IsoDate = string;
export type KeyDates = Partial<Record<string, IsoDate | null>>;

const MS_PER_DAY = 86_400_000;
const toUtc = (iso: IsoDate): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`not an ISO date: ${iso}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (toIso(t) !== iso) throw new Error(`not a real calendar date: ${iso}`);
  return t;
};
const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const toIso = (t: number): IsoDate => {
  const d = new Date(t);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

export const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function addDays(iso: IsoDate, days: number): IsoDate {
  return toIso(toUtc(iso) + days * MS_PER_DAY);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtc(to) - toUtc(from)) / MS_PER_DAY);
}

/** `MM-DD` in a given year. 02-29 in a year without one falls on 02-28 (the last day of February). */
export function monthDayIn(year: number, monthDay: string): IsoDate {
  const [m, d] = monthDay.split('-').map(Number) as [number, number];
  const day = m === 2 && d === 29 && !isLeapYear(year) ? 28 : d;
  return toIso(Date.UTC(year, m - 1, day));
}

export interface DueContext {
  /** Calendar year of the on-site review (or the engagement's anchor year). */
  reviewYear: number;
  keyDates: KeyDates;
  /** Completion date of another milestone by template key, when it is done. */
  completedOn?: (milestoneKey: string) => IsoDate | null | undefined;
}

export interface ResolvedDue {
  dueDate: IsoDate | null;
  /** The rule needs a date that is not known yet; it resolves once the anchor is entered (PRD 7.4). */
  dateNeeded: boolean;
}

/**
 * Resolves one rule. `null` means "set manually": no date and nothing is needed. A rule whose anchor (a key date, or
 * the completion of another milestone) is missing gives no date and `dateNeeded`.
 */
export function resolveDueRule(rule: DueRule | undefined, ctx: DueContext): ResolvedDue {
  if (!rule) return { dueDate: null, dateNeeded: false };
  if ('fixed' in rule) return { dueDate: monthDayIn(ctx.reviewYear + rule.year_offset, rule.fixed), dateNeeded: false };
  const base = 'anchor' in rule ? ctx.keyDates[rule.anchor] : ctx.completedOn?.(rule.after);
  if (!base) return { dueDate: null, dateNeeded: true };
  return { dueDate: addDays(base, rule.offset_days), dateNeeded: false };
}

/**
 * The next `count` occurrences of a yearly recurrence on or after `from` (maintenance milestones keep the next two
 * materialised, PRD 7.4).
 */
export function nextOccurrences(recurrence: { every: 'year'; month_day: string }, from: IsoDate, count = 2): IsoDate[] {
  const out: IsoDate[] = [];
  let year = Number(from.slice(0, 4));
  while (out.length < count) {
    const d = monthDayIn(year, recurrence.month_day);
    if (d >= from) out.push(d);
    year += 1;
  }
  return out;
}

/** Overdue is computed, never stored: a past due date on a milestone that is neither done nor skipped. */
export function isOverdue(dueDate: IsoDate | null, status: string, today: IsoDate): boolean {
  return dueDate !== null && status !== 'done' && status !== 'skipped' && dueDate < today;
}
