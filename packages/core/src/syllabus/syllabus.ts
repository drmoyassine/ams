// The course syllabus (DEC-038, TASK-123). One document per course and version; the workflow is: the instructor suggests, the course
// coordinator edits and submits, the program chair endorses (or returns it), the Dean approves (or returns it). Approval writes the
// course's facts, its CLOs and their PLO links, and supersedes the previous version. A rule never blocks saving, importing or an upsert
// (the issues are stored and flagged); only submitting for review is refused while an error stands. A flagged syllabus needs the
// coordinator at once and goes up the line (chair, Dean, VPAA) after the days in the settings, until it is fixed.
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  appUser, course, courseInstructor, courseProgram, courseRequisite, institution, learningOutcome, orgUnit, outcomeLink, program, syllabusSuggestion, syllabusVersion,
} from '@ams/db';
import {
  checkSyllabus, DEFAULT_OUTCOME_LEVELS, DEFAULT_SYLLABUS_SETTINGS, DEFAULT_SYLLABUS_TEMPLATE, emptySyllabus, errorsOf, OutcomeLevelsSchema, resolveOutcomeLevel,
  CourseStaffSchema, ROLE_PERMISSIONS, ROLES, SaveSyllabusSchema, SuggestSchema, ResolveSuggestionSchema, SyllabusContentSchema, SyllabusSettingsSchema, SyllabusTemplateSchema, UpsertSyllabusSchema,
  type CourseStaff, type OutcomeLevel, type ResolveSuggestion, type SaveSyllabus, type Suggest, type SyllabusCheckContext, type SyllabusContent, type SyllabusIssue,
  type SyllabusListRow, type SyllabusOverview, type SyllabusPlo, type SyllabusSettings, type SyllabusStatus, type SyllabusSuggestion, type SyllabusTemplate,
  type SyllabusVersion, type UpsertSyllabus,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { createNotification } from '../notifications/store.js';
import { assertPermitted, isPermitted } from '../permissions.js';
import { courseScope, loadCourse } from '../outcomes/courses.js';

type VersionRow = typeof syllabusVersion.$inferSelect;
type CourseRow = typeof course.$inferSelect;
const DAY = 86_400_000;
const nfc = (s: string) => s.normalize('NFC').trim();
const iso = (d: Date | null) => (d ? d.toISOString() : null);

// ---- Settings and template ---------------------------------------------------------------------------------------------------

export async function getSyllabusSettings(ctx: Ctx): Promise<SyllabusSettings> {
  const [row] = await ctx.tx.select({ s: institution.syllabusSettings }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  const merged = { ...DEFAULT_SYLLABUS_SETTINGS, ...(row?.s ?? {}), escalateDays: { ...DEFAULT_SYLLABUS_SETTINGS.escalateDays, ...(row?.s?.escalateDays ?? {}) } };
  const parsed = SyllabusSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SYLLABUS_SETTINGS;
}

/** Sets the limits (minimum and maximum CLOs and PLOs) and the escalation days; every syllabus is checked again against them. */
export async function setSyllabusSettings(ctx: Ctx, input: SyllabusSettings): Promise<SyllabusSettings> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'org:write', { type: 'institution' });
  const settings = SyllabusSettingsSchema.parse(input);
  await ctx.tx.update(institution).set({ syllabusSettings: settings }).where(eq(institution.id, ctx.caller.institutionId));
  await recheckSyllabi(ctx);
  return settings;
}

export async function getSyllabusTemplate(ctx: Ctx): Promise<SyllabusTemplate> {
  const [row] = await ctx.tx.select({ t: institution.syllabusTemplate }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  const t = row?.t ?? {};
  return { sections: t.sections?.length ? t.sections : DEFAULT_SYLLABUS_TEMPLATE.sections, optional: t.optional ?? DEFAULT_SYLLABUS_TEMPLATE.optional };
}

export async function getLevels(ctx: Ctx): Promise<OutcomeLevel[]> {
  return levelsOf(ctx);
}
/**
 * Sets the sections of the syllabus template: their order, names and help, the sections an admin adds (free text), and which unlocked
 * fields are optional. The sections the rules depend on stay. Every syllabus is checked again, since an optional field changes what is an error.
 */
export async function setSyllabusTemplate(ctx: Ctx, input: SyllabusTemplate): Promise<SyllabusTemplate> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'org:write', { type: 'institution' });
  const parsed = SyllabusTemplateSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
  await ctx.tx.update(institution).set({ syllabusTemplate: parsed.data }).where(eq(institution.id, ctx.caller.institutionId));
  await recheckSyllabi(ctx);
  return getSyllabusTemplate(ctx);
}

