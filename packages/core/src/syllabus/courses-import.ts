// Courses from documents (DEC-044), the import target of the Courses tab's Docs section, built as the programs import (DEC-043): each
// window of pages yields the FACTS it states about courses (each with its quote); one more call puts the facts of every document together
// into one item per course and matches each to the institution's courses by meaning ("ECE420" is "ECE 420 Digital Signal Processing").
// A person reviews each course: which course it is (or new), and field by field what changes. Apply follows DEC-042: the record (code, SIS
// code, unit, year of study) and the programs it serves change at once; the content (title, credit hours, contact hours, description,
// methodology, CLOs) goes into the course's draft, approved as any draft. Nothing is deleted. One inverse takes the apply back.
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { course, courseProgram, learningOutcome, orgUnit, program, syllabusVersion } from '@ams/db';
import { BLOOM_LEVELS, SyllabusContentSchema, type SyllabusContent, type UpdateCourse } from '@ams/shared';
import { ConflictError, ForbiddenError, ValidationError, type Ctx } from '../ctx.js';
import { normalizeQuoteText } from '../framework/quote-match.js';
import { registerImportTarget, type ApplyItem, type ApplyOutcome, type ImportTarget, type OutlineEntry } from '../documents/targets.js';
import { createCourse, removeCourseProgram, setCourseProgram, updateCourse } from '../outcomes/courses.js';
import { unitPaths, type UnitRow } from '../org/programs-sheets.js';
import { createOrgUnit, updateOrgUnit } from '../org/units.js';
import { listOrgUnitTypes } from '../org/unit-types.js';
import { courseContentNow, discardDraft, saveSyllabusDraft } from './syllabus.js';

const opt = <T extends z.ZodType>(t: T) => t.nullish().default(null);
const fold = (s: string | null | undefined) => (s ? normalizeQuoteText(s) : '');
/** Course codes compare without spaces, dashes or dots: "ECE420", "ECE 420" and "ece-420" are one code. */
const codeKey = (s: string | null | undefined) => fold(s).replace(/[\s\-_.]/g, '');
const PATH = ' › ';
const pathText = (s: string) => s.replace(/\s*(?:›|»|>|\/)\s*/g, PATH).trim();
const num = (int: boolean) => z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : Number(v.replace(/[^\d.]/g, ''))) : v), (int ? z.number().int() : z.number()).min(0).nullish()).default(null);

export function normalizeBloom(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const k = v.trim().toLowerCase().replace(/^analy[sz]e$/, 'analyze').replace(/^(understanding|comprehension|comprehend)$/, 'understand').replace(/^(knowledge|recall)$/, 'remember').replace(/^(synthesis|design)$/, 'create').replace(/^application$/, 'apply').replace(/^analysis$/, 'analyze').replace(/^evaluation$/, 'evaluate');
  return (BLOOM_LEVELS as readonly string[]).includes(k) ? k : null;
}
const CloItem = z.object({ code: opt(z.string().trim()), text: z.string().trim().min(1), bloom: z.preprocess(normalizeBloom, z.enum(BLOOM_LEVELS).nullish()).default(null) });

/**
 * One course the documents describe: the course it is when the institution has it (`matchCourseId`, proposed by the AI and changed by
 * the person), what the documents state, the programs it serves (codes or names as written), and `keep`: the fields (and "clo:CODE")
 * a person chose to leave as they are.
 */
export const CourseImportItemSchema = z.object({
  matchCourseId: opt(z.uuid()),
  matchReason: opt(z.string().trim()),
  code: opt(z.string().trim()),
  titleEn: z.string().trim().min(1),
  externalId: opt(z.string().trim()),
  unitName: opt(z.string().trim()),
  level: z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : Number(v.replace(/[^\d]/g, ''))) : v), z.number().int().min(0).max(9).nullish()).default(null),
  credits: num(false),
  contactLecture: num(false),
  contactLab: num(false),
  description: opt(z.string().trim()),
  methodology: opt(z.string().trim()),
  programs: z.array(z.string().trim().min(1)).default([]),
  clos: z.array(CloItem).default([]),
  keep: z.array(z.string()).default([]),
});
export type CourseImportItem = z.infer<typeof CourseImportItemSchema>;
export const COURSES_TARGET_KIND = 'courses';

