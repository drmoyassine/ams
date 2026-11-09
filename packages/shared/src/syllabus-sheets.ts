// The syllabus as an Excel workbook (DEC-038, TASK-126): six sheets, one row per course, CLO, week, material, assessed CLO or rubric
// cell, joined by the course code. The same functions turn a workbook into syllabi (import, upsert) and a syllabus into a workbook (export),
// so a syllabus survives the round trip. Reading is forgiving (header spelling and case, a label or its code); a cell it cannot understand
// is left empty and the rule checker flags it, because a rule never stops an import.
import { z } from 'zod';
import { resolveOutcomeLevel, type OutcomeLevel } from './outcomes.js';
import { emptySyllabus, LABEL, type SyllabusContent } from './syllabus.js';

export const SYLLABUS_SHEETS = {
  courses: { name: 'Courses', headers: ['Course code', 'Title (English)', 'Title (Arabic)', 'Credit hours', 'Lecture hours', 'Lab hours', 'Other hours', 'Language of delivery', 'Course type', 'Course level', 'Course category', 'Sustainability indicator', 'Prerequisites', 'Co-requisites', 'Description (English)', 'Description (Arabic)', 'Teaching methodology', 'Pass percentage and submission details', 'How assessments work'] },
  clos: { name: 'CLOs', headers: ['Course code', 'CLO', 'Outcome (English)', 'Outcome (Arabic)', 'Bloom level', 'PLO', 'Coverage'] },
  outline: { name: 'Outline', headers: ['Course code', 'Week', 'Topic', 'Reading', 'Lab / other sessions', 'CLOs', 'SDGs', 'Assessment'] },
  materials: { name: 'Materials', headers: ['Course code', 'Kind', 'Citation', 'ISBN', 'Year'] },
  assessments: { name: 'Assessments', headers: ['Course code', 'Assessment', 'Category', 'Objective', '% of grade', 'Due week', 'CLO', 'Share of assessment %', 'Rubric'] },
  rubrics: { name: 'Rubrics', headers: ['Course code', 'Rubric', 'Criterion', 'Level', 'From', 'To', 'Description'] },
  /** The sections an admin added to the template: one row per course and section. */
  sections: { name: 'Sections', headers: ['Course code', 'Section', 'Text'] },
} as const;
export type SheetKey = keyof typeof SYLLABUS_SHEETS;
export type SheetRow = Record<string, string | number | null>;
/** A workbook as the sheets' rows, each row keyed by its header as written. */
export interface SyllabusWorkbook { courses: SheetRow[]; clos: SheetRow[]; outline: SheetRow[]; materials: SheetRow[]; assessments: SheetRow[]; rubrics: SheetRow[]; sections: SheetRow[] }
const rows = z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(20000).default([]);
export const SyllabusWorkbookSchema: z.ZodType<SyllabusWorkbook, SyllabusWorkbook> = z.object({ courses: rows, clos: rows, outline: rows, materials: rows, assessments: rows, rubrics: rows, sections: rows }).strict() as unknown as z.ZodType<SyllabusWorkbook, SyllabusWorkbook>;
export const emptyWorkbook = (): SyllabusWorkbook => ({ courses: [], clos: [], outline: [], materials: [], assessments: [], rubrics: [], sections: [] });

const norm = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');
/** A row's cell by header, however the header is spelled or cased. */
function cell(r: SheetRow, header: string): string {
  const want = norm(header);
  for (const [k, v] of Object.entries(r)) if (norm(k) === want) return v === null || v === undefined ? '' : String(v).trim();
  return '';
}
const numOf = (s: string): number | null => { if (s === '') return null; const n = Number(s.replace('%', '').trim()); return Number.isNaN(n) ? null : n; };
/** A vocabulary value from its id or its label ("Program core" or "program_core"). */
const vocab = (s: string, ids: readonly string[]): string => {
  const w = norm(s);
  return ids.find((id) => norm(id) === w || norm(LABEL[id] ?? '') === w) ?? '';
};
const list = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const code = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toUpperCase();

export interface SheetResolver {
  levels: OutcomeLevel[];
  /** The PLO a cell names (its code, optionally with the program), for the course; '' when it names none. */
  plo(courseCode: string, text: string): string;
  /** The CLO the course already has with this code (to keep its identity), if any. */
  cloId?(courseCode: string, cloCode: string): string | undefined;
  /** The course a code in a Prerequisites cell names. */
  courseId(courseCode: string): string | undefined;
  /** The sections an admin added to the template (key and title), so a Sections sheet row finds its key. */
  customSections?: { key: string; title: string }[];
}
const BLOOM = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
const LANG = ['english', 'arabic', 'bilingual'];
const TYPES = ['didactic', 'lab', 'studio', 'internship', 'independent_study', 'project'];
const CATS = ['general_education', 'program_core', 'program_elective', 'free_elective'];
const SUST = ['focused', 'related', 'none'];
const KINDS = ['textbook', 'recommended', 'material', 'software'];
const ACATS = ['quiz', 'assignment', 'midterm', 'final', 'project', 'lab', 'presentation', 'participation', 'other'];
const LEVELS = ['100', '200', '300', '400'];

