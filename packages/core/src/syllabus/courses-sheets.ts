// Courses from the courses workbook or the API's bulk upsert, and the workbook from the courses (DEC-042: the course is the master record).
// A course's record (code, unit, year of study, SIS code, coordinator, active) and the programs it serves change at once; its content
// (titles, credit hours, contact hours, description, CLOs with their PLOs, outline, materials, assessments, rubrics) goes into its draft,
// approved as on the course page. A part of the content is replaced only when the file has rows for that course; an empty cell leaves a
// field as it is; content that comes out the same makes no draft. Nothing absent is removed. With `apply` false nothing is written.
import { and, eq, inArray } from 'drizzle-orm';
import { appUser, concentration, course, courseInstructor, courseProgram, learningOutcome, orgUnit, program } from '@ams/db';
import {
  ASSESSMENT_CATEGORIES, BLOCK_LABEL, BLOOM_LEVELS, REQUIREMENT_BLOCKS, COURSE_CATEGORIES, COURSE_LEVELS, COURSE_ROLES, COURSE_SHEETS, COURSE_TYPES, CONTENT_SHEETS, LABEL,
  LANGUAGES_OF_DELIVERY, MATERIAL_KINDS, SUSTAINABILITY, SYLLABUS_SHEETS, UpsertCoursesSchema, emptySyllabus, sheetCell, syllabusToWorkbook, workbookToSyllabi,
  type CourseSheetRow, type CoursesExport, type SyllabusContent, type SyllabusWorkbook, type UpdateCourse, type UpsertCourses, type UpsertCoursesResult, type UpsertCoursesRow,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, ForbiddenError } from '../ctx.js';
import { assertPermitted } from '../permissions.js';
import { createCourse, setCourseProgram, updateCourse } from '../outcomes/courses.js';
import { unitPaths, type UnitRow } from '../org/programs-sheets.js';
import { sheetResolver } from './import.js';
import { courseContentNow, getLevels, getSyllabusTemplate, saveSyllabusDraft, setCourseStaff } from './syllabus.js';

const key = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, '');
const codeKey = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toUpperCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numOf = (s: string) => (s === '' ? undefined : Number.isFinite(Number(s)) ? Number(s) : NaN);
/** The content columns of the Courses sheet and the part of the content each fills. */
const CONTENT_COLUMNS: [string, (d: SyllabusContent, from: SyllabusContent) => void][] = [
  ['Title (English)', (d, f) => { d.info.titleEn = f.info.titleEn; }],
  ['Credit hours', (d, f) => { d.info.credits = f.info.credits; }],
  ['Lecture hours', (d, f) => { d.info.contactLecture = f.info.contactLecture; }],
  ['Lab hours', (d, f) => { d.info.contactLab = f.info.contactLab; }],
  ['Other hours', (d, f) => { d.info.contactOther = f.info.contactOther; }],
  ['Language of delivery', (d, f) => { d.info.languageOfDelivery = f.info.languageOfDelivery; }],
  ['Course type', (d, f) => { d.info.courseType = f.info.courseType; }],
  ['Course level', (d, f) => { d.info.courseLevel = f.info.courseLevel; }],
  ['Course category', (d, f) => { d.info.category = f.info.category; }],
  ['Sustainability indicator', (d, f) => { d.info.sustainability = f.info.sustainability; }],
  ['Prerequisites', (d, f) => { d.info.prerequisites = f.info.prerequisites; }],
  ['Co-requisites', (d, f) => { d.info.corequisites = f.info.corequisites; }],
  ['Other requirements', (d, f) => { d.info.otherRequirements = f.info.otherRequirements; }],
  ['Description (English)', (d, f) => { d.description.en = f.description.en; }],
  ['Teaching methodology', (d, f) => { d.methodology = f.methodology; }],
  ['Pass percentage and submission details', (d, f) => { d.assessmentNotes.passPercentage = f.assessmentNotes.passPercentage; }],
  ['How assessments work', (d, f) => { d.assessmentNotes.howItWorks = f.assessmentNotes.howItWorks; }],
];

