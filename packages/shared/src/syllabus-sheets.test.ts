import { describe, expect, it } from 'vitest';
import { DEFAULT_OUTCOME_LEVELS } from './outcomes.js';
import { checkSyllabus, DEFAULT_SYLLABUS_SETTINGS, emptySyllabus, type SyllabusContent } from './syllabus.js';
import { emptyWorkbook, syllabusToWorkbook, SYLLABUS_SHEETS, workbookToSyllabi, type ExportContext, type SheetResolver } from './syllabus-sheets.js';

const plos = [{ id: 'plo1', code: 'PLO1', programName: 'BS Mechanical' }, { id: 'plo2', code: 'PLO2', programName: 'BS Mechanical' }];
const courses = [{ id: 'c1', code: 'MCE 410' }, { id: 'c2', code: 'MCE 300' }];
const resolver: SheetResolver = { levels: DEFAULT_OUTCOME_LEVELS, plo: (_c, t) => plos.find((p) => p.code === t.trim().toUpperCase())?.id ?? '', courseId: (c) => courses.find((x) => x.code === c)?.id };
const ex: ExportContext = { code: 'MCE 410', levels: DEFAULT_OUTCOME_LEVELS, plos, courses };

function sample(): SyllabusContent {
  const c = emptySyllabus();
  c.info = { titleEn: 'Heat Transfer', titleAr: 'انتقال الحرارة', credits: 3, languageOfDelivery: 'english', contactLecture: 3, contactLab: 0, contactOther: 0, courseType: 'didactic', courseLevel: '400', category: 'program_core', sustainability: 'none', prerequisiteIds: ['c2'], corequisiteIds: [] };
  c.description = { en: 'Conduction, convection and radiation.', ar: '' }; c.methodology = 'Lectures.'; c.assessmentNotes = { passPercentage: 'Pass at 60%', howItWorks: '' };
  c.materials = [{ kind: 'textbook', citation: 'Incropera, Fundamentals', isbn: '978-1', year: 2017 }];
  c.clos = [{ id: 'a', code: 'CLO1', textEn: 'Analyse conduction', textAr: '', bloom: 'analyze', ploId: 'plo1', level: 'R' }, { id: 'b', code: 'CLO2', textEn: 'Design an exchanger', textAr: '', bloom: 'create', ploId: 'plo2', level: 'M' }];
  c.rubrics = [{ id: 'r', title: 'Problem solving', levels: [{ name: 'Proficient', min: 70, max: 100 }, { name: 'Developing', min: 0, max: 69 }], criteria: [{ name: 'Method', descriptions: ['Sound', 'Partly sound'] }, { name: 'Accuracy', descriptions: ['High', 'Low'] }] }];
  c.assessments = [{ id: 'q', name: 'Quizzes', category: 'quiz', objective: 'Check basics', weight: 40, dueWeek: 6, clos: [{ cloId: 'a', share: 100, rubricId: 'r' }] }, { id: 'f', name: 'Final', category: 'final', objective: '', weight: 60, dueWeek: 15, clos: [{ cloId: 'a', share: 40, rubricId: 'r' }, { cloId: 'b', share: 60, rubricId: 'r' }] }];
  c.outline = [{ week: 1, topic: 'Introduction', reading: 'Ch 1', lab: '', cloIds: ['a'], sdgs: ['7', '9'], assessmentId: '', activity: '' }, { week: 6, topic: 'Quiz week', reading: '', lab: '', cloIds: ['a', 'b'], sdgs: [], assessmentId: 'q', activity: '' }];
  return c;
}
/** The document without its generated ids, so two can be compared. */
const plain = (c: SyllabusContent) => {
  const cloCode = (id: string) => c.clos.find((x) => x.id === id)?.code;
  return JSON.parse(JSON.stringify({
    ...c, clos: c.clos.map((x) => ({ ...x, id: undefined })), rubrics: c.rubrics.map((x) => ({ ...x, id: undefined })),
    assessments: c.assessments.map((a) => ({ name: a.name, category: a.category, objective: a.objective, weight: a.weight, dueWeek: a.dueWeek, clos: a.clos.map((l) => ({ clo: cloCode(l.cloId), share: l.share, rubric: c.rubrics.find((r) => r.id === l.rubricId)?.title })) })),
    outline: c.outline.map((w) => ({ ...w, cloIds: w.cloIds.map(cloCode), assessmentId: c.assessments.find((a) => a.id === w.assessmentId)?.name ?? '' })),
  })) as unknown;
};

