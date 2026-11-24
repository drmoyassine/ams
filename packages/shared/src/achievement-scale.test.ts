// The achievement scale and the rubric templates (the owner, 2026-11-24): one institution scale every rubric is described at, and the
// templates a course starts from (one per kind of assessment).
import { describe, expect, it } from 'vitest';
import {
  AchievementScaleSchema, DEFAULT_ACHIEVEMENT_SCALE, DEFAULT_RUBRIC_TEMPLATES, DEFAULT_SYLLABUS_SETTINGS, RubricTemplatesSchema, checkSyllabus, emptySyllabus,
  rubricFromTemplate, templateFor,
} from './index.js';
import { DEFAULT_OUTCOME_LEVELS } from './outcomes.js';

describe('the achievement scale', () => {
  it('lists levels from highest to lowest without overlaps, with one target level', () => {
    expect(AchievementScaleSchema.safeParse(DEFAULT_ACHIEVEMENT_SCALE).success).toBe(true);
    const overlap = { levels: [{ name: 'High', min: 60, max: 100 }, { name: 'Low', min: 0, max: 70 }], target: 0 };
    expect(AchievementScaleSchema.safeParse(overlap).error!.issues[0]!.message).toMatch(/Low overlaps High/);
    expect(AchievementScaleSchema.safeParse({ ...DEFAULT_ACHIEVEMENT_SCALE, target: 7 }).success).toBe(false);
    expect(AchievementScaleSchema.safeParse({ levels: [{ name: 'Only', min: 0, max: 100 }], target: 0 }).success).toBe(false);
  });
});

describe('rubric templates', () => {
  it('give each assessment type its starting rubric, written against the scale', () => {
    expect(templateFor(DEFAULT_RUBRIC_TEMPLATES, 'midterm')!.title).toBe('Exam or quiz question');
    expect(templateFor(DEFAULT_RUBRIC_TEMPLATES, 'presentation')!.title).toBe('Presentation');
    expect(templateFor(DEFAULT_RUBRIC_TEMPLATES, '')!.title).toBe('General');
    const r = rubricFromTemplate(DEFAULT_RUBRIC_TEMPLATES[0]!, DEFAULT_ACHIEVEMENT_SCALE, 'r1');
    expect(r.levels.map((l) => l.name)).toEqual(['Exemplary', 'Proficient', 'Developing', 'Beginning']);
    expect(r.criteria.every((k) => k.descriptions.length === 4 && k.descriptions.every(Boolean))).toBe(true);
    expect(r.templateId).toBe('tpl-exam');
  });
  it('are one per type', () => {
    const twice = [DEFAULT_RUBRIC_TEMPLATES[0]!, { ...DEFAULT_RUBRIC_TEMPLATES[1]!, types: ['quiz'] }];
    expect(RubricTemplatesSchema.safeParse(twice).error!.issues[0]!.message).toMatch(/Quiz is the type of two templates/);
  });
});

describe('the rubric checks', () => {
  it('describe each criterion at every level of the scale, warn about a rubric written for another scale, and skip a rubric nothing uses', () => {
    const c = emptySyllabus();
    c.clos = [{ id: 'a', code: 'CLO1', textEn: 'x', textAr: '', bloom: 'apply', plos: [] }];
    const r = rubricFromTemplate(DEFAULT_RUBRIC_TEMPLATES[0]!, DEFAULT_ACHIEVEMENT_SCALE, 'r1');
    c.rubrics = [{ ...r, criteria: [{ name: 'Correctness', descriptions: ['a', 'b', '', 'd'] }] }, { id: 'unused', title: '', levels: [], criteria: [], templateId: '' }];
    c.assessments = [{ id: 'm', name: 'Midterm', category: 'midterm', weight: 100, dueWeek: 8, clos: [{ cloId: 'a', share: 100, rubricId: 'r1', part: 'Q1–Q4' }] }];
    const ctx = { settings: DEFAULT_SYLLABUS_SETTINGS, levels: DEFAULT_OUTCOME_LEVELS, scale: DEFAULT_ACHIEVEMENT_SCALE };
    const rubricIssues = (x: typeof c) => checkSyllabus(x, ctx).filter((i) => i.section === 'rubrics').map((i) => i.code);
    expect(rubricIssues(c)).toEqual(['rubric.descriptions']); // the unused one is not checked
    const old = { ...c, rubrics: [{ ...r, levels: [{ name: 'Good', min: 50, max: 100 }, { name: 'Poor', min: 0, max: 49 }] }] };
    expect(rubricIssues(old)).toContain('rubric.scale');
    expect(rubricIssues({ ...c, rubrics: [r] })).toEqual([]);
  });
});