// ---- Step 1: facts; step 2: one item per course, matched -------------------------------------------------------------------------

export const COURSE_FACT_FIELDS = ['code', 'title', 'sis_code', 'unit', 'credits', 'lecture_hours', 'lab_hours', 'year', 'program', 'description', 'methodology', 'clo'] as const;
const FactSchema = z.object({ course: z.string().trim().min(1), field: z.enum(COURSE_FACT_FIELDS), value: z.string().trim().min(1), code: opt(z.string().trim()) });
type Fact = z.infer<typeof FactSchema>;
const numish = z.union([z.number(), z.string()]).nullish();
const AnswerItemSchema = z.object({
  match: z.string().nullish(), match_reason: z.string().nullish(),
  code: z.string().nullish(), title: z.string().nullish(), sis_code: z.string().nullish(), unit: z.string().nullish(),
  credits: numish, lecture_hours: numish, lab_hours: numish, year: numish, programs: z.array(z.string()).nullish(),
  description: z.string().nullish(), methodology: z.string().nullish(),
  clos: z.array(z.object({ code: z.string().nullish(), text: z.string(), bloom: z.string().nullish() })).default([]),
  from: z.array(z.number().int()).default([]), confidence: z.number().min(0).max(1).nullish(), flags: z.array(z.string()).default([]),
});
type AnswerItem = z.infer<typeof AnswerItemSchema>;
const AnswerSchema = z.object({ items: z.array(AnswerItemSchema) });

interface Known { ref: string; id: string; code: string; titleEn: string }
const MAX_KNOWN = 800;

async function knownCourses(ctx: Ctx): Promise<{ text: string; data: Known[] }> {
  const st = await loadState(ctx);
  const courses = st.courses.slice(0, MAX_KNOWN);
  const data = courses.map((c, i) => ({ ref: `C${i + 1}`, id: c.id, code: c.code, titleEn: c.titleEn }));
  const progCode = new Map(st.programs.map((p) => [p.id, p.code ?? p.nameEn]));
  const lines = courses.map((c, i) => {
    const progs = st.placements.filter((x) => x.courseId === c.id).map((x) => progCode.get(x.programId)).filter(Boolean).join(', ');
    const clos = st.clos.filter((o) => o.courseId === c.id).slice(0, 8).map((o) => `${o.code} ${o.textEn.slice(0, 70)}`).join(' | ');
    return `C${i + 1} · code ${c.code} · ${c.titleEn} · unit ${c.orgUnitId ? st.paths.get(c.orgUnitId) ?? '?' : '(none)'}${progs ? ` · programs ${progs}` : ''}${c.active ? '' : ' · inactive'}${clos ? `\n   CLOs: ${clos}` : ''}`;
  });
  const progLines = st.programs.filter((p) => p.active).map((p) => `${p.code ?? '(no code)'} · ${p.nameEn} (${p.degreeLevel})`);
  const chart = st.units.filter((u) => u.active).map((u) => st.paths.get(u.id) ?? u.nameEn).sort().slice(0, 300);
  return {
    text: [courses.length ? lines.join('\n') : 'The institution has no courses yet.', '', 'Its programs (code · name):', ...(progLines.length ? progLines : ['(none)']), '', 'The org chart (one unit per line):', ...(chart.length ? chart : ['(empty)'])].join('\n'),
    data,
  };
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.normalize('NFC').trim() : null);
const numText = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? v : null);