describe('the syllabus workbook', () => {
  it('has the six sheets with their headers', () => {
    expect(Object.values(SYLLABUS_SHEETS).map((s) => s.name)).toEqual(['Courses', 'CLOs', 'Outline', 'Materials', 'Assessments', 'Rubrics']);
  });

  it('survives the round trip: export a syllabus, import it, and get the same syllabus back', () => {
    const wb = syllabusToWorkbook(sample(), ex);
    expect(wb.assessments).toHaveLength(3); // one row per assessed CLO
    expect(wb.rubrics).toHaveLength(4);     // one row per criterion and level
    const back = workbookToSyllabi(wb, resolver).get('MCE 410')!;
    expect(plain(back)).toEqual(plain(sample()));
    expect(checkSyllabus(back, { settings: { ...DEFAULT_SYLLABUS_SETTINGS, minClos: 2 }, levels: DEFAULT_OUTCOME_LEVELS }).filter((x) => x.severity === 'error').map((x) => x.code)).toEqual([]);
  });

  it('reads headers however they are spelled or cased, and a label or its code', () => {
    const wb = emptyWorkbook();
    wb.courses.push({ 'COURSE CODE': ' mce 410 ', 'title (english)': 'Heat', 'Language': 'x', 'Language of Delivery': 'Bilingual', 'course category': 'Program core', 'Course type': 'independent_study', 'Course level': '300', 'sustainability indicator': 'Sustainability-related' });
    wb.clos.push({ 'course code': 'MCE 410', 'clo': 'CLO1', 'outcome (english)': 'x', 'Bloom Level': 'Analyze', 'plo': 'plo2', 'coverage': 'D' }, { 'course code': 'MCE 410', 'clo': 'CLO2', 'outcome (english)': 'y', 'coverage': 'Mastered' });
    const d = workbookToSyllabi(wb, resolver).get('MCE 410')!;
    expect(d.info).toMatchObject({ titleEn: 'Heat', languageOfDelivery: 'bilingual', category: 'program_core', courseType: 'independent_study', courseLevel: '300', sustainability: 'related' });
    expect(d.clos.map((x) => [x.bloom, x.ploId, x.level])).toEqual([['analyze', 'plo2', 'R'], ['', '', 'M']]);
  });

  it('never refuses what it cannot read: unknown words become empty and the rule checker flags them', () => {
    const wb = emptyWorkbook();
    wb.courses.push({ 'Course code': 'MCE 410', 'Language of delivery': 'Klingon', 'Credit hours': 'three' });
    wb.clos.push({ 'Course code': 'MCE 410', CLO: 'CLO1', 'Outcome (English)': 'x', PLO: 'PLO99', Coverage: 'Somewhat' });
    wb.assessments.push({ 'Course code': 'MCE 410', Assessment: 'Quiz', 'CLO': 'CLO1', Rubric: 'No such rubric', 'Share of assessment %': 100 });
    const d = workbookToSyllabi(wb, resolver).get('MCE 410')!;
    expect(d.info.languageOfDelivery).toBe(''); expect(d.info.credits).toBeNull();
    expect(d.clos[0]).toMatchObject({ ploId: '', level: '' }); expect(d.assessments[0]!.clos[0]!.rubricId).toBe('');
    const codes = checkSyllabus(d, { settings: DEFAULT_SYLLABUS_SETTINGS, levels: DEFAULT_OUTCOME_LEVELS }).map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['info.language', 'info.credits', 'clo.plo', 'clo.level', 'assessment.rubric']));
  });

  it('keeps the identity of a CLO the course already has', () => {
    const wb = syllabusToWorkbook(sample(), ex);
    const d = workbookToSyllabi(wb, { ...resolver, cloId: (_c, k) => (k === 'CLO1' ? 'existing-id' : undefined) }).get('MCE 410')!;
    expect(d.clos[0]!.id).toBe('existing-id');
    expect(d.assessments[0]!.clos[0]!.cloId).toBe('existing-id');
  });
});
