// The pure part of the configuration stage (step H): quote verification, merging what overlapping windows proposed twice, the
// shapes of the configuration, keys and codes derived from the accreditor's own words. No database, no model.
import { describe, expect, it } from 'vitest';
import { checkFrameworkConfig, FrameworkConfigSchema, LifecycleTemplateSchema } from '@ams/shared';
import { buildConfig, deriveCode, sectionKeyOf, slug, uniqueKey, type ConfigDoc, type RawConfigItem } from './config-merge.js';
import type { LifecycleItem, TemplateItem, VocabItem } from './config-schemas.js';

const DOC: ConfigDoc = { id: 'd1', title: 'Process Guide', language: 'en', role: 'policy_procedure' };
const PAGES = new Map([['d1', new Map([
  [1, 'Chapter 1. The institution submits its Annual Report every year. Candidates are eligible after one graduating class.'],
  [2, 'Decisions: Full Accreditation is granted for six years. A Weakness requires action.'],
  [3, 'Report outline. Section A: Context. Section A.1 History. Section B: Data. Table 1: Staff.'],
])]]);
const docs = new Map([['d1', DOC]]);
let n = 0;
const raw = <T extends RawConfigItem['item']>(target: RawConfigItem['target'], item: T, o: { window?: number } = {}): RawConfigItem => ({ id: `i${++n}`, documentId: 'd1', target, seq: n, window: o.window ?? 0, item });
const life = (o: Partial<LifecycleItem> & { name: string; source: { page: number; quote: string } }): LifecycleItem => ({ kind: 'milestone', temp_id: `t${n}`, flags: [], confidence: 0.9, ...o }) as LifecycleItem;
const voc = (o: Partial<VocabItem> & { label: string; source: { page: number; quote: string } }): VocabItem => ({ kind: 'decision', temp_id: `t${n}`, flags: [], confidence: 0.9, ...o }) as VocabItem;
const sec = (o: Partial<TemplateItem> & { title: string; source: { page: number; quote: string } }): TemplateItem => ({ kind: 'report_section', temp_id: `t${n}`, block_type: 'narrative', flags: [], confidence: 0.9, ...o }) as TemplateItem;
const build = (items: RawConfigItem[], extra: { hint?: { name: string | null; kind: string | null } } = {}) =>
  buildConfig({ raw: items, docs, pages: PAGES, templateHints: new Map(extra.hint ? [['d1', extra.hint]] : []) });

describe('keys and codes from the accreditor\'s words', () => {
  it('slugs Latin names, leaves Arabic to a numbered fallback, and keeps keys unique', () => {
    expect(slug('Submit the Self-Study Report!')).toBe('submit_the_self_study_report');
    expect(slug('Évaluation à mi-parcours')).toBe('evaluation_a_mi_parcours');
    expect(slug('تقرير الدراسة الذاتية')).toBe('');
    expect(slug('x'.repeat(60)).length).toBe(40);
    const used = new Set<string>();
    expect([uniqueKey('annual', used), uniqueKey('annual', used), uniqueKey('Annual', used)]).toEqual(['annual', 'annual_2', 'Annual_3']);
    const codes = new Set<string>();
    expect(deriveCode('NGR', 'Next General Review', 'decision', 1, codes)).toBe('NGR');
    expect(deriveCode('not a code!', 'Interim Report', 'decision', 2, codes)).toBe('interim_report');
    expect(deriveCode(null, 'اعتماد', 'decision', 3, codes)).toBe('decision_3');
    expect(deriveCode('NGR', 'Next General Review', 'decision', 4, codes)).toBe('NGR_2');
    expect(sectionKeyOf('2.1')).toBe('2.1');
    expect(sectionKeyOf('Section B')).toBe('Section-B');
    expect(sectionKeyOf('(a)')).toBe('a');
    expect(sectionKeyOf('')).toBe('');
  });
});