export async function upsertCourses(ctx: Ctx, input: UpsertCourses): Promise<UpsertCoursesResult> {
  await assertPermitted(ctx, 'program:write', { type: 'any' });
  const { workbook, apply } = UpsertCoursesSchema.parse(input);
  const units: UnitRow[] = await ctx.tx.select({ id: orgUnit.id, parentId: orgUnit.parentId, nameEn: orgUnit.nameEn, code: orgUnit.code, active: orgUnit.active }).from(orgUnit);
  const paths = unitPaths(units);
  const unitOf = (text: string) => {
    const t = key(text);
    const exact = units.filter((u) => (u.code && key(u.code) === t) || key(paths.get(u.id) ?? '') === t);
    return exact.length ? exact : units.filter((u) => key(u.nameEn) === t);
  };
  const programs = await ctx.tx.select({ id: program.id, code: program.code, nameEn: program.nameEn }).from(program);
  const people = await ctx.tx.select({ id: appUser.id, email: appUser.email }).from(appUser).where(eq(appUser.active, true));
  const existing = await ctx.tx.select().from(course);
  const byId = new Map(existing.map((c) => [c.id, c]));
  const byCode = new Map(existing.map((c) => [codeKey(c.code), c]));
  const out: UpsertCoursesRow[] = [];
  const res = { added: 0, updated: 0, drafted: 0, unchanged: 0, skipped: 0 };
  const note = (r: UpsertCoursesRow) => { out.push(r); res[r.action === 'add' ? 'added' : r.action === 'update' ? 'updated' : r.action === 'draft' ? 'drafted' : r.action === 'unchanged' ? 'unchanged' : 'skipped'] += 1; };
  /** Course code (as the file gives it) -> its id (null while it is only to be added). */
  const placed = new Map<string, string | null>();
  /** Courses whose row was skipped: their content is not reported again. */
  const skippedCourses = new Set<string>();

  // ---- The course records
  const courseRows = workbook.courses;
  for (const [i, r] of courseRows.entries()) {
    const c = (h: string) => sheetCell(r, h);
    const code = c('Course code'); const idText = c('ID'); const row = i + 2;
    const skip = (message: string) => { skippedCourses.add(codeKey(code || idText)); note({ sheet: 'Courses', row, code: code || idText, action: 'skip', message }); };
    if (!code && !idText) { skip('no Course code'); continue; }
    const cur = idText ? (UUID.test(idText) ? byId.get(idText) : undefined) : byCode.get(codeKey(code));
    if (idText && !cur) { skip(`no course with the ID ${idText} (leave the ID empty to add a course)`); continue; }
    const holder = code ? byCode.get(codeKey(code)) : undefined;
    if (cur && holder && holder.id !== cur.id) { skip(`the Course code ${code} belongs to another course (${holder.titleEn})`); continue; }
    const unitText = c('Unit');
    let unitMatches = unitText ? unitOf(unitText) : [];
    if (unitMatches.length > 1 && cur && unitMatches.some((u) => u.id === cur!.orgUnitId)) unitMatches = unitMatches.filter((u) => u.id === cur!.orgUnitId);
    if (unitText && unitMatches.length !== 1) { skip(unitMatches.length ? `the unit "${unitText}" matches ${unitMatches.length} units: pick it from the list (its path)` : `no unit "${unitText}" in the org chart`); continue; }
    const coordText = c('Coordinator');
    const coordinator = coordText ? people.find((p) => p.email.toLowerCase() === coordText.toLowerCase()) : undefined;
    if (coordText && !coordinator) { skip(`no person with the email ${coordText} (the coordinator)`); continue; }
    const year = numOf(c('Year of study'));
    if (year !== undefined && (Number.isNaN(year) || !Number.isInteger(year))) { skip('Year of study is not a whole number'); continue; }
    const activeText = key(c('Active'));
    const label = code || cur?.code || idText;
    if (!cur) {
      const title = c('Title (English)'); const credits = numOf(c('Credit hours'));
      const lacking = [!code && 'Course code', !title && 'Title (English)', !unitMatches.length && 'Unit', (credits === undefined || Number.isNaN(credits)) && 'Credit hours'].filter(Boolean);
      if (lacking.length) { skip(`a new course needs ${lacking.join(', ')}`); continue; }
      let id: string | null = null;
      if (apply) {
        id = (await createCourse(ctx, { code, titleEn: title, orgUnitId: unitMatches[0]!.id, credits: credits!, level: year ?? null, externalId: c('SIS code') || null })).id;
        if (coordinator) await setCourseStaff(ctx, id, { coordinatorUserId: coordinator.id, instructorIds: [] });
      }
      placed.set(codeKey(code), id);
      byCode.set(codeKey(code), { id: id ?? '', code, titleEn: title } as (typeof existing)[number]);
      note({ sheet: 'Courses', row, code, action: 'add', message: '' });
      continue;
    }
    placed.set(codeKey(label), cur.id); if (codeKey(cur.code) !== codeKey(label)) placed.set(codeKey(cur.code), cur.id);
    const patch: UpdateCourse = {};
    if (code && idText && code !== cur.code) patch.code = code;
    if (unitMatches[0] && unitMatches[0].id !== cur.orgUnitId) patch.orgUnitId = unitMatches[0].id;
    if (year !== undefined && year !== cur.level) patch.level = year;
    if (c('SIS code') && c('SIS code') !== cur.externalId) patch.externalId = c('SIS code');
    if (['yes', 'true', '1', 'active'].includes(activeText) && !cur.active) patch.active = true;
    if (['no', 'false', '0', 'inactive'].includes(activeText) && cur.active) patch.active = false;
    const coordChange = !!coordinator && coordinator.id !== cur.coordinatorUserId;
    const changes = [...Object.keys(patch), ...(coordChange ? ['coordinator'] : [])];
    if (!changes.length) { note({ sheet: 'Courses', row, code: label, action: 'unchanged', message: '' }); continue; }
    if (apply) {
      if (Object.keys(patch).length) await updateCourse(ctx, cur.id, patch);
      if (coordChange) {
        const instructors = (await ctx.tx.select({ userId: courseInstructor.userId }).from(courseInstructor).where(eq(courseInstructor.courseId, cur.id))).map((x) => x.userId);
        await setCourseStaff(ctx, cur.id, { coordinatorUserId: coordinator!.id, instructorIds: instructors });
      }
    }
    note({ sheet: 'Courses', row, code: label, action: 'update', message: `Changes: ${changes.join(', ')}${patch.code ? ` (code was ${cur.code})` : ''}.` });
  }
  const courseIdOf = (text: string) => { const k = codeKey(text); return placed.has(k) ? placed.get(k)! : byCode.get(k)?.id ?? undefined; };

  // ---- The programs each course serves (applied at once)
  const links = await ctx.tx.select().from(courseProgram);
  const concentrations = await ctx.tx.select().from(concentration);
  for (const [i, r] of workbook.studyPlan.entries()) {
    const c = (h: string) => sheetCell(r, h);
    const cc = c('Course code'); const pc = c('Program code'); const row = i + 2; const label = `${cc} ${pc}`.trim();
    const skip = (message: string) => note({ sheet: 'Study plan', row, code: label, action: 'skip', message });
    const courseId = cc ? courseIdOf(cc) : undefined;
    if (courseId === undefined) { skip(cc ? `no course with the code ${cc}` : 'no Course code'); continue; }
    const prog = programs.find((p) => p.code && key(p.code) === key(pc));
    if (!prog) { skip(pc ? `no program with the code ${pc}` : 'no Program code'); continue; }
    const roleText = c('Role'); const role = roleText ? COURSE_ROLES.find((x) => key(x) === key(roleText)) : 'core';
    if (!role) { skip(`unknown role "${roleText}" (Core, Elective or Service)`); continue; }
    const y = numOf(c('Year')); const t = numOf(c('Term'));
    if ([y, t].some((n) => n !== undefined && (Number.isNaN(n) || !Number.isInteger(n)))) { skip('Year and Term are whole numbers'); continue; }
    // The block of the program's requirements the course sits in, and the concentration it is for (empty: all). Left as they are when empty.
    const blockText = c('Block'); const block = blockText ? REQUIREMENT_BLOCKS.find((b) => key(b) === key(blockText) || key(BLOCK_LABEL[b]) === key(blockText)) : undefined;
    if (blockText && !block) { skip(`unknown block "${blockText}" (${REQUIREMENT_BLOCKS.map((b) => BLOCK_LABEL[b]).join(', ')})`); continue; }
    const concText = c('Concentration');
    const conc = concText ? concentrations.find((k) => k.programId === prog.id && (key(k.code) === key(concText) || key(k.nameEn) === key(concText))) : undefined;
    if (concText && !conc) { skip(`no concentration "${concText}" in ${prog.code}`); continue; }
    const now = courseId ? links.find((l) => l.courseId === courseId && l.programId === prog.id) : undefined;
    const next = { role, year: y ?? now?.year ?? null, term: t ?? now?.term ?? null, block: block ?? now?.block ?? null, concentrationId: conc?.id ?? now?.concentrationId ?? null };
    if (now && now.role === next.role && now.year === next.year && now.term === next.term && now.block === next.block && now.concentrationId === next.concentrationId) { note({ sheet: 'Study plan', row, code: label, action: 'unchanged', message: '' }); continue; }
    if (apply && courseId) await setCourseProgram(ctx, courseId, prog.id, next);
    note({ sheet: 'Study plan', row, code: label, action: now ? 'update' : 'add', message: '' });
  }

  // ---- The content: into each course's draft
  const { resolver } = await sheetResolver(ctx);
  const syllabusWb: SyllabusWorkbook = { courses: courseRows.map((r) => ({ ...r, 'Course code': sheetCell(r, 'Course code') || (byId.get(sheetCell(r, 'ID'))?.code ?? '') })), clos: workbook.clos, outline: workbook.outline, materials: workbook.materials, assessments: workbook.assessments, rubrics: workbook.rubrics, sections: workbook.sections };
  const parsed = workbookToSyllabi(syllabusWb, resolver);
  const levels = await getLevels(ctx);
  const template = await getSyllabusTemplate(ctx);
  const allPlos = await ctx.tx.select({ id: learningOutcome.id, code: learningOutcome.code, programId: learningOutcome.programId }).from(learningOutcome).where(eq(learningOutcome.kind, 'plo'));
  const progName = new Map(programs.map((p) => [p.id, p.nameEn]));
  const canonical = (content: SyllabusContent, code: string) => JSON.stringify(syllabusToWorkbook(content, {
    code, levels, plos: allPlos.map((p) => ({ id: p.id, code: p.code, programName: progName.get(p.programId ?? '') ?? '' })), courses: existing.map((x) => ({ id: x.id, code: x.code })),
    customSections: template.sections.filter((x) => x.key.startsWith('custom:')).map((x) => ({ key: x.key, title: x.title })),
  }));
  const rowsFor = (sheet: (typeof CONTENT_SHEETS)[number], cc: string) => workbook[sheet].some((r) => codeKey(sheetCell(r, 'Course code')) === cc);
  for (const [cc, from] of parsed) {
    const courseRow = courseRows.find((r) => codeKey(sheetCell(r, 'Course code') || (byId.get(sheetCell(r, 'ID'))?.code ?? '')) === cc);
    const columns = courseRow ? CONTENT_COLUMNS.filter(([h]) => sheetCell(courseRow, h) !== '') : [];
    const sheets = CONTENT_SHEETS.filter((s) => rowsFor(s, cc));
    if ((!columns.length && !sheets.length) || skippedCourses.has(cc)) continue;
    const courseId = courseIdOf(cc);
    const label = byCode.get(cc)?.code ?? cc;
    if (courseId === undefined) { note({ sheet: 'Content', row: 0, code: label, action: 'skip', message: `no course with the code ${label}: add it on the Courses sheet` }); continue; }
    const now = courseId ? await courseContentNow(ctx, courseId) : { content: emptySyllabus(), locked: null, hasDraft: false };
    const merged: SyllabusContent = JSON.parse(JSON.stringify(now.content));
    for (const [, put] of columns) put(merged, from);
    for (const s of sheets) {
      if (s === 'clos') {
        // A CLO keeps the id it has in the content (so its outline and assessments still point at it).
        merged.clos = from.clos.map((x) => ({ ...x, id: now.content.clos.find((o) => o.id === x.id || o.code.toUpperCase() === x.code.toUpperCase())?.id ?? x.id }));
      } else if (s === 'sections') merged.custom = from.custom;
      else (merged as unknown as Record<string, unknown>)[s] = (from as unknown as Record<string, unknown>)[s];
    }
    const parts = [...columns.map(([h]) => h), ...sheets.map((s) => COURSE_SHEETS[s].name)];
    if (courseId && canonical(merged, label) === canonical(now.content, label)) { note({ sheet: 'Content', row: 0, code: label, action: 'unchanged', message: '' }); continue; }
    if (now.locked) { note({ sheet: 'Content', row: 0, code: label, action: 'skip', message: `its draft is ${now.locked === 'in_review' ? 'in review' : 'endorsed'}: return it to the coordinator first` }); continue; }
    if (apply && courseId) {
      try {
        const v = await saveSyllabusDraft(ctx, courseId, { content: merged, source: 'courses workbook' });
        note({ sheet: 'Content', row: 0, code: label, action: 'draft', message: `Draft v${v.versionNo}: ${parts.join(', ')}.${v.errorCount ? ` ${v.errorCount} error${v.errorCount === 1 ? '' : 's'} to fix before it is submitted.` : ''}` });
      } catch (e) {
        if (e instanceof ForbiddenError || e instanceof ConflictError) note({ sheet: 'Content', row: 0, code: label, action: 'skip', message: e.message });
        else throw e;
      }
    } else note({ sheet: 'Content', row: 0, code: label, action: 'draft', message: `Into the draft: ${parts.join(', ')}.` });
  }
  return { applied: apply, ...res, rows: out };
}

