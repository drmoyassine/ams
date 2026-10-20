// The recurrence engine (TASK-081): given a plan's recurrence, its first start and the academic calendar, the periods (and so the run
// dates and labels) over any horizon. Pure: no database, no clock, no accreditor identity (DEC-002).
//
//   { every: n, unit: 'term' }   every n-th term of the calendar from the first one that has not ended before the first start;
//                                label = the term's name ("Fall 2026").
//   { every: n, unit: 'year' }   every n-th year of the calendar, a run covering n years in a row; label = the year's name
//                                ("AY2026-27") or, over several years, the span ("2026-2032").
//   { every: n, unit: 'month' }  every n months from the first start; label "Oct 2026" (several: "Oct 2026 – Mar 2027").
//   { after: 'previous_ends', setBy: 'decision' }
//                                the first run at the first start, the others at the dates a person set (an accreditor's decision
//                                fixes the next review); label "2026-2032" once the next date is known, otherwise "2026".
//
// Nothing is guessed: where the horizon reaches past what the calendar defines, the answer says so with a gap ("no term defined for
// that period"), it does not invent a term.
import type { Period, PeriodGap, CycleRecurrence } from '@ams/shared';

export interface CalendarEntry { name: string; kind: 'term' | 'year'; start: string; end: string }
export interface Horizon { from: string; to: string }
export interface PeriodsResult { periods: Period[]; gaps: PeriodGap[] }

const MS = 86_400_000;
const parse = (d: string) => new Date(`${d}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const plusDays = (d: string, n: number) => fmt(new Date(parse(d).getTime() + n * MS));
const year = (d: string) => d.slice(0, 4);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `n` months after a date, keeping the day of the month where the month has it and otherwise its last day. */
export function plusMonths(d: string, n: number): string {
  const base = parse(d);
  const total = base.getUTCFullYear() * 12 + base.getUTCMonth() + n;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(y, m, Math.min(base.getUTCDate(), last))));
}
const monthLabel = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${year(d)}`;

const inHorizon = (start: string, end: string | null, h: Horizon) => start <= h.to && (end === null || end >= h.from);

function fromCalendar(rec: { every: number; unit: 'term' | 'year' }, firstStart: string, calendar: readonly CalendarEntry[], h: Horizon): PeriodsResult {
  const entries = calendar.filter((e) => e.kind === rec.unit && e.end >= firstStart).sort((a, b) => a.start.localeCompare(b.start));
  const periods: Period[] = [];
  let i = 0;
  const n = rec.every;
  if (rec.unit === 'term') {
    for (; i < entries.length; i += n) {
      const e = entries[i]!;
      if (inHorizon(e.start, e.end, h)) periods.push({ start: e.start, end: e.end, label: e.name });
    }
  } else {
    for (; i + n <= entries.length; i += n) {
      const first = entries[i]!;
      const last = entries[i + n - 1]!;
      if (inHorizon(first.start, last.end, h)) periods.push({ start: first.start, end: last.end, label: n === 1 ? first.name : `${year(first.start)}-${year(last.end)}` });
    }
  }
  // Where the next period would begin, if the calendar had it: a partly defined span begins at its first year, otherwise after the last entry.
  const last = entries[entries.length - 1];
  const nextStart = entries.length === 0 ? firstStart : i < entries.length ? entries[i]!.start : plusDays(last!.end, 1);
  const gaps: PeriodGap[] = [];
  if (nextStart <= h.to) gaps.push({ from: nextStart > h.from ? nextStart : h.from, to: h.to, reason: rec.unit === 'term' ? 'no_term' : 'no_year' });
  return { periods, gaps };
}

function fromMonths(rec: { every: number }, firstStart: string, h: Horizon): PeriodsResult {
  const periods: Period[] = [];
  for (let k = 0; k < 2000; k += 1) {
    const start = plusMonths(firstStart, k * rec.every);
    if (start > h.to) break;
    const end = plusDays(plusMonths(firstStart, (k + 1) * rec.every), -1);
    if (!inHorizon(start, end, h)) continue;
    periods.push({ start, end, label: rec.every === 1 ? monthLabel(start) : `${monthLabel(start)} – ${monthLabel(end)}` });
  }
  return { periods, gaps: [] };
}

function fromDecisions(rec: { dates?: string[] | undefined }, firstStart: string, h: Horizon): PeriodsResult {
  const dates = [...new Set([firstStart, ...(rec.dates ?? []).filter((d) => d > firstStart)])].sort();
  const periods: Period[] = [];
  dates.forEach((start, i) => {
    const next = dates[i + 1];
    const end = next ? plusDays(next, -1) : null;
    if (inHorizon(start, end, h)) periods.push({ start, end, label: next ? `${year(start)}-${year(next)}` : year(start) });
  });
  // After the last date nothing is known until a person sets the next one.
  const gaps: PeriodGap[] = dates[dates.length - 1]! <= h.to ? [{ from: dates[dates.length - 1]! > h.from ? dates[dates.length - 1]! : h.from, to: h.to, reason: 'no_date' }] : [];
  return { periods, gaps };
}

/** The periods of a recurrence that touch the horizon (end on or after `from`, start on or before `to`), in order, and the stretches the calendar leaves undefined. */
export function periodsFor(recurrence: CycleRecurrence, firstStart: string, calendar: readonly CalendarEntry[], horizon: Horizon): PeriodsResult {
  if ('after' in recurrence) return fromDecisions(recurrence, firstStart, horizon);
  if (recurrence.unit === 'month') return fromMonths(recurrence, firstStart, horizon);
  return fromCalendar({ every: recurrence.every, unit: recurrence.unit }, firstStart, calendar, horizon);
}
