import { describe, expect, it } from 'vitest';
import {
  AppliesWhenSchema, DueRuleSchema, ReportTemplateStructureSchema, validateFrameworkConfig, type FrameworkConfig,
} from './framework.js';

// The examples below are the PRD's own (7.4, 7.5, 10.2) assembled into one version.
const valid = () => ({
  level_labels: ['Criterion', 'Item'],
  lifecycle_template: {
    phases: [
      { type: 'eligibility', name: 'Readiness Review & RFE', applies_to: ['initial'], milestones: [
        { key: 'rrev_request', name: 'Submit Request for Readiness Review', type: 'submission', due: { fixed: '08-15', year_offset: -1 },
          source_ref: { doc: 'Readiness Review Information', page: 1 } },
      ] },
      { type: 'self_study', name: 'Self-Study Report', applies_to: ['initial', 'reaffirmation'], milestones: [
        { key: 'ssr_submit', name: 'Submit Self-Study Report', type: 'submission', deliverable: { report_template_key: 'ssr' }, due: { fixed: '07-01', year_offset: 0 } },
        { key: 'internal_approval', name: 'Internal approval', type: 'task', due: { anchor: 'submission_date', offset_days: -45 } },
      ] },
      { type: 'decision', name: 'Decision', applies_to: ['initial', 'reaffirmation'], milestones: [
        { key: 'draft_due_process', name: 'Due-process response', type: 'submission', deliverable: { report_template_key: 'due_process' }, due: { after: 'ssr_submit', offset_days: 30 } },
      ] },
      { type: 'maintenance', name: 'Maintenance', applies_to: ['reaffirmation'], milestones: [
        { key: 'annual', name: 'Annual report', type: 'submission', recurrence: { every: 'year', month_day: '10-15' }, due: null, required: false },
      ] },
    ],
    next_cycle: { start_offset_days_before_expiry: 730 },
  },
  decision_vocab: [
    { code: 'NGR', label: 'Next General Review', outcome: 'accredited', term_years: 6,
      follow_up: [{ milestone_key: 'next_rfe', name: 'Submit RFE for next general review', due: { fixed: '01-31', year_offset: 6 } }] },
    { code: 'IR', label: 'Interim Report', outcome: 'accredited', term_years: 2,
      follow_up: [{ milestone_key: 'interim_report', name: 'Submit Interim Report', type: 'submission', deliverable: { report_template_key: 'interim' }, due: { fixed: '07-01', year_offset: 2 } }] },
    { code: 'NA', label: 'Not to Accredit', outcome: 'not_accredited' },
  ],
  finding_vocab: [
    { code: 'deficiency', label: 'Deficiency', requires_action: true },
    { code: 'observation', label: 'Observation', requires_action: false },
  ],
  response_vocab: [
    { code: 'rev_recommendation', label: 'Readiness Review recommendation', reply_required: true, reply_due: { fixed: '01-15', year_offset: 0 }, reply_kind: 'letter', item_categories: ['recommendation'] },
    { code: 'draft_statement', label: 'Draft Statement', reply_required: true, reply_window_days: 30, reply_kind: 'report', reply_template_key: 'due_process', item_categories: ['finding', 'correction'] },
    { code: 'final_statement', label: 'Final Statement', reply_required: false, is_decision: true },
  ],
  rating_method: { scale: [0, 1, 2, 3, 4], labels: ['Not in compliance', 'Inadequate', 'Minimal', 'Marked', 'Substantial'], rated_level: 'Quality Indicator', aggregate: 'weighted_by_standard' },
  report_templates: [
    { key: 'ssr', name: 'Self-Study Report', kind: 'self_study', requires_attestation: true, structure: { sections: [
      { key: 'A', title: 'Introduction', block_type: 'narrative', prompt: 'Describe the institution.', requirement_codes: ['CFR 1.1'], word_limit: null, children: [] },
      { key: 'T5-1', title: 'Table 5-1 Curriculum', block_type: 'data_table', columns: [
        { key: 'course', label: 'Course', type: 'text' }, { key: 'req', label: 'R / E / SE', type: 'enum', options: ['R', 'E', 'SE'] }] },
      { key: 'APP-I', title: 'Compliance Worksheet', block_type: 'compliance_matrix' },
      { key: 'ATT', title: 'Letter affirming accuracy', block_type: 'attestation' },
    ] } },
    { key: 'interim', name: 'Interim Report', kind: 'follow_up', structure: { sections: [{ key: 'B', title: 'Responses', block_type: 'feedback_response' }] } },
    { key: 'due_process', name: 'Due-process response', kind: 'response', structure: { sections: [{ key: 'R', title: 'Response per shortcoming', block_type: 'feedback_response' }] } },
  ],
});

const issuesOf = (input: unknown) => {
  const r = validateFrameworkConfig(input);
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
};
const mutate = (fn: (c: ReturnType<typeof valid>) => void) => { const c = valid(); fn(c); return c; };