async function levelsOf(ctx: Ctx): Promise<OutcomeLevel[]> {
  const [row] = await ctx.tx.select({ levels: institution.outcomeLevels }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  const parsed = OutcomeLevelsSchema.safeParse(row?.levels);
  return parsed.success ? parsed.data : DEFAULT_OUTCOME_LEVELS;
}

// ---- Who is who ----------------------------------------------------------------------------------------------------------------

const WRITE_ROLES = ROLES.filter((r) => ROLE_PERMISSIONS[r].includes('program:write') && r !== 'admin');

async function programIdsOf(ctx: Ctx, courseId: string): Promise<string[]> {
  return (await ctx.tx.select({ id: courseProgram.programId }).from(courseProgram).where(eq(courseProgram.courseId, courseId))).map((r) => r.id);
}

/** A unit and the units above it. */
async function unitAndAncestors(ctx: Ctx, unitId: string | null): Promise<string[]> {
  if (!unitId) return [];
  const units = await ctx.tx.select({ id: orgUnit.id, parentId: orgUnit.parentId }).from(orgUnit);
  const parent = new Map(units.map((u) => [u.id, u.parentId]));
  const out: string[] = []; let at: string | null = unitId;
  while (at && !out.includes(at)) { out.push(at); at = parent.get(at) ?? null; }
  return out;
}

/** The people who answer for a syllabus at one level of the line: 0 the course coordinator, 1 the program chair, 2 the Dean, 3 the VPAA. */
async function peopleAt(ctx: Ctx, c: CourseRow, level: number): Promise<string[]> {
  if (level === 0) return c.coordinatorUserId ? [c.coordinatorUserId] : [];
  const roles = [...WRITE_ROLES];
  const scopes = level === 1 ? { type: 'program', ids: await programIdsOf(ctx, c.id) } : level === 2 ? { type: 'org_unit', ids: await unitAndAncestors(ctx, c.orgUnitId) } : { type: 'institution', ids: [ctx.caller.institutionId] };
  if (!scopes.ids.length) return [];
  const rows = await ctx.tx.execute(sql`select user_id from syllabus_responsible(${sql.raw(`ARRAY[${roles.map((r) => `'${r}'`).join(',')}]::text[]`)}, ${scopes.type}, ${sql.raw(`ARRAY[${scopes.ids.map((i) => `'${i}'`).join(',')}]::uuid[]`)})`);
  return (rows.rows as { user_id: string }[]).map((r) => r.user_id);
}

/** How far up the line a flag that began at `since` has gone, by the settings' days. */
export function levelReached(since: Date | string | null, settings: SyllabusSettings, now = new Date()): number {
  if (!since) return 0;
  const days = (now.getTime() - new Date(since).getTime()) / DAY;
  return days >= settings.escalateDays.vpaa ? 3 : days >= settings.escalateDays.dean ? 2 : days >= settings.escalateDays.chair ? 1 : 0;
}

interface Powers { edit: boolean; suggest: boolean; endorse: boolean; approve: boolean }
async function powersOf(ctx: Ctx, c: CourseRow): Promise<Powers> {
  const me = ctx.caller.userId;
  const writer = await isPermitted(ctx.tx, 'program:write', courseScope(c.orgUnitId));
  const edit = (!!me && c.coordinatorUserId === me) || writer;
  const progs = await programIdsOf(ctx, c.id);
  let endorse = writer;
  for (const p of progs) if (!endorse && await isPermitted(ctx.tx, 'program:write', { type: 'program', id: p })) endorse = true;
  const instructor = !!me && (await ctx.tx.select({ id: courseInstructor.id }).from(courseInstructor).where(and(eq(courseInstructor.courseId, c.id), eq(courseInstructor.userId, me)))).length > 0;
  return { edit, suggest: edit || instructor || endorse, endorse, approve: writer };
}

// ---- The checking context and the flag ----------------------------------------------------------------------------------------

async function checkContext(ctx: Ctx, c: CourseRow): Promise<SyllabusCheckContext> {
  const [settings, levels, template] = await Promise.all([getSyllabusSettings(ctx), levelsOf(ctx), getSyllabusTemplate(ctx)]);
  const progs = await programIdsOf(ctx, c.id);
  const plos = progs.length ? await ctx.tx.select({ id: learningOutcome.id }).from(learningOutcome).where(and(eq(learningOutcome.kind, 'plo'), inArray(learningOutcome.programId, progs))) : [];
  const known = await ctx.tx.select({ id: course.id }).from(course);
  return { settings, levels, allowedPloIds: new Set(plos.map((p) => p.id)), programCount: progs.length, optional: new Set(template.optional), knownCourseIds: new Set(known.map((k) => k.id)) };
}

/** The computed columns of a version: its issues, the counts, and when it was first flagged (kept while it stays flagged). */
function computed(issues: SyllabusIssue[], row: Pick<VersionRow, 'flaggedSince' | 'escalationLevel'> | null) {
  const errors = errorsOf(issues).length;
  const flaggedSince = errors === 0 ? null : row?.flaggedSince ?? new Date();
  return { issues, errorCount: errors, warningCount: issues.length - errors, flaggedSince, escalationLevel: errors === 0 ? 0 : row?.escalationLevel ?? 0 };
}

async function notifyFlag(ctx: Ctx, c: CourseRow, v: Pick<VersionRow, 'id' | 'versionNo'>, errors: number, level: number) {
  let people = await peopleAt(ctx, c, level);
  // No coordinator named: the chair is the first to answer.
  if (level === 0 && !people.length) people = await peopleAt(ctx, c, 1);
  for (const userId of people) {
    await createNotification(ctx, {
      userId, kind: 'syllabus_flagged', refKind: 'syllabus_version', refId: v.id,
      title: `${c.code} syllabus needs attention`, body: `${errors} error${errors === 1 ? '' : 's'} in the syllabus of ${c.code} ${c.titleEn} (version ${v.versionNo}); fix them to submit it for review.`,
    });
  }
}

// ---- Reading -------------------------------------------------------------------------------------------------------------------

async function names(ctx: Ctx, ids: (string | null)[]): Promise<Map<string, string>> {
  const set = [...new Set(ids.filter((x): x is string => !!x))];
  if (!set.length) return new Map();
  return new Map((await ctx.tx.select({ id: appUser.id, name: appUser.fullName }).from(appUser).where(inArray(appUser.id, set))).map((u) => [u.id, u.name]));
}

async function toVersions(ctx: Ctx, rows: VersionRow[]): Promise<SyllabusVersion[]> {
  const who = await names(ctx, rows.flatMap((r) => [r.submittedBy, r.endorsedBy, r.approvedBy]));
  return rows.map((r) => ({
    id: r.id, courseId: r.courseId, versionNo: r.versionNo, status: r.status, content: SyllabusContentSchema.parse(r.content), issues: r.issues as SyllabusIssue[],
    errorCount: r.errorCount, warningCount: r.warningCount, flaggedSince: iso(r.flaggedSince), escalationLevel: r.escalationLevel,
    effectiveFrom: r.effectiveFrom, source: r.source, returnedNote: r.returnedNote, submittedAt: iso(r.submittedAt), endorsedAt: iso(r.endorsedAt), approvedAt: iso(r.approvedAt),
    submittedByName: r.submittedBy ? who.get(r.submittedBy) ?? null : null, endorsedByName: r.endorsedBy ? who.get(r.endorsedBy) ?? null : null,
    approvedByName: r.approvedBy ? who.get(r.approvedBy) ?? null : null, updatedAt: r.updatedAt.toISOString(),
  }));
}

async function loadVersion(ctx: Ctx, id: string): Promise<VersionRow> {
  const [row] = await ctx.tx.select().from(syllabusVersion).where(eq(syllabusVersion.id, id));
  if (!row) throw new NotFoundError(`syllabus ${id}`);
  return row;
}

/** A starting document from what the course already holds: its facts, and its CLOs with their PLO and coverage level. */
export async function startingContent(ctx: Ctx, c: CourseRow): Promise<SyllabusContent> {
  const doc = emptySyllabus();
  const lang = (c.languageOfInstruction ?? '').toLowerCase();
  doc.info = {
    titleEn: c.titleEn, titleAr: c.titleAr ?? '', credits: c.credits === null ? null : Number(c.credits), languageOfDelivery: ['english', 'arabic', 'bilingual'].includes(lang) ? lang : '',
    contactLecture: c.contactLecture === null ? null : Number(c.contactLecture), contactLab: c.contactLab === null ? null : Number(c.contactLab), contactOther: c.contactOther === null ? null : Number(c.contactOther),
    courseType: c.courseType ?? '', courseLevel: c.levelBand ?? '', category: c.category ?? '', sustainability: c.sustainability ?? '',
    prerequisiteIds: [], corequisiteIds: [],
  };
  const reqs = await ctx.tx.select().from(courseRequisite).where(eq(courseRequisite.courseId, c.id));
  doc.info.prerequisiteIds = reqs.filter((r) => r.kind === 'prerequisite').map((r) => r.requisiteId);
  doc.info.corequisiteIds = reqs.filter((r) => r.kind === 'corequisite').map((r) => r.requisiteId);
  doc.description.en = c.description ?? '';
  const clos = (await ctx.tx.select().from(learningOutcome).where(and(eq(learningOutcome.courseId, c.id), eq(learningOutcome.kind, 'clo'), ne(learningOutcome.status, 'retired')))).sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code, 'en', { numeric: true }));
  const links = clos.length ? await ctx.tx.select().from(outcomeLink).where(inArray(outcomeLink.fromId, clos.map((x) => x.id))) : [];
  doc.clos = clos.map((x) => {
    const link = links.find((l) => l.fromId === x.id);
    return { id: x.id, code: x.code, textEn: x.textEn, textAr: x.textAr ?? '', bloom: x.bloomLevel ?? '', ploId: link?.toId ?? '', level: link?.level ?? '' };
  });
  return doc;
}