function buildItem(a: AnswerItem, sources: OutlineEntry<Fact>[], data: unknown): { item: CourseImportItem; confidence?: number | null; flags?: string[] } {
  const known = (Array.isArray(data) ? data : []) as Known[];
  const flags = [...a.flags];
  const titleEn = str(a.title) ?? sources.find((s) => s.item.field === 'title')?.item.value ?? sources[0]?.item.course ?? 'Untitled course';
  const base = {
    code: str(a.code), titleEn, externalId: str(a.sis_code), unitName: str(a.unit) ? pathText(str(a.unit)!) : null, level: numText(a.year), credits: numText(a.credits),
    contactLecture: numText(a.lecture_hours), contactLab: numText(a.lab_hours), description: str(a.description), methodology: str(a.methodology),
    programs: (a.programs ?? []).map(str).filter((x): x is string => !!x),
    clos: a.clos.filter((o) => str(o.text)).map((o) => ({ code: str(o.code), text: str(o.text)!, bloom: str(o.bloom) })),
  };
  let match = a.match ? known.find((k) => k.ref.toLowerCase() === a.match!.trim().toLowerCase()) : undefined;
  let reason = str(a.match_reason);
  if (a.match && !match) flags.push(`The AI named an existing course (${a.match}) that is not on the list; choose the course in the review.`);
  if (!match && base.code) {
    const same = known.find((k) => codeKey(k.code) === codeKey(base.code));
    if (same) { match = same; reason = `Same code as ${same.code}.`; flags.push('Matched by its code, not by the AI: check it.'); }
  }
  const all = { ...base, matchCourseId: match?.id ?? null, matchReason: reason };
  const parsed = CourseImportItemSchema.safeParse(all);
  if (parsed.success) return { item: parsed.data, confidence: a.confidence ?? null, flags };
  const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
  for (const k of bad) flags.push(`The document's ${k} did not fit and was left empty.`);
  return { item: CourseImportItemSchema.parse(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, bad.has(k) ? (Array.isArray(v) ? [] : null) : v]))), confidence: a.confidence ?? null, flags };
}

// ---- The state, the plan of one item -------------------------------------------------------------------------------------------------

async function loadState(ctx: Ctx) {
  const units = await ctx.tx.select({ id: orgUnit.id, parentId: orgUnit.parentId, nameEn: orgUnit.nameEn, nameAr: orgUnit.nameAr, code: orgUnit.code, active: orgUnit.active }).from(orgUnit);
  const paths = unitPaths(units as UnitRow[]);
  const courses = await ctx.tx.select().from(course);
  const programs = await ctx.tx.select({ id: program.id, code: program.code, nameEn: program.nameEn, nameAr: program.nameAr, degreeLevel: program.degreeLevel, active: program.active }).from(program);
  const placements = await ctx.tx.select({ courseId: courseProgram.courseId, programId: courseProgram.programId }).from(courseProgram);
  const clos = courses.length ? await ctx.tx.select({ courseId: learningOutcome.courseId, code: learningOutcome.code, textEn: learningOutcome.textEn }).from(learningOutcome).where(eq(learningOutcome.kind, 'clo')) : [];
  const unitOf = (text: string) => {
    const t = fold(pathText(text));
    const exact = units.filter((u) => u.active && ((u.code && fold(u.code) === t) || fold(paths.get(u.id) ?? '') === t));
    if (exact.length) return exact;
    return units.filter((u) => u.active && (fold(u.nameEn) === t || (u.nameAr && fold(u.nameAr) === t) || fold(u.nameEn) === fold(t.split(PATH).at(-1) ?? '')));
  };
  /** A program by its code or (English or Arabic) name, or "CODE · name". */
  const programOf = (text: string) => {
    const t = fold(text); const head = fold(text.split(/\s+[·\-–]\s+/)[0] ?? '');
    return programs.find((p) => (p.code && (fold(p.code) === t || fold(p.code) === head)) || fold(p.nameEn) === t || (p.nameAr && fold(p.nameAr) === t)) ?? null;
  };
  return { units, paths, courses, programs, placements, clos, unitOf, programOf };
}
type State = Awaited<ReturnType<typeof loadState>>;
type CourseRow = State['courses'][number];