/** The syllabi a workbook holds, by course code (upper-case). Courses named only on other sheets are included too. */
export function workbookToSyllabi(wb: SyllabusWorkbook, rs: SheetResolver): Map<string, SyllabusContent> {
  const out = new Map<string, SyllabusContent>();
  const doc = (c: string) => { const k = code(c); if (!out.has(k)) out.set(k, emptySyllabus()); return out.get(k)!; };
  const newId = () => crypto.randomUUID();

  for (const r of wb.courses) {
    const cc = cell(r, 'Course code'); if (!cc) continue;
    const d = doc(cc);
    d.info = {
      titleEn: cell(r, 'Title (English)'), titleAr: cell(r, 'Title (Arabic)'), credits: numOf(cell(r, 'Credit hours')), languageOfDelivery: vocab(cell(r, 'Language of delivery'), LANG),
      contactLecture: numOf(cell(r, 'Lecture hours')), contactLab: numOf(cell(r, 'Lab hours')), contactOther: numOf(cell(r, 'Other hours')),
      courseType: vocab(cell(r, 'Course type'), TYPES), courseLevel: vocab(cell(r, 'Course level'), LEVELS), category: vocab(cell(r, 'Course category'), CATS), sustainability: vocab(cell(r, 'Sustainability indicator'), SUST),
      prerequisiteIds: list(cell(r, 'Prerequisites')).map((x) => rs.courseId(code(x))).filter((x): x is string => !!x),
      corequisiteIds: list(cell(r, 'Co-requisites')).map((x) => rs.courseId(code(x))).filter((x): x is string => !!x),
    };
    d.description = { en: cell(r, 'Description (English)'), ar: cell(r, 'Description (Arabic)') };
    d.methodology = cell(r, 'Teaching methodology');
    d.assessmentNotes = { passPercentage: cell(r, 'Pass percentage and submission details'), howItWorks: cell(r, 'How assessments work') };
  }
  const cloOf = (cc: string, text: string) => doc(cc).clos.find((x) => norm(x.code) === norm(text));
  for (const r of wb.clos) {
    const cc = cell(r, 'Course code'); const text = cell(r, 'Outcome (English)');
    if (!cc || (!cell(r, 'CLO') && !text)) continue;
    const d = doc(cc);
    const cloCode = cell(r, 'CLO') || `CLO${d.clos.length + 1}`;
    d.clos.push({
      id: rs.cloId?.(code(cc), cloCode) ?? newId(), code: cloCode, textEn: text, textAr: cell(r, 'Outcome (Arabic)'), bloom: vocab(cell(r, 'Bloom level'), BLOOM),
      ploId: cell(r, 'PLO') ? rs.plo(code(cc), cell(r, 'PLO')) : '',
      level: (() => { const t = cell(r, 'Coverage'); return resolveOutcomeLevel(rs.levels, t) ?? rs.levels.find((l) => norm(l.name) === norm(t))?.code ?? ''; })(),
    });
  }
  const assessmentByName = new Map<string, string>();
  for (const r of wb.assessments) {
    const cc = cell(r, 'Course code'); const name = cell(r, 'Assessment');
    if (!cc || !name) continue;
    const d = doc(cc); const key = `${code(cc)}|${norm(name)}`;
    let a = d.assessments.find((x) => assessmentByName.get(key) === x.id);
    if (!a) { a = { id: newId(), name, category: vocab(cell(r, 'Category'), ACATS), objective: cell(r, 'Objective'), weight: numOf(cell(r, '% of grade')), dueWeek: numOf(cell(r, 'Due week')), clos: [] }; d.assessments.push(a); assessmentByName.set(key, a.id); }
    const clo = cell(r, 'CLO') ? cloOf(cc, cell(r, 'CLO')) : undefined;
    if (clo) a.clos.push({ cloId: clo.id, share: numOf(cell(r, 'Share of assessment %')), rubricId: cell(r, 'Rubric') });   // the rubric's title, made an id below
  }
  const rubricKey = new Map<string, string>();
  for (const r of wb.rubrics) {
    const cc = cell(r, 'Course code'); const title = cell(r, 'Rubric');
    if (!cc || !title) continue;
    const d = doc(cc); const key = `${code(cc)}|${norm(title)}`;
    let rub = d.rubrics.find((x) => rubricKey.get(key) === x.id);
    if (!rub) { rub = { id: newId(), title, levels: [], criteria: [] }; d.rubrics.push(rub); rubricKey.set(key, rub.id); }
    const lvl = cell(r, 'Level');
    let li = rub.levels.findIndex((l) => norm(l.name) === norm(lvl));
    if (li < 0 && lvl) { rub.levels.push({ name: lvl, min: numOf(cell(r, 'From')), max: numOf(cell(r, 'To')) }); li = rub.levels.length - 1; for (const k of rub.criteria) k.descriptions.push(''); }
    const crit = cell(r, 'Criterion');
    if (!crit) continue;
    let ci = rub.criteria.findIndex((k) => norm(k.name) === norm(crit));
    if (ci < 0) { rub.criteria.push({ name: crit, descriptions: rub.levels.map(() => '') }); ci = rub.criteria.length - 1; }
    if (li >= 0) rub.criteria[ci]!.descriptions[li] = cell(r, 'Description');
  }
  // Assessments name their rubric by title; make it the rubric's id (a title that matches none stays empty, and is flagged).
  for (const [cc, d] of out) for (const a of d.assessments) for (const l of a.clos) l.rubricId = rubricKey.get(`${cc}|${norm(l.rubricId)}`) ?? '';
  for (const r of wb.outline) {
    const cc = cell(r, 'Course code'); if (!cc) continue;
    const d = doc(cc);
    const ass = cell(r, 'Assessment');
    d.outline.push({
      week: numOf(cell(r, 'Week')), topic: cell(r, 'Topic'), reading: cell(r, 'Reading'), lab: cell(r, 'Lab / other sessions'),
      cloIds: list(cell(r, 'CLOs')).map((x) => cloOf(cc, x)?.id).filter((x): x is string => !!x), sdgs: list(cell(r, 'SDGs')).filter((x) => /^(1[0-7]|[1-9])$/.test(x)),
      assessmentId: ass ? d.assessments.find((a) => norm(a.name) === norm(ass))?.id ?? '' : '', activity: '',
    });
  }
  for (const r of wb.materials) {
    const cc = cell(r, 'Course code'); if (!cc || !cell(r, 'Citation')) continue;
    doc(cc).materials.push({ kind: vocab(cell(r, 'Kind'), KINDS), citation: cell(r, 'Citation'), isbn: cell(r, 'ISBN'), year: numOf(cell(r, 'Year')) });
  }
  for (const r of wb.sections) {
    const cc = cell(r, 'Course code'); const sec = cell(r, 'Section'); const text = cell(r, 'Text');
    if (!cc || !sec || !text) continue;
    const key = rs.customSections?.find((x) => norm(x.title) === norm(sec) || norm(x.key) === norm(sec))?.key;
    if (key) doc(cc).custom[key] = text;
  }
  return out;
}

