// Milestone generation against the Appendix A lifecycles, via the same code for every framework.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrameworkExportSchema } from '@ams/shared';
import { firstPhase, generateMilestones } from './generate.js';

const load = (name: string) => FrameworkExportSchema.parse(JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../db/fixtures/${name}.json`), 'utf8')));
const generate = (name: string, kind: 'initial' | 'reaffirmation', reviewYear: number, keyDates: Record<string, string> = {}) => {
  const f = load(name);
  const templateKinds = new Map(f.config.report_templates.map((t) => [t.key, t.kind]));
  return { f, ms: generateMilestones({ lifecycle: f.config.lifecycle_template, kind, reviewYear, keyDates, templateKinds }) };
};
const by = (ms: ReturnType<typeof generate>['ms'], key: string) => ms.find((m) => m.templateKey === key)!;

describe('ABET EAC initial, review year 2027', () => {
  const { f, ms } = generate('abet-eac-2027-28', 'initial', 2027);

  it('generates the eligibility phase for initial reviews, with Appendix A dates', () => {
    expect(ms.filter((m) => m.phase === 'eligibility').map((m) => m.templateKey)).toEqual(
      ['confirm_graduate', 'rrev_request', 'rrev_report', 'rrev_fee', 'rrev_recommendation', 'notify_abet', 'rfe_submit_initial']);
    const date = (k: string) => by(ms, k).dueDate;
    expect(date('rrev_request')).toBe('2026-08-15');
    expect(date('rrev_report')).toBe('2026-09-01');
    expect(date('rrev_fee')).toBe('2026-11-30');
    expect(date('rrev_recommendation')).toBe('2026-12-20');
    expect(date('notify_abet')).toBe('2027-01-15');
    expect(date('rfe_submit_initial')).toBe('2027-01-31');
    expect(date('ssr_submit')).toBe('2027-07-01');
    expect(date('final_statement_received')).toBe('2028-08-31');
  });

  it('locks the self-study deliverable and every decision point, and nothing else', () => {
    expect(ms.filter((m) => m.locked).map((m) => m.templateKey).sort()).toEqual(['final_statement_received', 'rrev_recommendation', 'ssr_submit']);
    expect(by(ms, 'ssr_submit').deliverable).toEqual({ report_template_key: 'ssr' });
    expect(f.config.report_templates.find((t) => t.key === 'ssr')!.kind).toBe('self_study');
  });

  it('flags dates that wait on a key date or another milestone, and leaves manual ones empty', () => {
    expect(by(ms, 'on_site_visit')).toMatchObject({ dueDate: null, dateNeeded: true }); // anchored to the visit date
    expect(by(ms, 'due_process_response')).toMatchObject({ dueDate: null, dateNeeded: true }); // 30 days after the draft statement
    expect(by(ms, 'review_team_conflicts')).toMatchObject({ dueDate: null, dateNeeded: false }); // no rule: set manually
    expect(ms.every((m) => m.dueDate !== null || m.dueRule === null || m.dateNeeded)).toBe(true);
  });

  it('resolves the visit-anchored date once the visit date is known', () => {
    const { ms: withVisit } = generate('abet-eac-2027-28', 'initial', 2027, { visit_date: '2027-10-18' });
    expect(by(withVisit, 'on_site_visit')).toMatchObject({ dueDate: '2027-10-18', dateNeeded: false });
  });

  it('numbers milestones within each phase', () => {
    for (const phase of ['eligibility', 'self_study', 'review', 'decision', 'maintenance']) {
      expect(ms.filter((m) => m.phase === phase).map((m) => m.displayOrder)).toEqual(ms.filter((m) => m.phase === phase).map((_, i) => i));
    }
  });
});

describe('ABET EAC reaffirmation', () => {
  it('skips the initial-only eligibility steps', () => {
    const { ms } = generate('abet-eac-2027-28', 'reaffirmation', 2027);
    expect(ms.filter((m) => m.phase === 'eligibility').map((m) => m.templateKey)).toEqual(['rfe_submit']);
    expect(by(ms, 'rfe_submit').dueDate).toBe('2027-01-31');
  });
});

describe('WSCUC reaffirmation, review year 2028', () => {
  it('uses only the entries that apply to the kind, once per phase type', () => {
    const { f, ms } = generate('wscuc-2023', 'reaffirmation', 2028, { submission_date: '2028-03-01' });
    expect(ms.map((m) => m.phase).filter((p, i, a) => a.indexOf(p) === i)).toEqual(['self_study', 'review', 'decision', 'maintenance']);
    expect(ms.some((m) => m.templateKey === 'sav_preparation')).toBe(false); // initial-only
    expect(by(ms, 'liaison_consultation').dueDate).toBe('2026-09-08');
    expect(by(ms, 'submit_institutional_report').dueDate).toBe('2028-03-01');
    expect(by(ms, 'submit_institutional_report').locked).toBe(true);
    expect(by(ms, 'commission_action').locked).toBe(true);
    expect(ms.find((m) => m.templateKey === 'start_next_cycle')).toBeDefined(); // reaffirmation-only milestone
    expect(firstPhase(f.config.lifecycle_template, 'reaffirmation')).toBe('self_study');
  });

  it('asks for the submission date when it is not known yet', () => {
    const { ms } = generate('wscuc-2023', 'reaffirmation', 2028);
    expect(by(ms, 'liaison_consultation')).toMatchObject({ dueDate: null, dateNeeded: true });
  });
});

describe('WSCUC initial', () => {
  it('starts in eligibility and drops the reaffirmation-only milestone', () => {
    const { f, ms } = generate('wscuc-2023', 'initial', 2028);
    expect(firstPhase(f.config.lifecycle_template, 'initial')).toBe('eligibility');
    expect(ms.some((m) => m.templateKey === 'start_next_cycle')).toBe(false);
    expect(by(ms, 'initial_self_study_report').locked).toBe(true);
  });
});

describe('the same code for every framework', () => {
  it('gives each framework exactly one locked self-study deliverable per kind', () => {
    for (const [name, kind] of [['wscuc-2023', 'reaffirmation'], ['wscuc-2023', 'initial'], ['abet-eac-2027-28', 'initial'], ['puc-2019', 'reaffirmation']] as const) {
      const { f, ms } = generate(name, kind, 2028);
      const selfStudy = ms.filter((m) => m.deliverable && f.config.report_templates.find((t) => t.key === m.deliverable!.report_template_key)!.kind === 'self_study');
      expect(selfStudy).toHaveLength(1);
      expect(selfStudy[0]!.locked).toBe(true);
    }
  });
});