export const COURSE_RECORD_FIELDS = ['code', 'externalId', 'unitName', 'level'] as const;
export const COURSE_CONTENT_FIELDS = ['titleEn', 'credits', 'contactLecture', 'contactLab', 'description', 'methodology'] as const;
const LABEL: Record<string, string> = {
  code: 'Course code', externalId: 'SIS code', unitName: 'Unit', level: 'Year of study', titleEn: 'Title', credits: 'Credit hours', contactLecture: 'Lecture hours',
  contactLab: 'Lab hours', description: 'Description', methodology: 'Teaching methodology',
};
const same = (a: unknown, b: unknown) => (typeof a === 'string' || typeof b === 'string' ? fold(String(a ?? '')) === fold(String(b ?? '')) : (a ?? null) === (b ?? null));
const contentValue = (c: SyllabusContent, f: (typeof COURSE_CONTENT_FIELDS)[number]): unknown => (
  f === 'titleEn' ? c.info.titleEn : f === 'credits' ? c.info.credits : f === 'contactLecture' ? c.info.contactLecture : f === 'contactLab' ? c.info.contactLab : f === 'description' ? c.description.en : c.methodology);

interface Plan {
  record: { field: (typeof COURSE_RECORD_FIELDS)[number]; now: unknown; next: unknown }[];
  content: { field: (typeof COURSE_CONTENT_FIELDS)[number]; now: unknown; next: unknown }[];
  clos: { code: string | null; now: { code: string; textEn: string } | null; text: string; bloom: string | null }[];
  programs: { text: string; programId: string | null; name: string | null }[];
}

function planOf(item: CourseImportItem, cur: CourseRow | null, st: State, content: SyllabusContent | null): Plan {
  const keep = new Set(item.keep);
  const record: Plan['record'] = [];
  for (const f of COURSE_RECORD_FIELDS) {
    const next = item[f];
    if (next === null || next === undefined || keep.has(f)) continue;
    const now = cur ? (f === 'unitName' ? (cur.orgUnitId ? st.paths.get(cur.orgUnitId) ?? null : null) : (cur as unknown as Record<string, unknown>)[f] ?? null) : null;
    if (cur && (f === 'code' ? codeKey(String(now)) === codeKey(String(next)) : same(now, f === 'unitName' ? pathText(String(next)) : next))) continue;
    record.push({ field: f, now, next });
  }
  const contentPlan: Plan['content'] = [];
  for (const f of COURSE_CONTENT_FIELDS) {
    const next = item[f];
    if (next === null || next === undefined || keep.has(f)) continue;
    const now = content ? contentValue(content, f) : null;
    if (content && same(now === '' ? null : now, next)) continue;
    contentPlan.push({ field: f, now, next });
  }
  const clos: Plan['clos'] = [];
  for (const o of item.clos) {
    if (keep.has(`clo:${o.code ?? o.text}`)) continue;
    const now = content?.clos.find((m) => (o.code ? codeKey(m.code) === codeKey(o.code) : fold(m.textEn) === fold(o.text))) ?? null;
    if (now && fold(now.textEn) === fold(o.text) && (!o.bloom || now.bloom === o.bloom)) continue;
    clos.push({ code: o.code, now: now ? { code: now.code, textEn: now.textEn } : null, text: o.text, bloom: o.bloom });
  }
  const programs: Plan['programs'] = [];
  for (const text of item.programs) {
    if (keep.has(`program:${text}`)) continue;
    const p = st.programOf(text);
    if (p && cur && st.placements.some((x) => x.courseId === cur.id && x.programId === p.id)) continue;
    if (p && programs.some((x) => x.programId === p.id)) continue;
    programs.push({ text, programId: p?.id ?? null, name: p ? (p.code ?? p.nameEn) : null });
  }
  return { record, content: contentPlan, clos, programs };
}

const describe_ = (plan: Plan) => {
  const draft = [...plan.content.map((c) => LABEL[c.field]!), ...(() => { const add = plan.clos.filter((c) => !c.now).length; const upd = plan.clos.length - add; return [...(add ? [`${add} new CLO${add === 1 ? '' : 's'}`] : []), ...(upd ? [`${upd} CLO text${upd === 1 ? '' : 's'}`] : [])]; })()];
  return {
    record: plan.record.map((r) => LABEL[r.field]!),
    draft,
    programs: plan.programs.filter((p) => p.programId).map((p) => p.name!),
    unknownPrograms: plan.programs.filter((p) => !p.programId).map((p) => p.text),
  };
};