async function ploChoices(ctx: Ctx, courseId: string): Promise<SyllabusPlo[]> {
  const progs = await programIdsOf(ctx, courseId);
  if (!progs.length) return [];
  const rows = await ctx.tx.select({ id: learningOutcome.id, code: learningOutcome.code, textEn: learningOutcome.textEn, programId: learningOutcome.programId, programName: program.nameEn })
    .from(learningOutcome).innerJoin(program, eq(program.id, learningOutcome.programId)).where(and(eq(learningOutcome.kind, 'plo'), inArray(learningOutcome.programId, progs), ne(learningOutcome.status, 'retired')));
  return rows.map((r) => ({ id: r.id, code: r.code, textEn: r.textEn, programId: r.programId!, programName: r.programName })).sort((a, b) => a.programName.localeCompare(b.programName) || a.code.localeCompare(b.code, 'en', { numeric: true }));
}

/** The course's Syllabus tab in one read: the approved version, the one in progress (or a starting document when there is none), the history and the suggestions. */
export async function getSyllabusOverview(ctx: Ctx, courseId: string): Promise<SyllabusOverview> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const c = await loadCourse(ctx, courseId);
  const rows = await ctx.tx.select().from(syllabusVersion).where(eq(syllabusVersion.courseId, courseId)).orderBy(desc(syllabusVersion.versionNo));
  const versions = await toVersions(ctx, rows);
  const open = versions.find((v) => ['draft', 'in_review', 'endorsed'].includes(v.status)) ?? null;
  const sugg = open ? await ctx.tx.select().from(syllabusSuggestion).where(eq(syllabusSuggestion.syllabusVersionId, open.id)).orderBy(asc(syllabusSuggestion.createdAt)) : [];
  const teachers = await ctx.tx.select({ userId: courseInstructor.userId }).from(courseInstructor).where(eq(courseInstructor.courseId, c.id));
  const who = await names(ctx, [...sugg.map((s) => s.createdBy), c.coordinatorUserId, ...teachers.map((t) => t.userId)]);
  const [unit] = c.orgUnitId ? await ctx.tx.select({ name: orgUnit.nameEn }).from(orgUnit).where(eq(orgUnit.id, c.orgUnitId)) : [];
  const courses = await ctx.tx.select({ id: course.id, code: course.code, titleEn: course.titleEn }).from(course).orderBy(asc(course.code));
  return {
    course: { id: c.id, code: c.code, titleEn: c.titleEn, titleAr: c.titleAr, credits: c.credits === null ? null : Number(c.credits), unitName: unit?.name ?? null, coordinatorName: c.coordinatorUserId ? who.get(c.coordinatorUserId) ?? null : null, coordinatorUserId: c.coordinatorUserId, instructors: teachers.map((t) => ({ id: t.userId, name: who.get(t.userId) ?? '' })), programIds: await programIdsOf(ctx, c.id) },
    current: versions.find((v) => v.status === 'approved') ?? null, open,
    history: versions.map((v) => ({ id: v.id, versionNo: v.versionNo, status: v.status, effectiveFrom: v.effectiveFrom, approvedAt: v.approvedAt })),
    suggestions: sugg.map((s): SyllabusSuggestion => ({ id: s.id, versionId: s.syllabusVersionId, section: s.section, suggestion: s.suggestion, status: s.status, byName: s.createdBy ? who.get(s.createdBy) ?? null : null, createdAt: s.createdAt.toISOString(), resolutionNote: s.resolutionNote })),
    can: await powersOf(ctx, c), settings: await getSyllabusSettings(ctx), template: await getSyllabusTemplate(ctx), levels: await levelsOf(ctx), plos: await ploChoices(ctx, courseId), courses,
  };
}