describe('verification and merging', () => {
  it('writes only items whose quote is on the page and whose name is in the text; the rest are flagged with the reason', () => {
    const b = build([
      raw('lifecycle', life({ name: 'Annual Report', milestone_type: 'submission', phase_type: 'maintenance', repeat_text: 'every year', source: { page: 1, quote: 'submits its Annual Report every year' } })),
      raw('lifecycle', life({ name: 'Annual Report', milestone_type: 'submission', phase_type: 'maintenance', source: { page: 1, quote: 'Not what the page says at all' } }), { window: 1 }),
      raw('lifecycle', life({ name: 'Pay a fee', phase_type: 'review', source: { page: 1, quote: 'The institution submits its Annual Report' } })),
    ]);
    const steps = b.lifecycle.value!.phases.flatMap((p) => p.milestones);
    // The two copies of Annual Report are one item (the one whose quote checks out wins); "Pay a fee" is not in the text.
    expect(steps.map((m) => m.name)).toEqual(['Annual Report']);
    expect(b.duplicatesMerged).toBe(1);
    expect(steps[0]).toMatchObject({ due: null, due_text: 'every year', due_pending: true });
    const flagged = b.results.filter((r) => r.status === 'flagged');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ label: 'Pay a fee', group: 'milestone' });
    expect(flagged[0]!.reasons.join(' ')).toMatch(/not on the cited page as written/);
    // The page a quote was found on is recorded when it was cited wrongly.
    const moved = build([raw('vocab', voc({ label: 'Full Accreditation', outcome: 'accredited', source: { page: 1, quote: 'Full Accreditation is granted for six years' } }))]);
    expect(moved.decision.value).toHaveLength(1);
    expect(moved.decision.refs['full_accreditation']).toMatchObject({ page: 2, verified: true });
  });

  it('merges the copies windows overlapping by a page propose, keeping the fuller one and the earliest position', () => {
    const short = voc({ kind: 'finding_severity', label: 'Weakness', requires_action: true, source: { page: 2, quote: 'A Weakness requires action' } });
    const full = voc({ kind: 'finding_severity', label: 'Weakness', requires_action: true, text: 'A Weakness requires action.', source: { page: 2, quote: 'A Weakness requires action.' } });
    const b = build([raw('vocab', short, { window: 0 }), raw('vocab', full, { window: 1 })]);
    expect(b.finding.value).toEqual([{ code: 'weakness', label: 'Weakness', requires_action: true }]);
    expect(b.duplicatesMerged).toBe(1);
    expect(b.results).toHaveLength(1);
  });

  it('keeps out what the configuration schemas refuse, with the reason, instead of writing it as valid', () => {
    const b = build([
      raw('vocab', voc({ label: 'Full Accreditation', source: { page: 2, quote: 'Full Accreditation is granted for six years' } })), // no outcome
      raw('vocab', voc({ kind: 'finding_severity', label: 'Weakness', source: { page: 2, quote: 'A Weakness requires action' } })), // action not stated
      raw('vocab', voc({ kind: 'rating_method', label: 'Chapter 1', scale: [0, 1, 2], labels: ['a', 'b'], rated_level: 'x', aggregate: 'mean', source: { page: 1, quote: 'Chapter 1' } })), // labels and scale differ
      raw('vocab', voc({ label: 'Candidates', outcome: 'candidate', term_years: -2, term_options: [3, 0], source: { page: 1, quote: 'Candidates are eligible after one graduating class' } })),
    ]);
    expect(b.decision.value).toEqual([{ code: 'candidates', label: 'Candidates', outcome: 'candidate' }]); // the bad numbers are left out, the entry is sound
    expect(b.finding.value).toEqual([]);
    expect(b.rating.value).toBeNull();
    const why = Object.fromEntries(b.results.filter((r) => r.status === 'flagged').map((r) => [r.label, r.reasons.join(' ')]));
    expect(why['Full Accreditation']).toMatch(/no decision outcome/);
    expect(why['Weakness']).toMatch(/whether it requires action/);
    expect(why['Chapter 1']).toMatch(/whole rating method/);
  });

  it('names a stage after its type, flagged, when a step has none; orders stages by the process, steps by reading order', () => {
    const b = build([
      raw('lifecycle', life({ name: 'Annual Report', phase_type: 'maintenance', milestone_type: 'submission', source: { page: 1, quote: 'submits its Annual Report' } })),
      raw('lifecycle', life({ name: 'one graduating class', phase_type: 'eligibility', milestone_type: 'task', source: { page: 1, quote: 'eligible after one graduating class' } })),
    ]);
    const phases = b.lifecycle.value!.phases;
    expect(phases.map((p) => [p.type, p.name])).toEqual([['eligibility', 'Eligibility'], ['maintenance', 'Maintenance']]);
    expect(b.results.filter((r) => r.group === 'phase').every((r) => r.reasons.join(' ').match(/does not name this stage/))).toBe(true);
    // Whatever it builds passes the lifecycle schema.
    expect(LifecycleTemplateSchema.safeParse(b.lifecycle.value).success).toBe(true);
  });

  it('copies timing words, never converts them: a written step with due text is reported by checkFrameworkConfig until a reviewer acts', () => {
    const b = build([raw('lifecycle', life({ name: 'Annual Report', phase_type: 'maintenance', milestone_type: 'submission', due_text: 'every year', source: { page: 1, quote: 'submits its Annual Report every year' } }))]);
    const config = FrameworkConfigSchema.parse({
      level_labels: ['Standard'], lifecycle_template: b.lifecycle.value, decision_vocab: [], finding_vocab: [], response_vocab: [], report_templates: [],
    });
    const issues = checkFrameworkConfig(config).filter((i) => /due rule/.test(i.message));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/"Annual Report": the reviewer must set the due rule \(the document says: "every year"\)/);
    // Once the reviewer sets a rule and drops the mark, the problem is gone.
    const fixed = structuredClone(config);
    const m = fixed.lifecycle_template.phases[0]!.milestones[0]!;
    m.due = { fixed: '07-01', year_offset: 0 };
    delete m.due_pending;
    expect(checkFrameworkConfig(fixed).filter((i) => /due rule/.test(i.message))).toEqual([]);
  });
});

