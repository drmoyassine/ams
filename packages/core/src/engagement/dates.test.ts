import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrameworkExportSchema } from '@ams/shared';
import { addDays, daysBetween, isLeapYear, isOverdue, monthDayIn, nextOccurrences, resolveDueRule } from './dates.js';

const fixture = (name: string) => FrameworkExportSchema.parse(JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../db/fixtures/${name}.json`), 'utf8')));
const milestoneRule = (name: string, key: string) =>
  fixture(name).config.lifecycle_template.phases.flatMap((p) => p.milestones).find((m) => m.key === key)!.due;

describe('calendar arithmetic', () => {
  it('adds days across month, year and leap-day boundaries', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01');
    expect(addDays('2028-03-01', -540)).toBe('2026-09-08');
    expect(addDays('2026-01-10', 30)).toBe('2026-02-09');
  });

  it('counts days between dates', () => {
    expect(daysBetween('2027-01-01', '2028-01-01')).toBe(365);
    expect(daysBetween('2028-01-01', '2029-01-01')).toBe(366);
    expect(daysBetween('2028-03-01', '2027-03-01')).toBe(-366);
  });

  it('rejects dates that do not exist', () => {
    expect(() => addDays('2027-02-29', 1)).toThrow(/not a real calendar date/);
    expect(() => addDays('27-02-01', 1)).toThrow(/not an ISO date/);
  });

  it('puts 02-29 on 02-28 in a year without one', () => {
    expect(isLeapYear(2028)).toBe(true);
    expect(isLeapYear(2100)).toBe(false);
    expect(monthDayIn(2028, '02-29')).toBe('2028-02-29');
    expect(monthDayIn(2027, '02-29')).toBe('2027-02-28');
  });
});

describe('due rules', () => {
  const ctx = { reviewYear: 2027, keyDates: {} };

  it('resolves a fixed date in review year plus offset', () => {
    expect(resolveDueRule({ fixed: '07-01', year_offset: 0 }, ctx)).toEqual({ dueDate: '2027-07-01', dateNeeded: false });
    expect(resolveDueRule({ fixed: '09-01', year_offset: -1 }, ctx)).toEqual({ dueDate: '2026-09-01', dateNeeded: false });
    expect(resolveDueRule({ fixed: '08-31', year_offset: 1 }, ctx)).toEqual({ dueDate: '2028-08-31', dateNeeded: false });
  });

  it('resolves an anchor rule from a key date, and asks for the date when it is missing', () => {
    const rule = { anchor: 'submission_date' as const, offset_days: -30 };
    expect(resolveDueRule(rule, { ...ctx, keyDates: { submission_date: '2027-07-01' } })).toEqual({ dueDate: '2027-06-01', dateNeeded: false });
    expect(resolveDueRule(rule, ctx)).toEqual({ dueDate: null, dateNeeded: true });
    expect(resolveDueRule(rule, { ...ctx, keyDates: { submission_date: null } })).toEqual({ dueDate: null, dateNeeded: true });
  });

  it('resolves an after rule from another milestone\'s completion', () => {
    const rule = { after: 'draft_statement', offset_days: 30 };
    expect(resolveDueRule(rule, { ...ctx, completedOn: (k) => (k === 'draft_statement' ? '2028-01-10' : null) })).toEqual({ dueDate: '2028-02-09', dateNeeded: false });
    expect(resolveDueRule(rule, { ...ctx, completedOn: () => null })).toEqual({ dueDate: null, dateNeeded: true });
    expect(resolveDueRule(rule, ctx)).toEqual({ dueDate: null, dateNeeded: true });
  });

  it('leaves a null rule for a person to set, without asking for anything', () => {
    expect(resolveDueRule(null, ctx)).toEqual({ dueDate: null, dateNeeded: false });
    expect(resolveDueRule(undefined, ctx)).toEqual({ dueDate: null, dateNeeded: false });
  });
});

describe('Appendix A dates, from the fixtures', () => {
  it('ABET, review year 2027: fixed dates fall in the right year', () => {
    const at = (key: string) => resolveDueRule(milestoneRule('abet-eac-2027-28', key), { reviewYear: 2027, keyDates: {} }).dueDate;
    expect(at('ssr_submit')).toBe('2027-07-01');
    expect(at('rrev_report')).toBe('2026-09-01');
    expect(at('final_statement_received')).toBe('2028-08-31');
  });

  it('WSCUC: a milestone due 540 days before submission follows the submission date', () => {
    const rule = milestoneRule('wscuc-2023', 'liaison_consultation');
    expect(resolveDueRule(rule, { reviewYear: 2028, keyDates: { submission_date: '2028-03-01' } }).dueDate).toBe('2026-09-08');
    expect(resolveDueRule(rule, { reviewYear: 2028, keyDates: {} })).toEqual({ dueDate: null, dateNeeded: true });
    expect(resolveDueRule(milestoneRule('wscuc-2023', 'submit_institutional_report'), { reviewYear: 2028, keyDates: { submission_date: '2028-03-01' } }).dueDate).toBe('2028-03-01');
  });
});

describe('recurrence', () => {
  it('materialises the next two yearly occurrences on or after a date', () => {
    expect(nextOccurrences({ every: 'year', month_day: '07-01' }, '2029-03-15')).toEqual(['2029-07-01', '2030-07-01']);
    expect(nextOccurrences({ every: 'year', month_day: '07-01' }, '2029-07-01')).toEqual(['2029-07-01', '2030-07-01']);
    expect(nextOccurrences({ every: 'year', month_day: '07-01' }, '2029-07-02')).toEqual(['2030-07-01', '2031-07-01']);
    expect(nextOccurrences({ every: 'year', month_day: '02-29' }, '2027-01-01', 3)).toEqual(['2027-02-28', '2028-02-29', '2029-02-28']);
  });
});

describe('overdue', () => {
  it('is computed from the due date and status', () => {
    expect(isOverdue('2027-06-30', 'in_progress', '2027-07-01')).toBe(true);
    expect(isOverdue('2027-07-01', 'in_progress', '2027-07-01')).toBe(false);
    expect(isOverdue('2027-06-30', 'done', '2027-07-01')).toBe(false);
    expect(isOverdue('2027-06-30', 'skipped', '2027-07-01')).toBe(false);
    expect(isOverdue(null, 'not_started', '2027-07-01')).toBe(false);
  });
});