/** A starting document for a course with no syllabus yet (from what the course holds), for the editor to begin with. */
export async function getStartingSyllabus(ctx: Ctx, courseId: string): Promise<SyllabusContent> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  return startingContent(ctx, await loadCourse(ctx, courseId));
}

/** Names the course coordinator (who edits the syllabus and is told first when it is flagged) and the instructors (who may suggest changes). Needs program:write at the course's unit. */
export async function setCourseStaff(ctx: Ctx, courseId: string, input: CourseStaff): Promise<CourseStaff> {
  assertHuman(ctx);
  const c = await loadCourse(ctx, courseId);
  await assertPermitted(ctx, 'program:write', courseScope(c.orgUnitId));
  const d = CourseStaffSchema.parse(input);
  const wanted = [...new Set([...(d.coordinatorUserId ? [d.coordinatorUserId] : []), ...d.instructorIds])];
  const found = wanted.length ? await ctx.tx.select({ id: appUser.id }).from(appUser).where(and(inArray(appUser.id, wanted), eq(appUser.active, true))) : [];
  if (found.length !== wanted.length) throw new NotFoundError('a person named as coordinator or instructor');
  await ctx.tx.update(course).set({ coordinatorUserId: d.coordinatorUserId }).where(eq(course.id, courseId));
  await ctx.tx.delete(courseInstructor).where(eq(courseInstructor.courseId, courseId));
  for (const userId of new Set(d.instructorIds)) await ctx.tx.insert(courseInstructor).values({ institutionId: ctx.caller.institutionId, courseId, userId });
  return { coordinatorUserId: d.coordinatorUserId, instructorIds: [...new Set(d.instructorIds)] };
}

