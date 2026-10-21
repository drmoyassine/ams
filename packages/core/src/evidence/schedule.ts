// The schedule of an evidence item (TASK-089, DEC-031): when it is collected again. Pure: no database, no clock, no accreditor identity.
//
//   { every: 'day' | 'week' | 'month' | 'quarter' | 'year', startDate, dueAfterDays, timezone }
//       the occurrences are calendar dates counted from the start date (a month keeps the day of the month, or the last day of a
//       shorter month; a quarter is 3 months and a year 12), so a daylight saving change never moves them: the date is arithmetic on
//       the calendar and only then placed in time, at the local midnight that starts it, in the schedule's time zone.
//   { every: 'semester', ... }
//       the start of each TERM of the academic calendar (TASK-081) on or after the start date. Where the calendar has no term for the
//       time asked about, the answer says so with a gap: a term is never guessed.
//
// The job that fires a schedule, makes a run per period and asks the BI is TASK-090 (packages/core/src/collection/).
import type { Schedule } from '@ams/shared';
import { plusDays, plusMonths } from '../cycles/recurrence.js';

/** A year or term of the academic calendar, as the recurrence engine reads it. */
export interface CalendarTerm { name: string; kind: 'term' | 'year'; start: string; end: string }

export interface Occurrence {
  /** The local date the period starts (yyyy-mm-dd, in the schedule's time zone). */
  date: string;
  /** The instant that date begins in the time zone (ISO, UTC). */
  at: string;
  /** The local date the evidence is due: `date` plus `dueAfterDays`. */
  dueDate: string;
  /** The instant the due date ends in the time zone (the next local midnight), ISO UTC. */
  dueAt: string;
  /** A name for the period: "Oct 2026", "Fall 2026", "2026-10-19" … */
  label: string;
}
/** A stretch the calendar cannot place: a semester schedule with no term defined after `after`. */
export interface ScheduleGap { reason: 'no_term'; after: string }
export interface Occurrences { occurrences: Occurrence[]; gap: ScheduleGap | null }

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const parts = (d: string) => d.split('-').map(Number) as [number, number, number];
const days = (d: string) => { const [y, m, dd] = parts(d); return Date.UTC(y, m - 1, dd) / DAY; };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}
/** What the wall clock of `tz` shows at an instant, read as if it were UTC (ms). */
function wallClock(utc: number, tz: string): number {
  const p = formatter(tz).formatToParts(new Date(utc));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
}
const offsetMs = (utc: number, tz: string) => wallClock(utc, tz) - Math.floor(utc / 1000) * 1000;

/**
 * The instant a local date begins in a time zone (its midnight). Daylight saving safe: the offset on both sides of the day is tried.
 * Where the clocks repeat midnight the first one is taken; where midnight does not exist (clocks jump over it) the answer is the first
 * instant of that date.
 */
export function startOfLocalDay(date: string, tz: string): Date {
  const [y, m, d] = parts(date);
  const wall = Date.UTC(y, m - 1, d);
  const offsets = [...new Set([offsetMs(wall - DAY, tz), offsetMs(wall + DAY, tz)])];
  const candidates = offsets.map((o) => wall - o);
  const valid = candidates.filter((t) => wallClock(t, tz) === wall);
  return new Date(valid.length ? Math.min(...valid) : Math.max(...candidates));
}

