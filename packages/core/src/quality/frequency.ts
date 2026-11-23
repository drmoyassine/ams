// The periods of a standard's frequency (DEC-048). Pure: no database. Dates are calendar dates (yyyy-mm-dd) in the rule's time zone;
// a period's evidence is due at the end of its due day there. Semesters come from the academic calendar's terms, never guessed.
import type { FrequencyRule } from '@ams/shared';
import { startOfLocalDay, type CalendarTerm } from '../evidence/schedule.js';

export interface Period { key: string; label: string; start: string; due: string; dueAt: Date }

const DAY = 86_400_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);
const weekdayOf = (d: string) => new Date(ms(d)).getUTCDay();
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');
const short = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]!.slice(0, 3)} ${d.slice(0, 4)}`;

/** The day of a month a rule names: a day (clamped to a shorter month) or the nth / last weekday. */
function dayIn(y: number, m: number, on: { day: number } | { nth: number; weekday: number }): string {
  if ('day' in on) return `${y}-${pad(m)}-${pad(Math.min(on.day, lastDayOfMonth(y, m)))}`;
  if (on.nth === -1) {
    const last = `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}`;
    return addDays(last, -((weekdayOf(last) - on.weekday + 7) % 7));
  }
  const first = `${y}-${pad(m)}-01`;
  return addDays(first, (on.weekday - weekdayOf(first) + 7) % 7 + (on.nth - 1) * 7);
}

/**
 * The periods whose due day falls between `from` and `to` (inclusive, calendar dates), oldest first, never before the rule's start
 * date. A semester period is a term of the calendar (kind "term"); its due day is the given weekday of week N counted from the
 * term's first day (or the last day of that week), kept inside the term.
 */
export function periodsBetween(rule: FrequencyRule, from: string, to: string, terms: readonly CalendarTerm[] = []): Period[] {
  const lo = from < rule.startDate ? rule.startDate : from;
  const out: Period[] = [];
  const push = (key: string, label: string, start: string, due: string) => { if (due >= lo && due <= to) out.push({ key, label, start, due, dueAt: startOfLocalDay(addDays(due, 1), rule.timezone) }); };
  switch (rule.every) {
    case 'day':
      for (let d = lo; d <= to; d = addDays(d, 1)) push(d, short(d), d, d);
      break;
    case 'week': {
      for (let d = addDays(lo, (rule.weekday - weekdayOf(lo) + 7) % 7); d <= to; d = addDays(d, 7)) push(`W${d}`, `Week ending ${short(d)}`, addDays(d, -6), d);
      break;
    }
    case 'month': {
      let y = Number(lo.slice(0, 4)); let m = Number(lo.slice(5, 7));
      for (; `${y}-${pad(m)}-01` <= to; m === 12 ? (y++, m = 1) : m++) push(`${y}-${pad(m)}`, `${MONTHS[m - 1]} ${y}`, `${y}-${pad(m)}-01`, dayIn(y, m, rule.on));
      break;
    }
    case 'year':
      for (let y = Number(lo.slice(0, 4)) - 1; `${y}-01-01` <= to; y++) {
        // The year runs from the day after last year's due day to this year's.
        push(String(y), String(y), addDays(dayIn(y - 1, rule.month, rule.on), 1), dayIn(y, rule.month, rule.on));
      }
      break;
    case 'semester':
      for (const t of [...terms].filter((x) => x.kind === 'term').sort((a, b) => a.start.localeCompare(b.start))) {
        const weekStart = addDays(t.start, (rule.week - 1) * 7);
        let due = rule.weekday === undefined ? addDays(weekStart, 6) : addDays(weekStart, (rule.weekday - weekdayOf(weekStart) + 7) % 7);
        if (due > t.end) due = t.end;
        push(`T${t.start}`, t.name, t.start, due);
      }
      break;
  }
  return out;
}