describe('report templates', () => {
  it('nests sections by temp id or by the parent\'s printed number, keeps numbering as keys, and sets attestation from the sections', () => {
    const b = build([
      raw('template', sec({ number: 'A', title: 'Context', source: { page: 3, quote: 'Section A: Context' } }), { window: 0 }),
      // The parent is in the previous window: named by its number.
      raw('template', sec({ number: 'A.1', parent_number: 'A', title: 'History', source: { page: 3, quote: 'Section A.1 History' } }), { window: 1 }),
      raw('template', sec({ number: 'B', title: 'Data', source: { page: 3, quote: 'Section B: Data' } }), { window: 1 }),
      raw('template', sec({ number: 'Table 1', title: 'Staff', block_type: 'data_table', columns: [{ label: 'Rank', type: 'enum', options: ['Professor', 'Lecturer'] }, { label: 'Count', type: 'number' }], source: { page: 3, quote: 'Table 1: Staff' } }), { window: 1 }),
    ], { hint: { name: 'Report outline', kind: 'annual' } });
    expect(b.templates).toHaveLength(1);
    const t = b.templates[0]!;
    expect(t).toMatchObject({ key: 'report_outline', name: 'Report outline', kind: 'annual', language: 'en', requires_attestation: false });
    expect(t.structure.sections).toEqual([
      { key: 'A', title: 'Context', block_type: 'narrative', children: [{ key: 'A.1', title: 'History', block_type: 'narrative' }] },
      { key: 'B', title: 'Data', block_type: 'narrative' },
      { key: 'Table-1', title: 'Staff', block_type: 'data_table', columns: [{ key: 'rank', label: 'Rank', type: 'enum', options: ['Professor', 'Lecturer'] }, { key: 'count', label: 'Count', type: 'number' }] },
    ]);
    expect(Object.keys(t.sectionRefs)).toEqual(['A', 'A.1', 'B', 'Table-1']);
  });

  it('a data table without columns, or a template the schema refuses, is flagged and not written; a cycle in the nesting is cut', () => {
    const noColumns = build([
      raw('template', sec({ number: 'A', title: 'Context', source: { page: 3, quote: 'Section A: Context' } })),
      raw('template', sec({ number: 'Table 1', title: 'Staff', block_type: 'data_table', source: { page: 3, quote: 'Table 1: Staff' } })),
    ]);
    expect(noColumns.templates[0]!.structure.sections.map((s) => s.key)).toEqual(['A']);
    expect(noColumns.results.find((r) => r.label === 'Staff')).toMatchObject({ status: 'flagged' });

    const onlyTable = build([raw('template', sec({ number: 'Table 1', title: 'Staff', block_type: 'data_table', source: { page: 3, quote: 'Table 1: Staff' } }))]);
    expect(onlyTable.templates).toEqual([]);
    expect(onlyTable.results.find((r) => r.group === 'template')).toMatchObject({ status: 'flagged', reasons: [expect.stringMatching(/no valid sections/)] });

    const a = sec({ temp_id: 'a', parent_temp_id: 'b', number: 'A', title: 'Context', source: { page: 3, quote: 'Section A: Context' } });
    const c = sec({ temp_id: 'b', parent_temp_id: 'a', number: 'B', title: 'Data', source: { page: 3, quote: 'Section B: Data' } });
    const cyc = build([raw('template', a), raw('template', c)]);
    expect(cyc.templates[0]!.structure.sections.length).toBeGreaterThan(0);
    expect(JSON.stringify(cyc.templates[0]!.structure)).toMatch(/Context/);
  });

  it('points a milestone at the template it delivers by name, and says so when it cannot', () => {
    const items = [
      raw('template', sec({ number: 'A', title: 'Context', source: { page: 3, quote: 'Section A: Context' } })),
      raw('lifecycle', life({ name: 'Annual Report', phase_type: 'maintenance', milestone_type: 'submission', deliverable_name: 'Report outline', source: { page: 1, quote: 'submits its Annual Report' } })),
      raw('lifecycle', life({ name: 'Candidates', phase_type: 'eligibility', milestone_type: 'task', deliverable_name: 'Some other form', source: { page: 1, quote: 'Candidates are eligible' } })),
    ];
    const b = build(items, { hint: { name: 'Report outline', kind: 'annual' } });
    const steps = b.lifecycle.value!.phases.flatMap((p) => p.milestones);
    expect(steps.find((m) => m.name === 'Annual Report')!.deliverable).toEqual({ report_template_key: 'report_outline' });
    expect(steps.find((m) => m.name === 'Candidates')!.deliverable).toBeUndefined();
    expect(b.results.find((r) => r.label === 'Candidates')!.reasons.join(' ')).toMatch(/not among the templates/);
  });
});
