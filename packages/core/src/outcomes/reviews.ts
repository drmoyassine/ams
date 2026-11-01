// Program review by rubric (TASK-118): findings per program and criterion, append-only (a later pass adds a row; the latest row is the
// current judgement). The rubric and its maturity levels are the institution's configuration. Levels are internal maturity, never an
// accreditation judgement (DEC-005). Reading follows program visibility; adding needs program:write on the program.
import { asc, desc, eq } from 'drizzle-orm';
import { appUser, institution, orgUnit, program, programReviewFinding } from '@ams/db';
import { ReviewRubricSchema, type AddReviewFinding, type ProgramReview, type ReviewFinding, type ReviewRubric, type ReviewSummary } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';

const fold = (s: string | null | undefined) => (s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const today = () => new Date().toISOString().slice(0, 10);

export async function getReviewRubric(ctx: Ctx): Promise<ReviewRubric> {
  const [row] = await ctx.tx.select({ r: institution.reviewRubric }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  return ReviewRubricSchema.parse(row?.r);
}

export async function setReviewRubric(ctx: Ctx, input: ReviewRubric): Promise<ReviewRubric> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'org:write', { type: 'institution' });
  const rubric = ReviewRubricSchema.parse(input);
  await ctx.tx.update(institution).set({ reviewRubric: rubric }).where(eq(institution.id, ctx.caller.institutionId));
  return rubric;
}

/** A level given as its code or its name ("Developing" or "developing"), or null. */
export const resolveReviewLevel = (rubric: ReviewRubric, level: string) =>
  rubric.levels.find((l) => fold(l.code) === fold(level) || fold(l.name) === fold(level))?.code ?? null;

type Row = typeof programReviewFinding.$inferSelect;
const toFinding = (r: Row, by: string | null): ReviewFinding => ({
  id: r.id, programId: r.programId, criterionNo: r.criterionNo, level: r.level, finding: r.finding, evidence: r.evidence, gaps: r.gaps,
  auditDate: r.auditDate, pass: r.pass, basis: r.basis, source: r.source, createdAt: r.createdAt.toISOString(), createdByName: by,
});

/** Every finding of one program, newest first, with the rubric. */
export async function getProgramReview(ctx: Ctx, programId: string): Promise<ProgramReview> {
  await assertPermitted(ctx, 'program:read', { type: 'program', id: programId });
  const [p] = await ctx.tx.select({ id: program.id }).from(program).where(eq(program.id, programId));
  if (!p) throw new NotFoundError(`program ${programId}`);
  const rows = await ctx.tx.select({ f: programReviewFinding, by: appUser.fullName }).from(programReviewFinding).leftJoin(appUser, eq(appUser.id, programReviewFinding.createdBy))
    .where(eq(programReviewFinding.programId, programId)).orderBy(desc(programReviewFinding.createdAt), desc(programReviewFinding.pass));
  return { rubric: await getReviewRubric(ctx), findings: rows.map((r) => toFinding(r.f, r.by)) };
}

/** The latest level per program and criterion, for every program the person can see (the heatmap). */
export async function getReviewSummary(ctx: Ctx): Promise<ReviewSummary> {
  await assertPermitted(ctx, 'program:read', { type: 'any' });
  const programs = await ctx.tx.select({ id: program.id, name: program.nameEn, active: program.active, school: orgUnit.nameEn }).from(program)
    .leftJoin(orgUnit, eq(orgUnit.id, program.orgUnitId)).orderBy(asc(orgUnit.nameEn), asc(program.nameEn));
  const rows = await ctx.tx.select().from(programReviewFinding).orderBy(asc(programReviewFinding.createdAt), asc(programReviewFinding.pass));
  const latest = new Map<string, Row>();
  for (const r of rows) latest.set(`${r.programId}|${r.criterionNo}`, r);
  return {
    rubric: await getReviewRubric(ctx),
    programs: programs.filter((p) => p.active).map((p) => {
      const mine = [...latest.values()].filter((r) => r.programId === p.id);
      return {
        programId: p.id, name: p.name, school: p.school, levels: Object.fromEntries(mine.map((r) => [String(r.criterionNo), r.level])),
        lastAudit: mine.map((r) => r.auditDate).sort().at(-1) ?? null,
      };
    }),
  };
}

/** Adds a finding (a new judgement; earlier ones stay). */
export async function addReviewFinding(ctx: Ctx, programId: string, input: AddReviewFinding & { source?: string | null }, opts: { rubric?: ReviewRubric } = {}): Promise<ReviewFinding> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'program:write', { type: 'program', id: programId });
  const rubric = opts.rubric ?? await getReviewRubric(ctx);
  if (!rubric.criteria.some((c) => c.no === input.criterionNo)) throw new ValidationError(`the rubric has no criterion ${input.criterionNo}`);
  const level = resolveReviewLevel(rubric, input.level);
  if (!level) throw new ValidationError(`"${input.level}" is not one of the rubric's levels`);
  const t = (s: string | null | undefined) => (s ? s.normalize('NFC').trim() || null : null);
  const [row] = await ctx.tx.insert(programReviewFinding).values({
    institutionId: ctx.caller.institutionId, programId, criterionNo: input.criterionNo, level, finding: input.finding.normalize('NFC').trim(),
    evidence: t(input.evidence), gaps: t(input.gaps), auditDate: input.auditDate ?? today(), pass: input.pass ?? 1, basis: t(input.basis), source: t(input.source),
  }).returning();
  return toFinding(row!, null);
}

/** A finding row is the same as one recorded when program, criterion, pass, level and wording agree. */
export const findingKey = (programId: string, f: { criterionNo: number; pass?: number | undefined; level: string; finding: string }) =>
  `${programId}|${f.criterionNo}|${f.pass ?? 1}|${f.level}|${fold(f.finding)}`;