/** The content with the item's changes: the stated fields, and CLOs updated by code (or text) or added; nothing removed. */
function mergeContent(base: SyllabusContent, plan: Plan): SyllabusContent {
  const c = SyllabusContentSchema.parse(JSON.parse(JSON.stringify(base)));
  for (const f of plan.content) {
    const v = f.next as never;
    if (f.field === 'titleEn') c.info.titleEn = v; else if (f.field === 'credits') c.info.credits = v; else if (f.field === 'contactLecture') c.info.contactLecture = v;
    else if (f.field === 'contactLab') c.info.contactLab = v; else if (f.field === 'description') c.description.en = v; else c.methodology = v;
  }
  for (const o of plan.clos) {
    const now = o.now ? c.clos.find((x) => x.code === o.now!.code) : undefined;
    if (now) { now.textEn = o.text; if (o.bloom) now.bloom = o.bloom; continue; }
    let code = o.code && !c.clos.some((x) => codeKey(x.code) === codeKey(o.code)) ? o.code : null;
    if (!code) { let n = 1; while (c.clos.some((x) => codeKey(x.code) === codeKey(`CLO${n}`))) n++; code = `CLO${n}`; }
    c.clos.push({ id: crypto.randomUUID(), code, textEn: o.text, textAr: '', bloom: o.bloom ?? '', plos: [] });
  }
  return c;
}
const canon = (c: SyllabusContent | null) => (c ? JSON.stringify(SyllabusContentSchema.parse(c)) : 'null');

// ---- Apply and reverse ------------------------------------------------------------------------------------------------------------

type Step =
  | { kind: 'course'; id: string; label: string; before: Record<string, unknown>; after: Record<string, unknown> }
  | { kind: 'unit'; id: string; label: string; before: { active: boolean }; after: { active: boolean } }
  | { kind: 'placement'; courseId: string; programId: string; label: string }
  | { kind: 'draft'; courseId: string; label: string; before: SyllabusContent | null; after: SyllabusContent };
interface Inverse { v: 1; steps: Step[]; state: 'applied' | 'undone' }
const normVal = (v: unknown) => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v ?? null);

async function openDraftContent(ctx: Ctx, courseId: string): Promise<SyllabusContent | null> {
  const [open] = await ctx.tx.select().from(syllabusVersion).where(and(eq(syllabusVersion.courseId, courseId), inArray(syllabusVersion.status, ['draft', 'in_review', 'endorsed'])));
  return open ? SyllabusContentSchema.parse(open.content) : null;
}

async function runStep(ctx: Ctx, s: Step, to: 'before' | 'after') {
  const verb = to === 'before' ? 'undo' : 'redo';
  if (s.kind === 'course' || s.kind === 'unit') {
    const from = to === 'before' ? s.after : s.before;
    const values = to === 'before' ? s.before : s.after;
    const [row] = s.kind === 'course' ? await ctx.tx.select().from(course).where(eq(course.id, s.id)) : await ctx.tx.select().from(orgUnit).where(eq(orgUnit.id, s.id));
    if (!row) throw new ConflictError(`Cannot ${verb}: ${s.label} is not there any more.`);
    for (const [k, v] of Object.entries(from)) if (normVal((row as Record<string, unknown>)[k]) !== normVal(v)) throw new ConflictError(`Cannot ${verb}: ${s.label} was changed since.`);
    if (s.kind === 'course') await updateCourse(ctx, s.id, values as UpdateCourse); else await updateOrgUnit(ctx, s.id, values);
  } else if (s.kind === 'placement') {
    const [row] = await ctx.tx.select().from(courseProgram).where(and(eq(courseProgram.courseId, s.courseId), eq(courseProgram.programId, s.programId)));
    if (to === 'before') { if (row) await removeCourseProgram(ctx, s.courseId, s.programId); } else if (!row) await setCourseProgram(ctx, s.courseId, s.programId, { role: 'core', year: null, term: null });
  } else {
    const now = await openDraftContent(ctx, s.courseId);
    const expect = to === 'before' ? s.after : s.before;
    if (canon(now) !== canon(expect)) throw new ConflictError(`Cannot ${verb}: the draft of ${s.label} was changed since.`);
    const target = to === 'before' ? s.before : s.after;
    if (target) await saveSyllabusDraft(ctx, s.courseId, { content: target, source: 'document import' }); else await discardDraft(ctx, s.courseId);
  }
}