// ---- Saving a draft (the screen, an import and the API all come here) ---------------------------------------------------------------

async function openVersion(ctx: Ctx, courseId: string): Promise<VersionRow | undefined> {
  return (await ctx.tx.select().from(syllabusVersion).where(and(eq(syllabusVersion.courseId, courseId), inArray(syllabusVersion.status, ['draft', 'in_review', 'endorsed'])))).at(0);
}

/**
 * Saves the draft of a course's syllabus: creates it (from the content given) or replaces the content of the draft in progress. The
 * content may break any rule: it is stored with its issues flagged. A version that is in review or endorsed must be returned first.
 */
export async function saveSyllabusDraft(ctx: Ctx, courseId: string, input: SaveSyllabus): Promise<SyllabusVersion> {
  assertHuman(ctx);
  const c = await loadCourse(ctx, courseId);
  if (!(await powersOf(ctx, c)).edit) throw new ForbiddenError('only the course coordinator (or someone who may write the course) edits its syllabus');
  const { content, source } = SaveSyllabusSchema.parse(input);
  const issues = checkSyllabus(content, await checkContext(ctx, c));
  const open = await openVersion(ctx, courseId);
  if (open && open.status !== 'draft') throw new ConflictError(`the syllabus is ${open.status === 'in_review' ? 'in review' : 'endorsed'}: return it to the coordinator before editing`);
  let row: VersionRow;
  if (open) {
    const cols = computed(issues, open);
    [row] = await guardIntegrity(() => ctx.tx.update(syllabusVersion).set({ content, source: source ?? open.source, returnedNote: null, ...cols }).where(eq(syllabusVersion.id, open.id)).returning()) as [VersionRow];
    if (cols.errorCount > 0 && !open.flaggedSince) await notifyFlag(ctx, c, row, cols.errorCount, 0);
  } else {
    const [last] = await ctx.tx.select({ n: sql<number>`coalesce(max(${syllabusVersion.versionNo}), 0)::int` }).from(syllabusVersion).where(eq(syllabusVersion.courseId, courseId));
    const cols = computed(issues, null);
    [row] = await guardIntegrity(() => ctx.tx.insert(syllabusVersion).values({ institutionId: ctx.caller.institutionId, courseId, versionNo: (last?.n ?? 0) + 1, status: 'draft', content, source: source ?? null, ...cols }).returning()) as [VersionRow];
    if (cols.errorCount > 0) await notifyFlag(ctx, c, row, cols.errorCount, 0);
  }
  return (await toVersions(ctx, [row]))[0]!;
}

/** The API's and the import's way in: by course code, always a draft; only people approve. The course must exist. */
export async function upsertSyllabus(ctx: Ctx, input: UpsertSyllabus): Promise<SyllabusVersion> {
  assertHuman(ctx);
  const { courseCode, content, source } = UpsertSyllabusSchema.parse(input);
  const [c] = await ctx.tx.select().from(course).where(eq(course.code, nfc(courseCode)));
  if (!c) throw new NotFoundError(`course ${courseCode}`);
  return saveSyllabusDraft(ctx, c.id, { content, source });
}

/** Throws away the draft in progress (an approved version is never deleted). */
export async function discardDraft(ctx: Ctx, courseId: string): Promise<{ deleted: boolean }> {
  assertHuman(ctx);
  const c = await loadCourse(ctx, courseId);
  if (!(await powersOf(ctx, c)).edit) throw new ForbiddenError('only the course coordinator discards a draft');
  const open = await openVersion(ctx, courseId);
  if (!open) return { deleted: false };
  if (open.status !== 'draft') throw new ConflictError('only a draft can be discarded');
  await ctx.tx.delete(syllabusVersion).where(eq(syllabusVersion.id, open.id));
  return { deleted: true };
}

// ---- Suggestions -------------------------------------------------------------------------------------------------------------------