const lbl = (v: string) => LABEL[v] ?? v;

/**
 * Every course with its record, the programs it serves and its content (the draft in progress, else the approved content) as the workbook's
 * rows, each with its ID, and the choices for the dropdowns.
 */
export async function exportCourses(ctx: Ctx): Promise<CoursesExport> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const units: UnitRow[] = await ctx.tx.select({ id: orgUnit.id, parentId: orgUnit.parentId, nameEn: orgUnit.nameEn, code: orgUnit.code, active: orgUnit.active }).from(orgUnit);
  const paths = unitPaths(units);
  const programs = await ctx.tx.select({ id: program.id, code: program.code, nameEn: program.nameEn, active: program.active }).from(program);
  const people = await ctx.tx.select({ id: appUser.id, email: appUser.email, active: appUser.active }).from(appUser);
  const all = (await ctx.tx.select().from(course)).sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  const links = await ctx.tx.select().from(courseProgram);
  const concs = await ctx.tx.select().from(concentration);
  const levels = await getLevels(ctx);
  const template = await getSyllabusTemplate(ctx);
  const allPlos = all.length ? await ctx.tx.select({ id: learningOutcome.id, code: learningOutcome.code, programId: learningOutcome.programId }).from(learningOutcome).where(and(eq(learningOutcome.kind, 'plo'), inArray(learningOutcome.programId, programs.map((p) => p.id).concat('00000000-0000-0000-0000-000000000000')))) : [];
  const progName = new Map(programs.map((p) => [p.id, p.nameEn]));
  const wb: CoursesExport = {
    courses: [], studyPlan: [], clos: [], outline: [], materials: [], assessments: [], rubrics: [], sections: [],
    lists: {
      units: units.filter((u) => u.active).map((u) => paths.get(u.id)!).sort((a, b) => a.localeCompare(b)),
      programs: programs.filter((p) => p.active && p.code).map((p) => p.code!).sort(),
      coordinators: people.filter((p) => p.active && !p.email.endsWith('.invalid')).map((p) => p.email).sort(),
      languages: LANGUAGES_OF_DELIVERY.map(lbl), types: COURSE_TYPES.map(lbl), levels: [...COURSE_LEVELS], categories: COURSE_CATEGORIES.map(lbl), sustainability: SUSTAINABILITY.map(lbl),
      roles: COURSE_ROLES.map((r) => r[0]!.toUpperCase() + r.slice(1)), blocks: REQUIREMENT_BLOCKS.map((b) => BLOCK_LABEL[b]), bloom: BLOOM_LEVELS.map(lbl), coverage: levels.map((l) => l.name), kinds: MATERIAL_KINDS.map(lbl), assessmentCategories: ASSESSMENT_CATEGORIES.map(lbl),
    },
  };
  const email = new Map(people.map((p) => [p.id, p.email]));
  for (const c of all) {
    const { content } = await courseContentNow(ctx, c.id);
    const rows = syllabusToWorkbook(content, {
      code: c.code, levels, plos: allPlos.map((p) => ({ id: p.id, code: p.code, programName: progName.get(p.programId ?? '') ?? '' })), courses: all.map((x) => ({ id: x.id, code: x.code })),
      customSections: template.sections.filter((x) => x.key.startsWith('custom:')).map((x) => ({ key: x.key, title: x.title })),
    });
    const info = (rows.courses[0] ?? {}) as CourseSheetRow;
    const pick = (h: string) => info[h] ?? null;
    wb.courses.push({
      ID: c.id, 'Course code': c.code, Unit: c.orgUnitId ? paths.get(c.orgUnitId) ?? '' : '', 'Year of study': c.level, 'SIS code': c.externalId ?? '',
      ...Object.fromEntries(SYLLABUS_SHEETS.courses.headers.filter((h) => h !== 'Course code' && h !== 'Title (Arabic)' && h !== 'Description (Arabic)').map((h) => [h, pick(h)])),
      Coordinator: c.coordinatorUserId ? email.get(c.coordinatorUserId) ?? '' : '', Active: c.active ? 'Yes' : 'No',
    });
    for (const l of links.filter((x) => x.courseId === c.id)) {
      const p = programs.find((x) => x.id === l.programId);
      wb.studyPlan.push({ 'Course code': c.code, 'Course title': c.titleEn, 'Program code': p?.code ?? '', Role: l.role[0]!.toUpperCase() + l.role.slice(1), Block: l.block ? BLOCK_LABEL[l.block] : '', Concentration: l.concentrationId ? concs.find((k) => k.id === l.concentrationId)?.code ?? '' : '', Year: l.year, Term: l.term });
    }
    for (const [k, x] of rows.clos.entries()) wb.clos.push({ ID: content.clos[k]?.id ?? '', 'Course code': c.code, 'Course title': c.titleEn, ...Object.fromEntries(Object.entries(x).filter(([h]) => h !== 'Course code')) });
    wb.outline.push(...rows.outline); wb.materials.push(...rows.materials); wb.assessments.push(...rows.assessments); wb.rubrics.push(...rows.rubrics); wb.sections.push(...rows.sections);
  }
  return wb;
}