async function applyItems(ctx: Ctx, items: ApplyItem<CourseImportItem>[]) {
  const st = await loadState(ctx);
  const unitTypes = new Set((await listOrgUnitTypes(ctx)).map((t) => t.key));
  const outcomes: ApplyOutcome[] = [];
  const steps: Step[] = [];
  const skip = (proposalId: string, reason: string) => outcomes.push({ proposalId, status: 'skipped', reason });
  const touched = new Set<string>();
  for (const it of items) {
    const p = it.item;
    const cur = p.matchCourseId ? st.courses.find((c) => c.id === p.matchCourseId) ?? null : null;
    if (p.matchCourseId && !cur) { skip(it.proposalId, 'the course it was matched to is not there any more; choose it again or make it new'); continue; }
    if (cur && touched.has(cur.id)) { skip(it.proposalId, `another accepted item already updates ${cur.code} in this apply; merge them or match this one elsewhere`); continue; }
    if (!cur && !p.code) { skip(it.proposalId, 'a new course needs its code; type it in the review and apply again'); continue; }
    if (!cur && st.courses.some((c) => codeKey(c.code) === codeKey(p.code))) { skip(it.proposalId, `a course with the code ${p.code} exists: match this one to it`); continue; }
    const notes: string[] = [];
    try {
      // The unit: an existing one, or a new unit under the path's known part.
      let unitId: string | null = null;
      if (p.unitName && !p.keep.includes('unitName')) {
        const found = st.unitOf(p.unitName);
        if (found.length > 1 && cur?.orgUnitId && found.some((u) => u.id === cur.orgUnitId)) unitId = cur.orgUnitId;
        else if (found.length === 1) unitId = found[0]!.id;
        else if (found.length > 1) notes.push(`The unit "${p.unitName}" matches several units and was left as it is.`);
        else {
          const parts = pathText(p.unitName).split(PATH);
          const parent = parts.length > 1 ? st.unitOf(parts.slice(0, -1).join(PATH)) : [];
          try {
            const made = await createOrgUnit(ctx, { parentId: parent.length === 1 ? parent[0]!.id : null, type: unitTypes.has('department') ? 'department' : 'other', nameEn: parts.at(-1)!.normalize('NFC') } as never);
            unitId = made.id;
            st.units.push({ id: made.id, parentId: made.parentId, nameEn: made.nameEn, nameAr: made.nameAr, code: made.code, active: true });
            st.paths.set(made.id, pathText(p.unitName));
            steps.push({ kind: 'unit', id: made.id, label: `the unit "${made.nameEn}"`, before: { active: false }, after: { active: true } });
          } catch (e) {
            if (!(e instanceof ForbiddenError || e instanceof ValidationError)) throw e;
            notes.push(`The unit "${p.unitName}" is not in the org chart and was not added (${e.message}).`);
          }
        }
      }
      const holder = p.code && cur && !p.keep.includes('code') ? st.courses.find((c) => codeKey(c.code) === codeKey(p.code) && c.id !== cur.id) : undefined;
      const now = cur ? await courseContentNow(ctx, cur.id) : null;
      const plan = planOf({ ...p, keep: [...p.keep, ...(holder ? ['code'] : [])] }, cur, st, now ? now.content : null);
      if (holder) notes.push(`The code ${p.code} belongs to ${holder.titleEn} and was not used.`);
      // The record, at once.
      let courseId: string;
      if (cur) {
        const patch: UpdateCourse = {};
        for (const r of plan.record) { if (r.field === 'unitName') { if (unitId && unitId !== cur.orgUnitId) patch.orgUnitId = unitId; } else (patch as Record<string, unknown>)[r.field] = r.next; }
        if (Object.keys(patch).length) {
          const before = Object.fromEntries(Object.keys(patch).map((k) => [k, (cur as unknown as Record<string, unknown>)[k] ?? null]));
          await updateCourse(ctx, cur.id, patch);
          steps.push({ kind: 'course', id: cur.id, label: `the course ${cur.code}`, before, after: patch as Record<string, unknown> });
        }
        courseId = cur.id;
      } else {
        const made = await createCourse(ctx, { code: p.code!, titleEn: p.titleEn, orgUnitId: unitId, externalId: p.externalId, credits: p.credits, level: p.level } as never);
        st.courses.push((await ctx.tx.select().from(course).where(eq(course.id, made.id)))[0]!);
        steps.push({ kind: 'course', id: made.id, label: `the course ${made.code}`, before: { active: false }, after: { active: true } });
        courseId = made.id;
      }
      touched.add(courseId);
      // The programs it serves, at once (added, never removed).
      for (const pr of plan.programs) {
        if (!pr.programId) { notes.push(`No program "${pr.text}": add the course to it on the course page.`); continue; }
        await setCourseProgram(ctx, courseId, pr.programId, { role: 'core', year: null, term: null });
        st.placements.push({ courseId, programId: pr.programId });
        steps.push({ kind: 'placement', courseId, programId: pr.programId, label: `${pr.name}` });
      }
      // The content, into the draft (a new course's title and credits are already its record; the rest is content).
      const contentNow = cur ? now! : await courseContentNow(ctx, courseId);
      const contentPlan = cur ? plan : planOf({ ...p, keep: [...p.keep, 'titleEn', 'credits'] }, null, st, contentNow.content);
      const changes = contentPlan.content.length + contentPlan.clos.length;
      if (changes) {
        if (contentNow.locked) notes.push(`The content is ${contentNow.locked === 'in_review' ? 'in review' : 'endorsed'}: return it to the coordinator, then import again for the content.`);
        else {
          const before = contentNow.hasDraft ? contentNow.content : null;
          const next = mergeContent(contentNow.content, contentPlan);
          if (canon(next) !== canon(contentNow.content)) {
            await saveSyllabusDraft(ctx, courseId, { content: next, source: 'document import' });
            steps.push({ kind: 'draft', courseId, label: p.code ?? cur?.code ?? p.titleEn, before, after: SyllabusContentSchema.parse(next) });
          }
        }
      }
      const d = describe_(plan);
      outcomes.push({ proposalId: it.proposalId, status: 'applied', ref: { courseId, updated: !!cur, record: d.record, draft: contentNow.locked ? [] : describe_(contentPlan).draft, programs: d.programs, note: notes.join(' ') || null } });
    } catch (e) {
      if (e instanceof ValidationError || e instanceof ConflictError || e instanceof ForbiddenError) { skip(it.proposalId, e.message); continue; }
      throw e;
    }
  }
  return { outcomes, inverse: { v: 1, steps, state: 'applied' } satisfies Inverse };
}