export async function suggestChange(ctx: Ctx, versionId: string, input: Suggest): Promise<SyllabusSuggestion> {
  assertHuman(ctx);
  const v = await loadVersion(ctx, versionId);
  const c = await loadCourse(ctx, v.courseId);
  if (!(await powersOf(ctx, c)).suggest) throw new ForbiddenError('only the course’s instructors, coordinator and reviewers suggest changes');
  if (!['draft', 'in_review', 'endorsed'].includes(v.status)) throw new ConflictError('suggestions are made on the syllabus in progress');
  const d = SuggestSchema.parse(input);
  const [row] = await ctx.tx.insert(syllabusSuggestion).values({ institutionId: ctx.caller.institutionId, syllabusVersionId: versionId, section: d.section, suggestion: d.suggestion }).returning();
  const who = await names(ctx, [row!.createdBy]);
  if (c.coordinatorUserId && c.coordinatorUserId !== ctx.caller.userId) {
    await createNotification(ctx, { userId: c.coordinatorUserId, kind: 'syllabus_flagged', refKind: 'syllabus_version', refId: versionId, title: `Suggestion on the ${c.code} syllabus`, body: `${who.get(row!.createdBy ?? '') ?? 'Someone'} suggests a change to ${d.section}: ${d.suggestion.slice(0, 200)}` });
  }
  return { id: row!.id, versionId, section: row!.section, suggestion: row!.suggestion, status: 'open', byName: who.get(row!.createdBy ?? '') ?? null, createdAt: row!.createdAt.toISOString(), resolutionNote: null };
}

/** The coordinator accepts (and makes the change in the draft) or declines a suggestion. */
export async function resolveSuggestion(ctx: Ctx, id: string, input: ResolveSuggestion): Promise<{ id: string; status: 'accepted' | 'declined' }> {
  assertHuman(ctx);
  const [s] = await ctx.tx.select().from(syllabusSuggestion).where(eq(syllabusSuggestion.id, id));
  if (!s) throw new NotFoundError(`suggestion ${id}`);
  const c = await loadCourse(ctx, (await loadVersion(ctx, s.syllabusVersionId)).courseId);
  if (!(await powersOf(ctx, c)).edit) throw new ForbiddenError('only the course coordinator resolves a suggestion');
  if (s.status !== 'open') throw new ConflictError('the suggestion is already resolved');
  const d = ResolveSuggestionSchema.parse(input);
  await ctx.tx.update(syllabusSuggestion).set({ status: d.decision, resolvedBy: ctx.caller.userId, resolvedAt: new Date(), resolutionNote: d.note ?? null }).where(eq(syllabusSuggestion.id, id));
  return { id, status: d.decision };
}

// ---- The workflow --------------------------------------------------------------------------------------------------------------------

async function stage(ctx: Ctx, versionId: string, from: SyllabusStatus[], who: 'edit' | 'endorse' | 'approve'): Promise<{ v: VersionRow; c: CourseRow }> {
  assertHuman(ctx);
  const v = await loadVersion(ctx, versionId);
  const c = await loadCourse(ctx, v.courseId);
  const p = await powersOf(ctx, c);
  if (!p[who]) throw new ForbiddenError(who === 'edit' ? 'only the course coordinator does this' : who === 'endorse' ? 'only the program chair (or above) does this' : 'only the Dean (or above) does this');
  if (!from.includes(v.status)) throw new ConflictError(`the syllabus is ${v.status.replace('_', ' ')}`);
  return { v, c };
}

/** The coordinator submits the draft for review. Refused while the draft has errors; warnings do not stop it. */
export async function submitSyllabus(ctx: Ctx, versionId: string): Promise<SyllabusVersion> {
  const { v, c } = await stage(ctx, versionId, ['draft'], 'edit');
  const issues = checkSyllabus(SyllabusContentSchema.parse(v.content), await checkContext(ctx, c));
  const errors = errorsOf(issues);
  if (errors.length) throw new ValidationError(`the syllabus has ${errors.length} error${errors.length === 1 ? '' : 's'} to fix before it can be submitted: ${errors.slice(0, 3).map((e) => e.message).join(' ')}`);
  const [row] = await ctx.tx.update(syllabusVersion).set({ status: 'in_review', submittedBy: ctx.caller.userId, submittedAt: new Date(), returnedNote: null, ...computed(issues, v) }).where(eq(syllabusVersion.id, v.id)).returning();
  return (await toVersions(ctx, [row!]))[0]!;
}

/** The program chair (or the Dean) sends it back to the coordinator with a note. */
export async function returnSyllabus(ctx: Ctx, versionId: string, note?: string): Promise<SyllabusVersion> {
  const { v } = await stage(ctx, versionId, ['in_review', 'endorsed'], 'endorse');
  const [row] = await ctx.tx.update(syllabusVersion).set({ status: 'draft', returnedNote: note?.trim() || null, submittedBy: null, submittedAt: null, endorsedBy: null, endorsedAt: null }).where(eq(syllabusVersion.id, v.id)).returning();
  return (await toVersions(ctx, [row!]))[0]!;
}

export async function endorseSyllabus(ctx: Ctx, versionId: string): Promise<SyllabusVersion> {
  const { v } = await stage(ctx, versionId, ['in_review'], 'endorse');
  const [row] = await ctx.tx.update(syllabusVersion).set({ status: 'endorsed', endorsedBy: ctx.caller.userId, endorsedAt: new Date() }).where(eq(syllabusVersion.id, v.id)).returning();
  return (await toVersions(ctx, [row!]))[0]!;
}

