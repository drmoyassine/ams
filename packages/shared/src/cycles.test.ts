// Cycle schemas (TASK-078): the template's stage definition, the launch input, the rules between stages, and the permissions.
import { describe, expect, it } from 'vitest';
import {
  AddInputSchema, CYCLE_DECISION_LABELS, DecideSchema, LaunchCycleSchema, PERMISSIONS, ROLE_PERMISSIONS, StageDefSchema, TemplateStagesSchema, TRASH_KINDS, validateTemplateStages,
  type StageDef,
} from './index.js';

const stage = (key: string, extra: Partial<StageDef> = {}): StageDef => StageDefSchema.parse({ key, name: key, outputs: [{ key: 'out', name: 'out', kind: 'note' }], ...extra });

describe('stage definitions', () => {
  it('default the unit to the cycle\'s, the owner to the cycle lead, and the offsets to zero', () => {
    const s = StageDefSchema.parse({ key: 'a', name: 'A' });
    expect(s).toMatchObject({ unit: { kind: 'cycle' }, owner: { kind: 'cycle_lead' }, startOffsetDays: 0, lengthDays: 0, outputs: [], inputs: [], checklist: [], process: '' });
  });

  it('take every unit rule, owner rule, output kind and input source of the plan', () => {
    const ok = TemplateStagesSchema.safeParse([{
      key: 'review', name: 'Review', nameAr: 'مراجعة', process: 'Check', checklist: ['one'], startOffsetDays: 5, lengthDays: 10,
      unit: { kind: 'unit_type', type: 'qa_office' }, owner: { kind: 'role', role: 'lead' },
      outputs: [
        { key: 'r', name: 'Report', kind: 'report', reportTemplateKey: 'annual' }, { key: 'd', name: 'Doc', kind: 'document', required: false },
        { key: 'a', name: 'Sign', kind: 'approval', approver: { kind: 'head_of_parent_unit' } }, { key: 'n', name: 'Note', kind: 'note' },
      ],
      inputs: [
        { key: 'i1', name: 'In', from: { stage: 'collect', output: 'x' } }, { key: 'i2', name: 'Prev', from: { previousCycle: { stage: 'final', output: 'report' } } },
        { key: 'i3', name: 'Pick', from: { pick: 'evidence' } },
      ],
      child: { templateKey: 'annual_report', recurrence: { every: 1, unit: 'year' }, until: 'stage_end' },
    }]);
    expect(ok.success).toBe(true);
    for (const unit of [{ kind: 'subject' }, { kind: 'parent_of_subject' }, { kind: 'cycle' }]) expect(StageDefSchema.safeParse({ key: 'a', name: 'A', unit }).success).toBe(true);
    for (const owner of [{ kind: 'head_of_unit' }, { kind: 'cycle_lead' }]) expect(StageDefSchema.safeParse({ key: 'a', name: 'A', owner }).success).toBe(true);
  });

  it('refuse unknown rules, roles, kinds, keys and stray fields', () => {
    const bad = (extra: Record<string, unknown>) => StageDefSchema.safeParse({ key: 'a', name: 'A', ...extra }).success;
    expect(bad({ unit: { kind: 'guess' } })).toBe(false);
    expect(bad({ owner: { kind: 'role', role: 'emperor' } })).toBe(false);
    expect(bad({ outputs: [{ key: 'o', name: 'O', kind: 'video' }] })).toBe(false);
    expect(bad({ inputs: [{ key: 'i', name: 'I', from: { pick: 'anything' } }] })).toBe(false);
    expect(bad({ key: 'Bad Key' })).toBe(false);
    expect(bad({ startOffsetDays: -1 })).toBe(false);
    expect(bad({ accreditor: 'x' })).toBe(false);
    expect(bad({ owner: { kind: 'head_of_unit', extra: 1 } })).toBe(false);
  });
});