export const coursesTarget: ImportTarget<CourseImportItem> = {
  kind: COURSES_TARGET_KIND, label: 'Courses', itemsLabel: 'courses', scopeKinds: ['courses'],
  description: 'Reads every document together: the courses they describe, matched to the courses you have (by code and meaning), with their record, the programs they serve and their content and CLOs. You confirm each match and each change; content goes into each course\'s draft for approval.',
  schema: CourseImportItemSchema,
  promptTask: 'import_courses_organise', promptVersion: 'v1',
  buildPrompt: () => '',
  organise: {
    outline: {
      schema: FactSchema, promptTask: 'import_courses_facts', promptVersion: 'v1',
      buildPrompt: (w) => [
        'Find every fact about a course in these pages.',
        `Document: ${w.documentName}. Language: ${w.language}. This window: pages ${w.firstPage} to ${w.lastPage}.`,
        '', w.pages,
      ].join('\n'),
    },
    promptTask: 'import_courses_organise', promptVersion: 'v1',
    context: (ctx) => knownCourses(ctx),
    buildPrompt: ({ documents, entries, context }) => [
      'Documents:', ...documents.map((d) => `- ${d.name} (language: ${d.language})`),
      '', 'Facts found in them:',
      ...(entries as OutlineEntry<Fact>[]).map((e) => `[${e.n}] ${e.item.course} · ${e.item.field}${e.item.code ? ` ${e.item.code}` : ''}: ${e.item.value}`),
      '', 'The institution\'s courses as they are now:', context,
    ].join('\n'),
    answer: AnswerSchema,
    from: (a: AnswerItem) => a.from,
    build: (a: AnswerItem, sources: OutlineEntry<Fact>[], data?: unknown) => buildItem(a, sources, data),
  },
  async validate(item, _scope, ctx) {
    const why: string[] = [];
    const st = await loadState(ctx);
    const cur = item.matchCourseId ? st.courses.find((c) => c.id === item.matchCourseId) ?? null : null;
    if (item.matchCourseId && !cur) why.push('The course it was matched to is not there any more.');
    const now = cur ? await courseContentNow(ctx, cur.id) : null;
    const plan = planOf(item, cur, st, now?.content ?? null);
    const d = describe_(plan);
    if (!cur) {
      if (!item.code) why.push('No course code was found (a new course needs one).');
      else if (st.courses.some((c) => codeKey(c.code) === codeKey(item.code))) why.push(`A course with the code ${item.code} exists: choose it as the course this is.`);
      if (!item.unitName) why.push('No owning unit was found.');
      else if (!st.unitOf(item.unitName).length) why.push(`The unit "${item.unitName}" is not in the org chart: it would be added.`);
      if (item.credits === null) why.push('No credit hours were found.');
      if (!item.programs.length) why.push('No program it serves was found.');
    } else {
      const parts = [...(d.record.length ? [`now: ${d.record.join(', ')}`] : []), ...(d.programs.length ? [`adds to ${d.programs.join(', ')}`] : []), ...(d.draft.length ? [`into the draft: ${d.draft.join(', ')}`] : [])];
      why.push(parts.length ? `Updates ${cur.code}: ${parts.join('; ')}.` : `Matches ${cur.code}; nothing would change.`);
      if (now?.locked && d.draft.length) why.push(`Its content is ${now.locked === 'in_review' ? 'in review' : 'endorsed'}: only the record would change.`);
    }
    if (d.unknownPrograms.length) why.push(`No program ${d.unknownPrograms.map((x) => `"${x}"`).join(', ')}: write its code.`);
    return why;
  },
  async fieldChoices(ctx) {
    const st = await loadState(ctx);
    return { suggestions: { unitName: st.units.filter((u) => u.active).map((u) => st.paths.get(u.id) ?? u.nameEn).sort((a, b) => a.localeCompare(b)) } };
  },
  proposalLabel: (item) => (item.code ? `${item.code} ${item.titleEn}` : item.titleEn),
  dedupeKey: (item) => (item.matchCourseId ? `m|${item.matchCourseId}` : `n|${codeKey(item.code) || fold(item.titleEn)}`),
  async apply(ctx, items) { return applyItems(ctx, items); },
  /** Undo sets back what the apply set (the record, the draft as it was, placements and new courses and units off); Redo sets it again. */
  async reverse(ctx, raw) {
    const inv = raw as Inverse;
    const to = inv.state === 'applied' ? 'before' : 'after';
    // Drafts first on undo (a new course's draft goes before the course is switched off), last on redo.
    for (const s of to === 'before' ? [...inv.steps].reverse() : inv.steps) await runStep(ctx, s, to);
    return { ...inv, state: inv.state === 'applied' ? 'undone' : 'applied' } satisfies Inverse;
  },
};

registerImportTarget(coursesTarget);
