import { describe, expect, it } from 'vitest';
import type { FrequencyRule } from '@ams/shared';
import { periodsBetween } from './frequency.js';
import type { CalendarTerm } from '../evidence/schedule.js';

const base = { timezone: 'Asia/Dubai', startDate: '2026-01-01' };
const dues = (r: FrequencyRule, from: string, to: string, terms: CalendarTerm[] = []) => periodsBetween(r, from, to, terms).map((p) => p.due);

describe('a standard\'s frequency', () => {
  it('is every day, every Thursday, the last Monday of each month, and the last Monday of August each year', () => {
    expect(dues({ every: 'day', ...base }, '2026-11-01', '2026-11-03')).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(dues({ every: 'week', weekday: 4, ...base }, '2026-11-01', '2026-11-30')).toEqual(['2026-11-05', '2026-11-12', '2026-11-19', '2026-11-26']);
    expect(dues({ every: 'month', on: { nth: -1, weekday: 1 }, ...base }, '2026-09-01', '2026-12-31')).toEqual(['2026-09-28', '2026-10-26', '2026-11-30', '2026-12-28']);
    expect(dues({ every: 'month', on: { day: 31 }, ...base }, '2026-02-01', '2026-02-28')).toEqual(['2026-02-28']);
    expect(dues({ every: 'month', on: { nth: 2, weekday: 3 }, ...base }, '2026-11-01', '2026-11-30')).toEqual(['2026-11-11']);
    expect(dues({ every: 'year', month: 8, on: { nth: -1, weekday: 1 }, ...base }, '2026-01-01', '2028-12-31')).toEqual(['2026-08-31', '2027-08-30', '2028-08-28']);
  });

  it('is week N of each term of the academic calendar, on a weekday or at the end of that week, and never before its start date', () => {
    const terms = [
      { name: 'Fall 2026', kind: 'term' as const, start: '2026-08-24', end: '2026-12-18' },
      { name: 'Spring 2027', kind: 'term' as const, start: '2027-01-11', end: '2027-05-07' },
      { name: '2026-27', kind: 'year' as const, start: '2026-08-24', end: '2027-06-30' },
    ];
    const p = periodsBetween({ every: 'semester', week: 12, ...base }, '2026-01-01', '2027-12-31', terms);
    expect(p.map((x) => [x.label, x.due, x.key])).toEqual([['Fall 2026', '2026-11-15', 'T2026-08-24'], ['Spring 2027', '2027-04-04', 'T2027-01-11']]);
    expect(dues({ every: 'semester', week: 12, weekday: 4, ...base }, '2026-01-01', '2026-12-31', terms)).toEqual(['2026-11-12']);
    // Due at the end of the due day, in the rule's time zone (Dubai is UTC+4).
    expect(p[0]!.dueAt.toISOString()).toBe('2026-11-15T20:00:00.000Z');
    expect(dues({ every: 'week', weekday: 4, ...base, startDate: '2026-11-15' }, '2026-11-01', '2026-11-30')).toEqual(['2026-11-19', '2026-11-26']);
  });
});
