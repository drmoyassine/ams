// Importing syllabi from the Excel workbook (DEC-038, TASK-126). Every course in the workbook becomes (or replaces) that course's DRAFT
// syllabus; a rule never refuses a course: it loads with its issues flagged to the coordinator and up the line. A course the importer
// may not edit, that is already in review, or that does not exist is reported and skipped; the rest still load.
import { and, eq, inArray, ne } from 'drizzle-orm';
import { course, courseProgram, learningOutcome } from '@ams/db';
import { SyllabusWorkbookSchema, workbookToSyllabi, type SyllabusWorkbook } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, ForbiddenError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';
import { getLevels as levelsOf, saveSyllabusDraft } from './syllabus.js';

export interface SyllabusImportResult {
  courseCode: string;
  status: 'loaded' | 'unknown_course' | 'not_allowed' | 'in_review';
  versionNo?: number; errors?: number; warnings?: number; message?: string;
}

export async function importSyllabi(ctx: Ctx, input: SyllabusWorkbook, source = 'excel import'): Promise<{ results: SyllabusImportResult[]; loaded: number; flagged: number }> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const wb = SyllabusWorkbookSchema.parse(input);
  const courses = await ctx.tx.select().from(course);
  const byCode = new Map(courses.map((c) => [c.code.toUpperCase().replace(/\s+/g, ' '), c]));
  const progs = await ctx.tx.select().from(courseProgram);
  const plos = (await ctx.tx.select().from(learningOutcome).where(and(eq(learningOutcome.kind, 'plo'), ne(learningOutcome.status, 'retired'))));
  const clos = await ctx.tx.select().from(learningOutcome).where(and(eq(learningOutcome.kind, 'clo'), inArray(learningOutcome.courseId, courses.map((c) => c.id).concat('00000000-0000-0000-0000-000000000000'))));
  const resolver = {
    levels: await levelsOf(ctx),
    courseId: (c: string) => byCode.get(c)?.id,
    cloId: (c: string, k: string) => clos.find((x) => x.courseId === byCode.get(c)?.id && x.code.toUpperCase() === k.toUpperCase())?.id,
    plo: (c: string, text: string) => {
      const cc = byCode.get(c); if (!cc) return '';
      const want = text.trim().toUpperCase(); const head = want.split(/[\s(]/)[0] ?? want;
      const mine = plos.filter((p) => progs.some((x) => x.courseId === cc.id && x.programId === p.programId) && p.code.toUpperCase() === head);
      if (mine.length <= 1) return mine[0]?.id ?? '';
      return mine.find((p) => want.includes((p.programId ?? '').toUpperCase())) ?.id ?? mine[0]!.id;
    },
  };
  const docs = workbookToSyllabi(wb, resolver);
  const results: SyllabusImportResult[] = [];
  for (const [codeKey, content] of docs) {
    const c = byCode.get(codeKey);
    if (!c) { results.push({ courseCode: codeKey, status: 'unknown_course', message: 'No course has this code: add it first (Settings, Organization, Courses).' }); continue; }
    try {
      const v = await saveSyllabusDraft(ctx, c.id, { content, source });
      results.push({ courseCode: c.code, status: 'loaded', versionNo: v.versionNo, errors: v.errorCount, warnings: v.warningCount });
    } catch (e) {
      if (e instanceof ForbiddenError) results.push({ courseCode: c.code, status: 'not_allowed', message: 'Only the course coordinator (or a course writer) loads its syllabus.' });
      else if (e instanceof ConflictError) results.push({ courseCode: c.code, status: 'in_review', message: e.message });
      else throw e;
    }
  }
  const loaded = results.filter((r) => r.status === 'loaded');
  return { results, loaded: loaded.length, flagged: loaded.filter((r) => (r.errors ?? 0) > 0).length };
}