/** The Dean approves an endorsed syllabus: the course takes its facts and CLOs, and the previous approved version is superseded. */
export async function approveSyllabus(ctx: Ctx, versionId: string, input: { effectiveFrom?: string | undefined } = {}): Promise<SyllabusVersion> {
  const { v, c } = await stage(ctx, versionId, ['endorsed'], 'approve');
  const content = SyllabusContentSchema.parse(v.content);
  const errors = errorsOf(checkSyllabus(content, await checkContext(ctx, c)));
  if (errors.length) throw new ValidationError(`the syllabus has ${errors.length} error${errors.length === 1 ? '' : 's'} (the settings changed since it was submitted): return it to the coordinator`);
  await ctx.tx.update(syllabusVersion).set({ status: 'superseded' }).where(and(eq(syllabusVersion.courseId, c.id), eq(syllabusVersion.status, 'approved')));
  const [row] = await ctx.tx.update(syllabusVersion).set({ status: 'approved', approvedBy: ctx.caller.userId, approvedAt: new Date(), effectiveFrom: input.effectiveFrom?.trim() || null }).where(eq(syllabusVersion.id, v.id)).returning();
  await writeCourse(ctx, c, content, v.versionNo);
  return (await toVersions(ctx, [row!]))[0]!;
}

const LANGUAGE_NAME: Record<string, string> = { english: 'English', arabic: 'Arabic', bilingual: 'Bilingual' };

/** What approval writes to the course: its facts, its requisites, its CLOs (new, changed, retired) and each CLO's link to its PLO at its coverage level. */
async function writeCourse(ctx: Ctx, c: CourseRow, doc: SyllabusContent, versionNo: number) {
  const i = doc.info;
  const num = (x: number | null) => (x === null ? null : String(x));
  await ctx.tx.update(course).set({
    titleEn: nfc(i.titleEn) || c.titleEn, titleAr: i.titleAr ? nfc(i.titleAr) : null, description: doc.description.en ? nfc(doc.description.en) : null, credits: num(i.credits),
    languageOfInstruction: LANGUAGE_NAME[i.languageOfDelivery] ?? c.languageOfInstruction, contactLecture: num(i.contactLecture), contactLab: num(i.contactLab), contactOther: num(i.contactOther),
    courseType: (i.courseType || null) as CourseRow['courseType'], levelBand: (i.courseLevel || null) as CourseRow['levelBand'], category: (i.category || null) as CourseRow['category'], sustainability: (i.sustainability || null) as CourseRow['sustainability'],
  }).where(eq(course.id, c.id));
  await ctx.tx.delete(courseRequisite).where(eq(courseRequisite.courseId, c.id));
  const reqs: { id: string; kind: 'prerequisite' | 'corequisite' }[] = [...new Set(i.prerequisiteIds)].map((id) => ({ id, kind: 'prerequisite' }));
  for (const id of new Set(i.corequisiteIds)) if (!i.prerequisiteIds.includes(id)) reqs.push({ id, kind: 'corequisite' });
  for (const r of reqs) await ctx.tx.insert(courseRequisite).values({ institutionId: ctx.caller.institutionId, courseId: c.id, requisiteId: r.id, kind: r.kind });

  const levels = await levelsOf(ctx);
  const existing = await ctx.tx.select().from(learningOutcome).where(and(eq(learningOutcome.courseId, c.id), eq(learningOutcome.kind, 'clo')));
  const kept = new Set<string>();
  const today = new Date().toISOString().slice(0, 10);
  for (const [k, x] of doc.clos.entries()) {
    const match = existing.find((e) => e.id === x.id) ?? existing.find((e) => e.code === x.code);
    const values = { textEn: nfc(x.textEn), textAr: x.textAr ? nfc(x.textAr) : null, bloomLevel: (x.bloom || null) as typeof learningOutcome.$inferInsert['bloomLevel'], displayOrder: k + 1, code: x.code || `CLO${k + 1}`, status: 'approved' as const, approvedOn: today, approvalRef: `syllabus v${versionNo}`, source: 'syllabus' };
    let id: string;
    if (match) { await ctx.tx.update(learningOutcome).set(values).where(eq(learningOutcome.id, match.id)); id = match.id; }
    else [{ id }] = await ctx.tx.insert(learningOutcome).values({ institutionId: ctx.caller.institutionId, kind: 'clo', courseId: c.id, ...values }).returning({ id: learningOutcome.id }) as [{ id: string }];
    kept.add(id);
    await ctx.tx.delete(outcomeLink).where(eq(outcomeLink.fromId, id));
    if (x.ploId) await ctx.tx.insert(outcomeLink).values({ institutionId: ctx.caller.institutionId, fromId: id, toId: x.ploId, level: resolveOutcomeLevel(levels, x.level) });
  }
  // A CLO the syllabus no longer has is retired, not deleted: results and assessments may refer to it.
  for (const e of existing) if (!kept.has(e.id) && e.status !== 'retired') await ctx.tx.update(learningOutcome).set({ status: 'retired' }).where(eq(learningOutcome.id, e.id));
}