export interface ExportContext { code: string; levels: OutcomeLevel[]; plos: { id: string; code: string; programName: string }[]; courses: { id: string; code: string }[]; customSections?: { key: string; title: string }[] }
const put = (headers: readonly string[], values: (string | number | null)[]): SheetRow => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? null]));

/** One syllabus as the rows of the six sheets (a template when the content is empty). */
export function syllabusToWorkbook(c: SyllabusContent, ex: ExportContext): SyllabusWorkbook {
  const S = SYLLABUS_SHEETS; const i = c.info;
  const lbl = (v: string) => (v ? LABEL[v] ?? v : '');
  const codeOf = (id: string) => ex.courses.find((x) => x.id === id)?.code ?? '';
  const cloCode = (id: string) => c.clos.find((x) => x.id === id)?.code ?? '';
  const wb = emptyWorkbook();
  wb.courses.push(put(S.courses.headers, [ex.code, i.titleEn, i.titleAr, i.credits, i.contactLecture, i.contactLab, i.contactOther, lbl(i.languageOfDelivery), lbl(i.courseType), i.courseLevel, lbl(i.category), lbl(i.sustainability),
    i.prerequisiteIds.map(codeOf).join(', '), i.corequisiteIds.map(codeOf).join(', '), c.description.en, c.description.ar, c.methodology, c.assessmentNotes.passPercentage, c.assessmentNotes.howItWorks]));
  for (const x of c.clos) wb.clos.push(put(S.clos.headers, [ex.code, x.code, x.textEn, x.textAr, lbl(x.bloom), ex.plos.find((p) => p.id === x.ploId)?.code ?? '', ex.levels.find((l) => l.code === x.level)?.name ?? x.level]));
  for (const w of c.outline) wb.outline.push(put(S.outline.headers, [ex.code, w.week, w.topic, w.reading, w.lab, w.cloIds.map(cloCode).join(', '), w.sdgs.join(', '), c.assessments.find((a) => a.id === w.assessmentId)?.name ?? '']));
  for (const m of c.materials) wb.materials.push(put(S.materials.headers, [ex.code, lbl(m.kind), m.citation, m.isbn, m.year]));
  for (const a of c.assessments) {
    if (!a.clos.length) wb.assessments.push(put(S.assessments.headers, [ex.code, a.name, lbl(a.category), a.objective, a.weight, a.dueWeek, '', null, '']));
    for (const l of a.clos) wb.assessments.push(put(S.assessments.headers, [ex.code, a.name, lbl(a.category), a.objective, a.weight, a.dueWeek, cloCode(l.cloId), l.share, c.rubrics.find((r) => r.id === l.rubricId)?.title ?? '']));
  }
  for (const r of c.rubrics) for (const k of r.criteria) r.levels.forEach((l, j) => wb.rubrics.push(put(S.rubrics.headers, [ex.code, r.title, k.name, l.name, l.min, l.max, k.descriptions[j] ?? ''])));
  for (const sec of ex.customSections ?? []) if (c.custom[sec.key]?.trim()) wb.sections.push(put(S.sections.headers, [ex.code, sec.title, c.custom[sec.key]!]));
  return wb;
}
