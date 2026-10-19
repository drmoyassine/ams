// The template editor's model (TASK-079): stored <-> editing round trip, keys made from names, the plain-words checks, and what
// removing an output does to the inputs that read it.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CYCLE_TEMPLATES } from '@ams/shared';
import { adoptKeys, check, fromDefs, move, newInput, newOutput, newStage, removeOutput, removeStage, slug, timeline, toDefs, uniqueKey } from './editor-model';

describe('editor model', () => {
  it.each(DEFAULT_CYCLE_TEMPLATES.map((t) => [t.key, t] as const))('%s: stored -> editing -> stored changes nothing, and has no problem to fix', (_key, t) => {
    const stages = fromDefs(t.stages);
    expect(toDefs(stages)).toEqual(t.stages);
    expect(check({ name: t.name }, stages).filter((p) => p.level !== 'note')).toEqual([]);
  });

  it('makes keys from names (ASCII, unique) and falls back for Arabic-only names', () => {
    expect(slug('Self-evaluation report', 'x')).toBe('self_evaluation_report');
    expect(slug('2nd review', 'stage')).toBe('stage_2nd_review');
    expect(slug('جمع الأدلة', 'stage')).toBe('stage');
    expect(uniqueKey('stage', ['stage', 'stage_2'])).toBe('stage_3');
    const a = newStage('Collect', undefined);
    const b = newStage('Collect', a);
    const defs = toDefs([a, { ...b, nameAr: 'جمع' }]);
    expect(defs.map((d) => d.key)).toEqual(['collect', 'collect_2']);
    expect(defs[1]!.nameAr).toBe('جمع');
    expect(adoptKeys([a, b], defs)[1]!.key).toBe('collect_2');
  });

  it('starts a new stage where the last one ends', () => {
    const a = { ...newStage('A', undefined), start: '10', length: '5' };
    expect(newStage('B', a)).toMatchObject({ start: '15', length: '14' });
  });

  it('explains a stage that reads a later one, a loop, and a stage or output that is not there, by names', () => {
    const [collect, review, final] = fromDefs(DEFAULT_CYCLE_TEMPLATES.find((t) => t.key === 'annual_program_report')!.stages.filter((s) => ['collect', 'qa_review', 'final'].includes(s.key)));
    // Final report above QA review: it reads the QA sign-off, which now comes after it.
    const later = check({ name: 'T' }, [collect!, final!, review!]).filter((p) => p.code === 'later');
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ stage: 1, scope: 'input', params: { n: 2, stage: 'Final report', from: 'QA review' } });
    // A raw key that matches nothing.
    const broken = { ...final!, inputs: [{ ...final!.inputs[0]!, refStage: 'raw:ghost', refOutput: 'raw:out' }] };
    expect(check({ name: 'T' }, [collect!, broken]).find((p) => p.code === 'missingStage')?.params).toMatchObject({ stage: 'ghost' });
    // A circle: stage 1 reads stage 2's output and stage 2 reads stage 1's.
    const a = { ...newStage('Alpha', undefined), outputs: [newOutput('Out A')] };
    const b = { ...newStage('Beta', a), outputs: [newOutput('Out B')] };
    const read = (stage: typeof a, from: typeof a) => ({ ...stage, inputs: [{ ...newInput('In'), source: 'stage_output' as const, refStage: from.uid, refOutput: from.outputs[0]!.uid }] });
    const loop = check({ name: 'T' }, [read(a, b), read(b, a)]).find((p) => p.code === 'loop');
    expect(loop?.params.chain).toMatch(/^(Alpha → Beta → Alpha|Beta → Alpha → Beta)$/);
  });

  it('finds the things a draft may not be saved with, and notes what is only worth knowing', () => {
    const s = { ...newStage('', undefined), start: 'x', length: '-3', outputs: [{ ...newOutput(''), kind: 'approval' as const }, newOutput('Fine')], inputs: [newInput('')] };
    const codes = check({ name: ' ' }, [s]).map((p) => `${p.code}:${p.level}`);
    expect(codes).toEqual(expect.arrayContaining([
      'templateName:save', 'stageName:save', 'startDays:save', 'lengthDays:save', 'outputName:save', 'noApprover:note', 'inputName:save',
    ]));
    expect(check({ name: 'T' }, []).map((p) => `${p.code}:${p.level}`)).toEqual(['noStages:publish']);
  });

  it('turns inputs that read a removed output or stage into "something the stage owner picks"', () => {
    const annual = fromDefs(DEFAULT_CYCLE_TEMPLATES.find((t) => t.key === 'annual_program_report')!.stages);
    const out = annual[1]!.outputs[0]!;   // the self-evaluation report, read by three later stages
    const r = removeOutput(annual, out.uid);
    expect(r.changed).toBe(3);
    expect(r.stages[2]!.inputs[0]).toMatchObject({ source: 'pick', pick: 'any', refStage: '', refOutput: '' });
    expect(check({ name: 'T' }, r.stages).filter((p) => p.level !== 'note')).toEqual([]);
    const s = removeStage(annual, annual[0]!.uid);
    expect(s.stages).toHaveLength(4);
    expect(s.changed).toBe(1);   // "Self-evaluation" read the collection summary
    // The previous-cycle input that read the final report is untouched when another stage goes.
    expect(removeStage(annual, annual[2]!.uid).stages[0]!.inputs[0]).toMatchObject({ source: 'previous_cycle' });
  });

  it('moves stages without breaking what reads them, and draws the timeline from the days', () => {
    const annual = fromDefs(DEFAULT_CYCLE_TEMPLATES.find((t) => t.key === 'annual_program_report')!.stages);
    const moved = move(annual, 3, -1);
    expect(moved.map((s) => s.name)).toEqual(['Collect', 'Self-evaluation', 'QA review', 'Review by the head of the unit', 'Final report']);
    expect(toDefs(moved).find((d) => d.key === 'final')!.inputs[1]!.from).toEqual({ stage: 'qa_review', output: 'qa_signoff' });
    expect(move(annual, 0, -1).map((s) => s.uid)).toEqual(annual.map((s) => s.uid));
    const t = timeline(annual);
    expect(t.rows.map((r) => [r.start, r.end])).toEqual([[0, 30], [30, 60], [60, 70], [70, 84], [84, 98]]);
    expect(t.total).toBe(98);
  });
});