// ---- Settings changed: check everything again --------------------------------------------------------------------------------------

/** Checks the approved and the open version of every course against the current settings (a limit may have been tightened). Content is untouched. */
export async function recheckSyllabi(ctx: Ctx): Promise<{ checked: number; flagged: number }> {
  const rows = await ctx.tx.select().from(syllabusVersion).where(inArray(syllabusVersion.status, ['approved', 'draft', 'in_review', 'endorsed']));
  let flagged = 0;
  for (const r of rows) {
    const c = await loadCourse(ctx, r.courseId);
    const cols = computed(checkSyllabus(SyllabusContentSchema.parse(r.content), await checkContext(ctx, c)), r);
    await ctx.tx.update(syllabusVersion).set(cols).where(eq(syllabusVersion.id, r.id));
    if (cols.errorCount > 0) { flagged++; if (!r.flaggedSince) await notifyFlag(ctx, c, r, cols.errorCount, 0); }
  }
  return { checked: rows.length, flagged };
}

// ---- The list, and escalation up the line --------------------------------------------------------------------------------------------

/** One row per course: its approved version, the version in progress and the flag. `needsMyAttention` follows the line: the coordinator at once, then the chair, the Dean and the VPAA as days pass. */
export async function listSyllabi(ctx: Ctx, filter: { flagged?: boolean; mine?: boolean } = {}): Promise<SyllabusListRow[]> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const [courses, versions, settings] = await Promise.all([
    ctx.tx.select().from(course).orderBy(asc(course.code)), ctx.tx.select().from(syllabusVersion).where(inArray(syllabusVersion.status, ['approved', 'draft', 'in_review', 'endorsed'])), getSyllabusSettings(ctx),
  ]);
  const units = new Map((await ctx.tx.select({ id: orgUnit.id, name: orgUnit.nameEn }).from(orgUnit)).map((u) => [u.id, u.name]));
  const who = await names(ctx, courses.map((c) => c.coordinatorUserId));
  const me = ctx.caller.userId;
  const rows: SyllabusListRow[] = [];
  for (const c of courses) {
    const cur = versions.find((v) => v.courseId === c.id && v.status === 'approved');
    const open = versions.find((v) => v.courseId === c.id && v.status !== 'approved');
    // The syllabus that is flagged: the one in progress when there is one (it is the one being fixed), else the approved one.
    const flagged = [open, cur].find((v) => v && v.errorCount > 0) ?? open ?? cur;
    let needs = false;
    if (flagged && flagged.errorCount > 0 && me) {
      const reached = levelReached(flagged.flaggedSince, settings);
      for (let level = 0; level <= reached && !needs; level++) needs = (await peopleAt(ctx, c, level)).includes(me);
    }
    rows.push({
      courseId: c.id, code: c.code, titleEn: c.titleEn, unitName: c.orgUnitId ? units.get(c.orgUnitId) ?? null : null, coordinatorName: c.coordinatorUserId ? who.get(c.coordinatorUserId) ?? null : null,
      currentVersionNo: cur?.versionNo ?? null, currentApprovedAt: iso(cur?.approvedAt ?? null), openStatus: open?.status ?? null,
      errorCount: flagged?.errorCount ?? 0, warningCount: flagged?.warningCount ?? 0, flaggedSince: iso(flagged?.flaggedSince ?? null), escalationLevel: flagged?.escalationLevel ?? 0, needsMyAttention: needs,
    });
  }
  return rows.filter((r) => (!filter.flagged || r.errorCount > 0) && (!filter.mine || r.needsMyAttention));
}

/** Tells the next level of the line about every flag that has gone unfixed past its days (once per level). Called when the Syllabi list is opened. */
export async function escalateFlags(ctx: Ctx): Promise<{ notified: number }> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const settings = await getSyllabusSettings(ctx);
  const flagged = await ctx.tx.select().from(syllabusVersion).where(and(inArray(syllabusVersion.status, ['approved', 'draft', 'in_review', 'endorsed']), sql`${syllabusVersion.errorCount} > 0`));
  let notified = 0;
  for (const v of flagged) {
    const reached = levelReached(v.flaggedSince, settings);
    if (reached <= v.escalationLevel) continue;
    const c = await loadCourse(ctx, v.courseId);
    for (let level = v.escalationLevel + 1; level <= reached; level++) { await notifyFlag(ctx, c, v, v.errorCount, level); notified++; }
    await ctx.tx.update(syllabusVersion).set({ escalationLevel: reached }).where(eq(syllabusVersion.id, v.id));
  }
  return { notified };
}