describe('validateTemplateStages', () => {
  const read = (stageKey: string, output = 'out') => ({ inputs: [{ key: 'in', name: 'in', required: true, from: { stage: stageKey, output } }] });
  const messages = (stages: StageDef[]) => validateTemplateStages(stages).map((i) => i.message);

  it('accepts inputs that read earlier stages, the previous run, or a pick', () => {
    expect(messages([stage('a'), stage('b', read('a')), stage('c', { inputs: [{ key: 'p', name: 'p', required: true, from: { previousCycle: { stage: 'b', output: 'out' } } }, { key: 'k', name: 'k', required: true, from: { pick: 'any' } }] })])).toEqual([]);
  });

  it('refuses duplicate keys, unknown stages and outputs, a stage reading itself, a later stage, and loops', () => {
    expect(messages([stage('a'), stage('a')])[0]).toMatch(/stage key "a" is used twice/);
    expect(messages([stage('a', { outputs: [{ key: 'o', name: 'o', kind: 'note', required: true }, { key: 'o', name: 'o', kind: 'note', required: true }] })])[0]).toMatch(/output key "o" is used twice/);
    expect(messages([stage('a'), stage('b', read('zzz'))])[0]).toMatch(/no stage "zzz"/);
    expect(messages([stage('a'), stage('b', read('a', 'nope'))])[0]).toMatch(/no output "nope"/);
    expect(messages([stage('a', read('a'))])[0]).toMatch(/own output/);
    expect(messages([stage('a', read('b')), stage('b')])[0]).toMatch(/comes later/);
    expect(messages([stage('a', read('b')), stage('b', read('a'))])[0]).toMatch(/loop: a -> b -> a/);
    expect(messages([stage('a', read('c')), stage('b', read('a')), stage('c', read('b'))])[0]).toMatch(/loop: a -> c -> b -> a/);
    expect(messages([stage('a', { inputs: [{ key: 'p', name: 'p', required: true, from: { previousCycle: { stage: 'a', output: 'x' } } }] })])[0]).toMatch(/no output "x"/);
    expect(messages([StageDefSchema.parse({ key: 'a', name: 'a', outputs: [{ key: 'o', name: 'o', kind: 'note', approver: { kind: 'head_of_unit' } }] })])[0]).toMatch(/only an approval has an approver/);
    expect(messages([StageDefSchema.parse({ key: 'a', name: 'a', outputs: [{ key: 'o', name: 'o', kind: 'note', reportTemplateKey: 'x' }] })])[0]).toMatch(/only a report has a report template/);
  });

  it('reports a problem with the path of the offending field', () => {
    expect(validateTemplateStages([stage('a'), stage('b', read('zzz'))])[0]).toMatchObject({ path: 'stages.1.inputs.0.from.stage' });
  });
});

describe('launch and decisions', () => {
  it('a launch gives the subject as a pair, and defaults the template to none', () => {
    const base = { anchorKind: 'org_unit', anchorId: crypto.randomUUID(), startDate: '2026-09-01' };
    expect(LaunchCycleSchema.parse(base)).toMatchObject({ templateId: null, subjectKind: null, subjectId: null, origin: 'manual' });
    expect(LaunchCycleSchema.safeParse({ ...base, subjectKind: 'program' }).success).toBe(false);
    expect(LaunchCycleSchema.safeParse({ ...base, subjectKind: 'program', subjectId: crypto.randomUUID() }).success).toBe(true);
    expect(LaunchCycleSchema.safeParse({ ...base, anchorKind: 'galaxy' }).success).toBe(false);
    expect(LaunchCycleSchema.safeParse({ ...base, startDate: '1 Sep' }).success).toBe(false);
    expect(LaunchCycleSchema.safeParse({ ...base, previousCycleId: null }).success).toBe(true);
  });

  it('decisions are the three of the plan, worded as internal sign-off and never as an official result', () => {
    for (const d of ['approved', 'approved_with_conditions', 'returned']) expect(DecideSchema.safeParse({ decision: d }).success).toBe(true);
    expect(DecideSchema.safeParse({ decision: 'rejected' }).success).toBe(false);
    expect(CYCLE_DECISION_LABELS.approved).toBe('Internally approved');
    expect(Object.values(CYCLE_DECISION_LABELS).join(' ')).not.toMatch(/\b(met|compliant|accredited)\b/i);
  });

  it('an input names exactly one source (checked by the service); the shape takes a pick, a previous output or an output id', () => {
    expect(AddInputSchema.safeParse({ name: 'x', pick: 'document' }).success).toBe(true);
    expect(AddInputSchema.safeParse({ name: 'x', pick: 'spaceship' }).success).toBe(false);
  });
});

describe('permissions', () => {
  it('cycle:read is for everyone who reads, cycle:manage for admin and lead, cycle:work for contributors and above', () => {
    for (const p of ['cycle:read', 'cycle:manage', 'cycle:work'] as const) expect(PERMISSIONS).toContain(p);
    const who = (p: 'cycle:read' | 'cycle:manage' | 'cycle:work') => Object.entries(ROLE_PERMISSIONS).filter(([, ps]) => ps.includes(p)).map(([r]) => r).sort();
    expect(who('cycle:manage')).toEqual(['admin', 'lead']);
    expect(who('cycle:work')).toEqual(['admin', 'co_lead', 'contributor', 'engagement_lead', 'lead']);
    expect(who('cycle:read')).toEqual(['admin', 'co_lead', 'contributor', 'engagement_lead', 'lead', 'reviewer', 'viewer']);
    expect(ROLE_PERMISSIONS.external_reviewer).not.toContain('cycle:read');
  });

  it('the Trash knows the cycle kind', () => expect(TRASH_KINDS).toContain('cycle'));
});
