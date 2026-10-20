// The schedule of an evidence item (TASK-089, DEC-031): the pure function that says when it falls due. No database.
import { describe, expect, it } from 'vitest';
import type { Schedule } from '@ams/shared';
import { localDate, nextDue, nextOccurrences, startOfLocalDay, type CalendarTerm } from './schedule.js';

const sched = (over: Partial<Schedule> = {}): Schedule => ({ every: 'month', startDate: '2026-01-15', dueAfterDays: 0, timezone: 'UTC', ...over });
const at = (iso: string) => new Date(iso);
const dates = (s: Schedule, from: string, n: number, terms: CalendarTerm[] = []) => nextOccurrences(s, at(from), n, terms).occurrences.map((o) => o.date);

describe('nextOccurrences: the calendar kinds', () => {
  it('day and week count from the start date', () => {
    expect(dates(sched({ every: 'day', startDate: '2026-10-20' }), '2026-10-22T00:00:00Z', 3)).toEqual(['2026-10-22', '2026-10-23', '2026-10-24']);
    expect(dates(sched({ every: 'week', startDate: '2026-10-20' }), '2026-10-21T00:00:00Z', 3)).toEqual(['2026-10-27', '2026-11-03', '2026-11-10']);
  });

  it('never gives a date before the start date, and starts at it when asked from earlier', () => {
    expect(dates(sched({ every: 'week', startDate: '2026-10-20' }), '2020-01-01T00:00:00Z', 2)).toEqual(['2026-10-20', '2026-10-27']);
  });

  it('a month keeps its day, or the last day of a shorter month, without drifting', () => {
    expect(dates(sched({ every: 'month', startDate: '2026-01-31' }), '2026-01-01T00:00:00Z', 5)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });

  it('a quarter is three months and a year twelve (29 February falls on 28 February in other years)', () => {
    expect(dates(sched({ every: 'quarter', startDate: '2026-11-30' }), '2026-01-01T00:00:00Z', 4)).toEqual(['2026-11-30', '2027-02-28', '2027-05-30', '2027-08-30']);
    expect(dates(sched({ every: 'year', startDate: '2024-02-29' }), '2024-01-01T00:00:00Z', 5)).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  });

  it('reaches far from the start date without walking every period', () => {
    const o = nextOccurrences(sched({ every: 'day', startDate: '2000-01-01' }), at('2026-10-20T00:00:00Z'), 2).occurrences;
    expect(o.map((x) => x.date)).toEqual(['2026-10-20', '2026-10-21']);
    expect(dates(sched({ every: 'month', startDate: '2000-01-31' }), '2026-10-20T00:00:00Z', 2)).toEqual(['2026-10-31', '2026-11-30']);
    expect(dates(sched({ every: 'year', startDate: '1990-05-01' }), '2026-10-20T00:00:00Z', 1)).toEqual(['2027-05-01']);
  });

  it('gives the due date and the instant it ends, and a name for the period', () => {
    const [o] = nextOccurrences(sched({ every: 'month', startDate: '2026-10-15', dueAfterDays: 10 }), at('2026-10-01T00:00:00Z'), 1).occurrences;
    expect(o).toEqual({ date: '2026-10-15', at: '2026-10-15T00:00:00.000Z', dueDate: '2026-10-25', dueAt: '2026-10-26T00:00:00.000Z', label: 'Oct 2026' });
    expect(nextOccurrences(sched({ every: 'year', startDate: '2026-01-01' }), at('2026-01-01T00:00:00Z'), 1).occurrences[0]!.label).toBe('2026');
    expect(nextOccurrences(sched({ every: 'quarter', startDate: '2026-10-01' }), at('2026-01-01T00:00:00Z'), 1).occurrences[0]!.label).toBe('Oct 2026 – Dec 2026');
  });

  it('asks for nothing when the count is zero', () => {
    expect(nextOccurrences(sched(), at('2026-01-01T00:00:00Z'), 0)).toEqual({ occurrences: [], gap: null });
  });
});

describe('nextOccurrences: time zones and daylight saving', () => {
  it('places a date at the local midnight that starts it', () => {
    expect(startOfLocalDay('2026-10-20', 'Asia/Dubai').toISOString()).toBe('2026-10-19T20:00:00.000Z');
    expect(startOfLocalDay('2026-10-20', 'UTC').toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(localDate(at('2026-10-19T21:00:00Z'), 'Asia/Dubai')).toBe('2026-10-20');
  });

  it('a weekly schedule stays on its weekday across the clocks going forward (London)', () => {
    const o = nextOccurrences(sched({ every: 'week', startDate: '2026-03-23', timezone: 'Europe/London' }), at('2026-03-01T00:00:00Z'), 3).occurrences;
    expect(o.map((x) => x.date)).toEqual(['2026-03-23', '2026-03-30', '2026-04-06']);
    // Midnight GMT, then midnight BST an hour earlier in UTC: the instants are 167 hours apart, the dates exactly a week.
    expect(o.map((x) => x.at)).toEqual(['2026-03-23T00:00:00.000Z', '2026-03-29T23:00:00.000Z', '2026-04-05T23:00:00.000Z']);
  });

  it('a daily schedule keeps one date per day across the clocks going back (New York)', () => {
    const o = nextOccurrences(sched({ every: 'day', startDate: '2026-10-30', timezone: 'America/New_York' }), at('2026-10-30T00:00:00Z'), 6).occurrences;
    expect(o.map((x) => x.date)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
    expect(o.map((x) => x.at)).toEqual([
      '2026-10-30T04:00:00.000Z', '2026-10-31T04:00:00.000Z', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', '2026-11-03T05:00:00.000Z', '2026-11-04T05:00:00.000Z',
    ]);
    // The day the clocks go back is 25 hours long: its due time (the end of the day) is the next local midnight.
    expect(nextOccurrences(sched({ every: 'day', startDate: '2026-11-01', timezone: 'America/New_York' }), at('2026-11-01T00:00:00Z'), 1).occurrences[0]!.dueAt).toBe('2026-11-02T05:00:00.000Z');
  });

  it('where midnight does not exist the date starts at its first instant; where it happens twice, at the first', () => {
    expect(startOfLocalDay('2024-03-10', 'America/Havana').toISOString()).toBe('2024-03-10T05:00:00.000Z');
    expect(startOfLocalDay('2024-11-03', 'America/Havana').toISOString()).toBe('2024-11-03T04:00:00.000Z');
  });

  it('"from" is an instant: an occurrence that began before it is left out', () => {
    const s = sched({ every: 'day', startDate: '2026-10-20', timezone: 'Asia/Dubai' });
    // 2026-10-20 begins at 2026-10-19T20:00Z in Dubai.
    expect(dates(s, '2026-10-19T20:00:00Z', 1)).toEqual(['2026-10-20']);
    expect(dates(s, '2026-10-19T20:00:01Z', 1)).toEqual(['2026-10-21']);
  });
});

const terms: CalendarTerm[] = [
  { name: 'AY2026-27', kind: 'year', start: '2026-08-24', end: '2027-05-14' },
  { name: 'Fall 2026', kind: 'term', start: '2026-08-24', end: '2026-12-18' },
  { name: 'Spring 2027', kind: 'term', start: '2027-01-18', end: '2027-05-14' },
];

describe('nextOccurrences: semester', () => {
  it('is the start of each term of the academic calendar (years are not terms)', () => {
    const r = nextOccurrences(sched({ every: 'semester', startDate: '2026-01-01', dueAfterDays: 14 }), at('2026-01-01T00:00:00Z'), 2, terms);
    expect(r.occurrences.map((o) => [o.date, o.label, o.dueDate])).toEqual([['2026-08-24', 'Fall 2026', '2026-09-07'], ['2027-01-18', 'Spring 2027', '2027-02-01']]);
    expect(r.gap).toBeNull();
  });

  it('skips terms that began before the start date or before "from"', () => {
    expect(dates(sched({ every: 'semester', startDate: '2026-09-01' }), '2026-01-01T00:00:00Z', 1, terms)).toEqual(['2027-01-18']);
    expect(dates(sched({ every: 'semester', startDate: '2026-01-01' }), '2026-10-01T00:00:00Z', 1, terms)).toEqual(['2027-01-18']);
  });

  it('flags a gap when the calendar has no term, and never guesses one', () => {
    const r = nextOccurrences(sched({ every: 'semester', startDate: '2026-01-01' }), at('2026-01-01T00:00:00Z'), 4, terms);
    expect(r.occurrences).toHaveLength(2);
    expect(r.gap).toEqual({ reason: 'no_term', after: '2027-05-14' });
    // No calendar at all: no occurrences, and the gap starts where the schedule does.
    expect(nextOccurrences(sched({ every: 'semester', startDate: '2026-01-01' }), at('2026-01-01T00:00:00Z'), 1, [])).toEqual({ occurrences: [], gap: { reason: 'no_term', after: '2026-01-01' } });
    expect(nextOccurrences(sched({ every: 'semester', startDate: '2026-01-01' }), at('2028-01-01T00:00:00Z'), 1, terms).gap).toEqual({ reason: 'no_term', after: '2028-01-01' });
  });

  it('places the term start in the schedule\'s time zone', () => {
    expect(nextOccurrences(sched({ every: 'semester', startDate: '2026-01-01', timezone: 'Asia/Dubai' }), at('2026-01-01T00:00:00Z'), 1, terms).occurrences[0]!.at).toBe('2026-08-23T20:00:00.000Z');
  });
});

describe('nextDue', () => {
  const s = sched({ every: 'month', startDate: '2026-01-15', dueAfterDays: 10 });
  it('is the end of the due date of the period that has not yet ended', () => {
    expect(nextDue(s, at('2026-10-20T12:00:00Z')).dueAt).toBe('2026-10-26T00:00:00.000Z');   // the October period began on the 15th, due the 25th
    expect(nextDue(s, at('2026-10-30T12:00:00Z')).dueAt).toBe('2026-11-26T00:00:00.000Z');   // that one is over: November's
    expect(nextDue(s, at('2026-10-30T12:00:00Z')).occurrence?.label).toBe('Nov 2026');
  });

  it('is the first period before the schedule has started', () => {
    expect(nextDue(s, at('2025-06-01T00:00:00Z')).occurrence?.date).toBe('2026-01-15');
  });

  it('is null with a gap for a semester the calendar cannot place', () => {
    const sem = sched({ every: 'semester', startDate: '2026-01-01', dueAfterDays: 14 });
    expect(nextDue(sem, at('2026-09-01T00:00:00Z'), terms).dueAt).toBe('2026-09-08T00:00:00.000Z');
    expect(nextDue(sem, at('2028-01-01T00:00:00Z'), terms)).toEqual({ dueAt: null, occurrence: null, gap: { reason: 'no_term', after: '2028-01-01' } });
  });
});