/** The local date of an instant in a time zone. */
export function localDate(at: Date, tz: string): string {
  const p = formatter(tz).formatToParts(at);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** How many days apart two occurrences of each kind are at least (to know how far back a due window reaches). */
const STEP_DAYS = { day: 1, week: 7, month: 28, quarter: 89, semester: 1, year: 365 } as const;
/** The longest an occurrence can be from the previous one: where to start counting without skipping any. */
const LONGEST_STEP_DAYS = { day: 1, week: 7, month: 31, quarter: 92, semester: 1, year: 366 } as const;

function dateAt(s: Schedule, k: number): string {
  switch (s.every) {
    case 'day': return plusDays(s.startDate, k);
    case 'week': return plusDays(s.startDate, 7 * k);
    case 'month': return plusMonths(s.startDate, k);
    case 'quarter': return plusMonths(s.startDate, 3 * k);
    default: return plusMonths(s.startDate, 12 * k);
  }
}

function labelOf(s: Schedule, start: string, k: number): string {
  switch (s.every) {
    case 'day': return start;
    case 'week': return `Week of ${start}`;
    case 'month': return monthLabel(start);
    default: {
      const last = plusDays(dateAt(s, k + 1), -1);
      return s.every === 'year' && start.slice(5) === '01-01' ? start.slice(0, 4) : `${monthLabel(start)} – ${monthLabel(last)}`;
    }
  }
}

function occurrence(s: Schedule, date: string, label: string): Occurrence {
  const dueDate = plusDays(date, s.dueAfterDays);
  return {
    date, at: startOfLocalDay(date, s.timezone).toISOString(), dueDate, dueAt: startOfLocalDay(plusDays(dueDate, 1), s.timezone).toISOString(), label,
  };
}

/**
 * The next `count` occurrences of a schedule that begin at or after `from`, never before its start date. A semester schedule reads the
 * academic calendar's terms; where it has fewer than asked for, the rest is a `gap` ("no term defined after ..."), not a guess.
 */
export function nextOccurrences(schedule: Schedule, from: Date, count: number, terms: readonly CalendarTerm[] = []): Occurrences {
  const out: Occurrence[] = [];
  if (count <= 0) return { occurrences: out, gap: null };
  const fromAt = from.getTime();
  if (schedule.every === 'semester') {
    const list = terms.filter((t) => t.kind === 'term').sort((a, b) => a.start.localeCompare(b.start));
    for (const t of list) {
      if (t.start < schedule.startDate) continue;
      const o = occurrence(schedule, t.start, t.name);
      if (Date.parse(o.at) < fromAt) continue;
      out.push(o);
      if (out.length === count) return { occurrences: out, gap: null };
    }
    const lastEnd = list[list.length - 1]?.end;
    const after = [lastEnd, localDate(from, schedule.timezone), schedule.startDate].filter((x): x is string => !!x).sort().pop()!;
    return { occurrences: out, gap: { reason: 'no_term', after } };
  }
  // Start a little before the first possible one, so nothing is skipped by the estimate.
  const gone = Math.max(0, days(localDate(from, schedule.timezone)) - days(schedule.startDate));
  let k = Math.max(0, Math.floor(gone / LONGEST_STEP_DAYS[schedule.every]) - 2);
  for (let guard = 0; out.length < count && guard < 200_000; guard += 1, k += 1) {
    const date = dateAt(schedule, k);
    const o = occurrence(schedule, date, labelOf(schedule, date, k));
    if (Date.parse(o.at) >= fromAt) out.push(o);
  }
  return { occurrences: out, gap: null };
}

/**
 * When the next collection is due as of `now`: the due time of the earliest occurrence that has not yet ended, which may be the one
 * whose period began recently (its due date is still ahead). `gap` is set when a semester schedule has no term to place.
 */
export function nextDue(schedule: Schedule, now: Date, terms: readonly CalendarTerm[] = []): { dueAt: string | null; occurrence: Occurrence | null; gap: ScheduleGap | null } {
  const reach = schedule.dueAfterDays + 2;
  const needed = Math.ceil(reach / STEP_DAYS[schedule.every]) + 2;
  const { occurrences, gap } = nextOccurrences(schedule, new Date(now.getTime() - reach * DAY), needed, terms);
  const hit = occurrences.find((o) => Date.parse(o.dueAt) > now.getTime()) ?? null;
  // The gap begins where the calendar ends or, if that is already past, today: not at the start of the look-back.
  const today = localDate(now, schedule.timezone);
  return { dueAt: hit?.dueAt ?? null, occurrence: hit, gap: hit || !gap ? null : { ...gap, after: gap.after > today ? gap.after : today } };
}