describe('framework configuration schemas', () => {
  it('accepts the PRD examples assembled into one version', () => {
    const r = validateFrameworkConfig(valid());
    expect(issuesOf(valid())).toEqual([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.config satisfies FrameworkConfig).lifecycle_template.phases[1]!.milestones[0]!.required).toBe(true); // default applied
  });

  it('knows exactly four due-rule forms and nothing else', () => {
    for (const ok of [{ fixed: '02-29', year_offset: 0 }, { anchor: 'visit_date', offset_days: -5 }, { after: 'x', offset_days: 30 }, null]) {
      expect(DueRuleSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    }
    for (const bad of [{ fixed: '13-01', year_offset: 0 }, { fixed: '02-30', year_offset: 0 }, { fixed: '08-15' }, { anchor: 'birthday', offset_days: 1 },
      { fixed: '08-15', year_offset: 0, anchor: 'visit_date', offset_days: 1 }, { after: 'x' }, {}, 'soon']) {
      expect(DueRuleSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('validates applicability tags', () => {
    expect(AppliesWhenSchema.safeParse({ scope: ['program'], degree_level: ['bachelor'], program_tags: ['mechanical'], engagement_kind: ['initial'] }).success).toBe(true);
    expect(AppliesWhenSchema.safeParse(null).success).toBe(true);
    expect(AppliesWhenSchema.safeParse({ colour: ['red'] }).success).toBe(false);
    expect(AppliesWhenSchema.safeParse({ scope: ['galaxy'] }).success).toBe(false);
  });

  it('requires a self_study deliverable in exactly one milestone', () => {
    expect(issuesOf(mutate((c) => { delete (c.lifecycle_template.phases[1]!.milestones[0] as { deliverable?: unknown }).deliverable; })))
      .toContainEqual(expect.stringContaining('exactly one milestone must deliver a self_study template (found 0)'));
    expect(issuesOf(mutate((c) => { c.lifecycle_template.phases[1]!.milestones[1] = { ...c.lifecycle_template.phases[1]!.milestones[0]!, key: 'ssr_again' }; })))
      .toContainEqual(expect.stringContaining('(found 2)'));
  });

  it('resolves references between milestones, templates and vocabularies', () => {
    expect(issuesOf(mutate((c) => { c.lifecycle_template.phases[2]!.milestones[0]!.due = { after: 'ghost', offset_days: 1 }; }))).toContainEqual(expect.stringContaining('unknown milestone ghost'));
    expect(issuesOf(mutate((c) => { (c.lifecycle_template.phases[2]!.milestones[0] as { deliverable?: unknown }).deliverable = { report_template_key: 'nope' }; }))).toContainEqual(expect.stringContaining('unknown report template nope'));
    expect(issuesOf(mutate((c) => { (c.decision_vocab[1]!.follow_up![0] as { deliverable?: unknown }).deliverable = { report_template_key: 'nope' }; }))).toContainEqual(expect.stringContaining('decision_vocab[1].follow_up[0].deliverable'));
    expect(issuesOf(mutate((c) => { c.response_vocab[1]!.reply_template_key = 'nope'; }))).toContainEqual(expect.stringContaining('unknown report template nope'));
    expect(issuesOf(mutate((c) => { delete (c.response_vocab[1] as { reply_template_key?: string }).reply_template_key; }))).toContainEqual(expect.stringContaining('reply_kind report needs reply_template_key'));
  });

  it('rejects duplicate keys and codes', () => {
    expect(issuesOf(mutate((c) => { c.lifecycle_template.phases[2]!.milestones[0]!.key = 'ssr_submit'; }))).toContainEqual(expect.stringContaining('duplicate milestone key ssr_submit'));
    expect(issuesOf(mutate((c) => { c.finding_vocab[1]!.code = 'deficiency'; }))).toContainEqual('finding_vocab: codes must be unique');
    expect(issuesOf(mutate((c) => { c.report_templates[1]!.key = 'ssr'; }))).toContainEqual('report_templates: template keys must be unique');
    expect(issuesOf(mutate((c) => { c.report_templates[0]!.structure.sections[2]!.key = 'A'; }))).toContainEqual(expect.stringContaining('duplicate section key A'));
  });

  it('checks report template structure', () => {
    expect(ReportTemplateStructureSchema.safeParse({ sections: [{ key: 'x', title: 'T', block_type: 'poem' }] }).success).toBe(false);
    expect(ReportTemplateStructureSchema.safeParse({ sections: [{ key: 'x', title: 'T', block_type: 'data_table' }] }).success).toBe(false);
    expect(ReportTemplateStructureSchema.safeParse({ sections: [{ key: 'x', title: 'T', block_type: 'data_table', columns: [{ key: 'c', label: 'C', type: 'enum' }] }] }).success).toBe(false);
    expect(ReportTemplateStructureSchema.safeParse({ sections: [{ key: 'x', title: 'T', block_type: 'data_table', dataset_binding: { dataset: 'enrolment' } }] }).success).toBe(true);
    expect(ReportTemplateStructureSchema.safeParse({ sections: [{ key: 'p', title: 'P', block_type: 'narrative', children: [{ key: 'q', title: 'Q', block_type: 'narrative' }] }] }).success).toBe(true);
    expect(ReportTemplateStructureSchema.safeParse({ sections: [] }).success).toBe(false);
    expect(issuesOf(mutate((c) => { c.report_templates[0]!.structure.sections.pop(); }))).toContainEqual(expect.stringContaining('requires_attestation needs an attestation section'));
  });

  it('reports every problem at once, with paths, for the editors', () => {
    const bad = mutate((c) => { c.level_labels = []; (c.lifecycle_template.phases[0] as { type: string }).type = 'warmup'; });
    const issues = issuesOf(bad);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.join('\n')).toMatch(/level_labels/);
    expect(issues.join('\n')).toMatch(/lifecycle_template\.phases\.0\.type/);
  });

  it('rejects a rating method whose labels do not match its scale, and accepts null', () => {
    expect(issuesOf(mutate((c) => { c.rating_method!.labels.pop(); })).length).toBeGreaterThan(0);
    expect(issuesOf({ ...valid(), rating_method: null })).toEqual([]);
  });
});
