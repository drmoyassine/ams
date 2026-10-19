// The shipped default cycle templates (TASK-079): data that passes the same checks as any template, with Arabic names, internal
// approval wording only, and no accreditor named (DEC-002, DEC-005).
import { describe, expect, it } from 'vitest';
import { CreateCycleTemplateSchema, DEFAULT_CYCLE_TEMPLATES, DEFAULT_CYCLE_TEMPLATE_KEYS, validateTemplateStages } from './index.js';

describe('default cycle templates', () => {
  it('are the six the plan names, with unique keys', () => {
    expect(DEFAULT_CYCLE_TEMPLATE_KEYS).toEqual(['annual_program_report', 'periodic_program_review', 'admin_unit_review', 'internal_audit', 'course_assessment', 'custom']);
    expect(new Set(DEFAULT_CYCLE_TEMPLATE_KEYS).size).toBe(6);
  });

  it.each(DEFAULT_CYCLE_TEMPLATES.map((t) => [t.key, t] as const))('%s is well formed, consistent and has at least one stage', (_key, t) => {
    expect(CreateCycleTemplateSchema.safeParse(t).success).toBe(true);
    expect(t.stages.length).toBeGreaterThan(0);
    expect(validateTemplateStages(t.stages)).toEqual([]);
    expect(t.origin).toBe('default');
  });

  it.each(DEFAULT_CYCLE_TEMPLATES.map((t) => [t.key, t] as const))('%s is named in Arabic too, at every level', (_key, t) => {
    expect(t.nameAr).toMatch(/[؀-ۿ]/);
    for (const s of t.stages) {
      expect(s.nameAr, s.key).toMatch(/[؀-ۿ]/);
      for (const o of s.outputs) expect(o.nameAr, `${s.key}/${o.key}`).toMatch(/[؀-ۿ]/);
      for (const i of s.inputs) expect(i.nameAr, `${s.key}/${i.key}`).toMatch(/[؀-ۿ]/);
    }
  });

  it('hold the annual program report shape: collect -> self-evaluation -> unit head -> QA -> final, last year\'s final report read by Collect', () => {
    const t = DEFAULT_CYCLE_TEMPLATES.find((x) => x.key === 'annual_program_report')!;
    expect(t.stages.map((s) => s.key)).toEqual(['collect', 'self_evaluation', 'unit_review', 'qa_review', 'final']);
    expect(t.stages[0]!.inputs.find((i) => i.key === 'last_final')!.from).toEqual({ previousCycle: { stage: 'final', output: 'final_report' } });
    expect(t.stages[1]!.outputs[0]).toMatchObject({ kind: 'report' });
    expect(t.stages[2]!.outputs[0]).toMatchObject({ kind: 'approval', approver: { kind: 'head_of_unit' } });
    expect(t.stages[3]!.outputs[0]).toMatchObject({ kind: 'approval' });
    expect(t.stages[4]!.outputs.map((o) => o.kind)).toEqual(['report', 'document']);
  });

  it('every approval names who approves, and nothing says met, compliant or a score', () => {
    const text: string[] = [];
    for (const t of DEFAULT_CYCLE_TEMPLATES) {
      text.push(t.name, t.description ?? '');
      for (const s of t.stages) {
        text.push(s.name, s.process, ...s.checklist);
        for (const o of s.outputs) { text.push(o.name); if (o.kind === 'approval') expect(o.approver, `${t.key}/${s.key}/${o.key}`).toBeDefined(); }
        for (const i of s.inputs) text.push(i.name);
      }
    }
    expect(text.join('\n')).not.toMatch(/\b(met|compliant|compliance|readiness|score|predicted)\b/i);
  });
});
