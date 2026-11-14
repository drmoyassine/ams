// The curriculum map as a matrix (DEC-039): PLO cells from the course's own level or its CLOs', ILO cells through linked PLOs,
// study-year groups and totals.
import { describe, expect, it } from 'vitest';
import { curriculumMatrix, DEFAULT_OUTCOME_LEVELS, type LearningOutcome, type ProgramOutcomes } from './index.js';

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const outcome = (kind: LearningOutcome['kind'], code: string, extra: Partial<LearningOutcome> = {}): LearningOutcome => ({
  id: id(), kind, programId: null, courseId: null, parentId: null, code, textEn: code, textAr: null, bloomLevel: null, displayOrder: 0, status: 'draft',
  approvedOn: null, approvalRef: null, source: null, ...extra,
});

describe('curriculumMatrix', () => {
  it('reads PLO cells top-down or from CLOs, derives ILO cells through linked PLOs, groups by year and counts', () => {
    const [so1, so2, so3] = [outcome('plo', 'SO1'), outcome('plo', 'SO2'), outcome('plo', 'SO3', { status: 'retired' })];
    const [ilo1, ilo2] = [outcome('ilo', 'ILO1'), outcome('ilo', 'ILO2')];
    const clo = outcome('clo', 'CLO1');
    const c1 = id(); const c2 = id(); const c3 = id();
    const v = {
      programId: id(), levels: DEFAULT_OUTCOME_LEVELS, peos: [], plos: [so1, so2, so3], indicators: [], ilos: [ilo1, ilo2],
      courses: [
        { courseId: c1, code: 'ENG 101', titleEn: 'Intro', role: 'core', year: 1, term: 1, clos: [clo] },
        { courseId: c2, code: 'ENG 401', titleEn: 'Capstone', role: 'core', year: 4, term: 2, clos: [] },
        { courseId: c3, code: 'GEN 100', titleEn: 'Writing', role: 'service', year: null, term: null, clos: [] },
      ],
      links: [{ fromId: clo.id, toId: so1.id, level: 'I' }, { fromId: so1.id, toId: ilo1.id, level: null }, { fromId: so2.id, toId: ilo1.id, level: null }],
      map: [
        { ploId: so1.id, courseId: c1, topDown: null, levels: ['I'], highest: 'I' },
        { ploId: so1.id, courseId: c2, topDown: 'M', levels: [], highest: null },
        { ploId: so2.id, courseId: c2, topDown: 'R', levels: [], highest: null },
      ],
      coverage: [],
    } as ProgramOutcomes;
    const m = curriculumMatrix(v);
    expect(m.plos.map((p) => p.code)).toEqual(['SO1', 'SO2']);
    expect(m.groups.map((g) => [g.year, g.rows.map((r) => r.code)])).toEqual([[1, ['ENG 101']], [4, ['ENG 401']], [null, ['GEN 100']]]);
    const [r1, r2] = [m.groups[0]!.rows[0]!, m.groups[1]!.rows[0]!];
    expect(r1.cells[so1.id]).toEqual({ level: 'I', from: 'clo', warn: false, via: [] });
    expect(r2.cells[so1.id]).toMatchObject({ level: 'M', from: 'top', warn: true });
    // ILO1 is reached through SO1 and SO2: the highest of the two; ILO2 is linked to no PLO.
    expect(r2.cells[ilo1.id]).toEqual({ level: 'M', from: 'via', warn: false, via: ['SO1', 'SO2'] });
    expect(r1.cells[ilo1.id]).toMatchObject({ level: 'I', via: ['SO1'] });
    expect(r1.cells[ilo2.id]).toBeUndefined();
    expect(m.totals[so1.id]).toEqual({ I: 1, M: 1 });
    expect(m.totals[ilo1.id]).toEqual({ I: 1, M: 1 });
  });
});
