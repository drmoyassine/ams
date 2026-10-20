// The recurrence engine (TASK-081): periods and run dates from a plan's recurrence and the academic calendar. Pure.
import { describe, expect, it } from 'vitest';
import { periodsFor, plusDays, plusMonths, type CalendarEntry } from './recurrence.js';

const term = (name: string, start: string, end: string): CalendarEntry => ({ name, kind: 'term', start, end });
const yr = (name: string, start: string, end: string): CalendarEntry => ({ name, kind: 'year', start, end });
const CAL: CalendarEntry[] = [
  yr('AY2026-27', '2026-08-15', '2027-08-14'), yr('AY2027-28', '2027-08-15', '2028-08-14'), yr('AY2028-29', '2028-08-15', '2029-08-14'),
  term('Fall 2026', '2026-08-24', '2026-12-18'), term('Spring 2027', '2027-01-18', '2027-05-14'), term('Fall 2027', '2027-08-23', '2027-12-17'),
];
const wide = { from: '2026-01-01', to: '2029-12-31' };

describe('every term', () => {
  it('gives each term of the calendar, labelled by its name, from the first start', () => {
    const r = periodsFor({ every: 1, unit: 'term' }, '2026-08-01', CAL, wide);
    expect(r.periods.map((p) => [p.label, p.start, p.end])).toEqual([
      ['Fall 2026', '2026-08-24', '2026-12-18'], ['Spring 2027', '2027-01-18', '2027-05-14'], ['Fall 2027', '2027-08-23', '2027-12-17'],
    ]);
  });
  it('skips terms that ended before the first start, and keeps the one the first start falls in', () => {
    expect(periodsFor({ every: 1, unit: 'term' }, '2027-02-01', CAL, wide).periods.map((p) => p.label)).toEqual(['Spring 2027', 'Fall 2027']);
  });
  it('takes every second term', () => {
    expect(periodsFor({ every: 2, unit: 'term' }, '2026-08-01', CAL, wide).periods.map((p) => p.label)).toEqual(['Fall 2026', 'Fall 2027']);
  });
  it('says when the calendar has no term for the rest of the horizon, and never invents one', () => {
    const r = periodsFor({ every: 1, unit: 'term' }, '2026-08-01', CAL, wide);
    expect(r.gaps).toEqual([{ from: '2027-12-18', to: '2029-12-31', reason: 'no_term' }]);
    const none = periodsFor({ every: 1, unit: 'term' }, '2026-08-01', [], { from: '2026-09-01', to: '2027-03-01' });
    expect(none.periods).toEqual([]);
    expect(none.gaps).toEqual([{ from: '2026-09-01', to: '2027-03-01', reason: 'no_term' }]);
  });
  it('reports no gap while the horizon stays inside the calendar', () => {
    expect(periodsFor({ every: 1, unit: 'term' }, '2026-08-01', CAL, { from: '2026-09-01', to: '2027-06-01' }).gaps).toEqual([]);
  });
  it('limits the periods to those touching the horizon', () => {
    const r = periodsFor({ every: 1, unit: 'term' }, '2026-08-01', CAL, { from: '2026-12-01', to: '2027-02-01' });
    expect(r.periods.map((p) => p.label)).toEqual(['Fall 2026', 'Spring 2027']);
  });
});

describe('every year', () => {
  it('gives each year of the calendar, labelled by its name ("AY2026-27")', () => {
    const r = periodsFor({ every: 1, unit: 'year' }, '2026-09-01', CAL, wide);
    expect(r.periods.map((p) => p.label)).toEqual(['AY2026-27', 'AY2027-28', 'AY2028-29']);
    expect(r.gaps).toEqual([{ from: '2029-08-15', to: '2029-12-31', reason: 'no_year' }]);
  });
  it('runs every N years over N years in a row, labelled by the span ("2026-2029")', () => {
    const r = periodsFor({ every: 3, unit: 'year' }, '2026-09-01', CAL, wide);
    expect(r.periods).toEqual([{ start: '2026-08-15', end: '2029-08-14', label: '2026-2029' }]);
  });
  it('does not make a span the calendar only partly defines: it says so', () => {
    const r = periodsFor({ every: 2, unit: 'year' }, '2026-09-01', CAL, wide);
    expect(r.periods.map((p) => p.label)).toEqual(['2026-2028']);
    expect(r.gaps).toEqual([{ from: '2028-08-15', to: '2029-12-31', reason: 'no_year' }]);
  });
});

describe('every month', () => {
  it('needs no calendar: labels the months from the first start', () => {
    const r = periodsFor({ every: 1, unit: 'month' }, '2026-10-05', [], { from: '2026-10-01', to: '2027-01-10' });
    expect(r.periods.map((p) => [p.label, p.start, p.end])).toEqual([
      ['Oct 2026', '2026-10-05', '2026-11-04'], ['Nov 2026', '2026-11-05', '2026-12-04'], ['Dec 2026', '2026-12-05', '2027-01-04'], ['Jan 2027', '2027-01-05', '2027-02-04'],
    ]);
    expect(r.gaps).toEqual([]);
  });
  it('groups several months and clamps a day the month lacks', () => {
    expect(periodsFor({ every: 6, unit: 'month' }, '2026-01-31', [], { from: '2026-01-01', to: '2027-02-01' }).periods.map((p) => [p.label, p.start])).toEqual([
      ['Jan 2026 – Jul 2026', '2026-01-31'], ['Jul 2026 – Jan 2027', '2026-07-31'], ['Jan 2027 – Jul 2027', '2027-01-31'],
    ]);
    expect(plusMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(plusMonths('2026-11-15', 3)).toBe('2027-02-15');
  });
});

describe('after the previous one ends (date set by a decision)', () => {
  it('has the first run at the first start and waits for a person to set the next date', () => {
    const r = periodsFor({ after: 'previous_ends', setBy: 'decision' }, '2026-09-01', [], { from: '2026-01-01', to: '2030-01-01' });
    expect(r.periods).toEqual([{ start: '2026-09-01', end: null, label: '2026' }]);
    expect(r.gaps).toEqual([{ from: '2026-09-01', to: '2030-01-01', reason: 'no_date' }]);
  });
  it('labels a run by the span to the next date once it is set (6 years)', () => {
    const r = periodsFor({ after: 'previous_ends', setBy: 'decision', dates: ['2032-09-01'] }, '2026-09-01', [], { from: '2026-01-01', to: '2033-01-01' });
    expect(r.periods.map((p) => [p.label, p.start, p.end])).toEqual([['2026-2032', '2026-09-01', '2032-08-31'], ['2032', '2032-09-01', null]]);
    expect(r.gaps).toEqual([{ from: '2032-09-01', to: '2033-01-01', reason: 'no_date' }]);
  });
  it('ignores a date that does not come after the first start, and reports no gap while the last date is still ahead', () => {
    const r = periodsFor({ after: 'previous_ends', setBy: 'decision', dates: ['2020-01-01'] }, '2026-09-01', [], { from: '2026-01-01', to: '2026-06-01' });
    expect(r.periods).toEqual([]);
    expect(r.gaps).toEqual([]);
  });
});

describe('dates', () => {
  it('adds days across month ends', () => { expect(plusDays('2026-12-31', 1)).toBe('2027-01-01'); expect(plusDays('2026-03-01', -1)).toBe('2026-02-28'); });
});
