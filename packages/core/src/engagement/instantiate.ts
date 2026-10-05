import { eq } from 'drizzle-orm';
import { engagement, engagementRequirement, program, requirement } from '@ams/db';
import type { AppliesWhen, Subject } from './applicability.js';
import { applicabilityByRequirement } from './applicability.js';
import type { Ctx } from '../ctx.js';
import { NotFoundError } from '../ctx.js';

type EngagementRow = typeof engagement.$inferSelect;

/** The subject an engagement's requirements are matched against. */
export async function subjectOf(ctx: Ctx, e: Pick<EngagementRow, 'subjectType' | 'subjectId' | 'kind'>): Promise<Subject> {
  if (e.subjectType === 'institution') return { scope: 'institution', engagementKind: e.kind };
  const [p] = await ctx.tx.select().from(program).where(eq(program.id, e.subjectId));
  if (!p) throw new NotFoundError(`program ${e.subjectId}`);
  return { scope: 'program', degreeLevel: p.degreeLevel, programTags: p.tags, engagementKind: e.kind };
}

/**
 * Creates one `engagement_requirement` per assessable requirement of the engagement's framework version (PRD 8.3).
 * Those that do not match the subject are created with `applicable = false`, so they stay visible and a lead can
 * switch them on with a reason. Runs inside the caller's transaction; the caller has already authorised the creation.
 */
export async function instantiateRequirements(ctx: Ctx, e: EngagementRow): Promise<{ applicable: number; notApplicable: number }> {
  const all = await ctx.tx.select().from(requirement).where(eq(requirement.frameworkVersionId, e.frameworkVersionId));
  const subject = await subjectOf(ctx, e);
  const applies = applicabilityByRequirement(
    all.map((r) => ({ id: r.id, parentId: r.parentId, appliesWhen: (r.appliesWhen ?? undefined) as AppliesWhen | undefined })),
    subject);
  const rows = all.filter((r) => r.isAssessable).map((r) => ({
    institutionId: e.institutionId,
    engagementId: e.id,
    requirementId: r.id,
    applicable: applies.get(r.id) ?? true,
  }));
  for (let i = 0; i < rows.length; i += 500) await ctx.tx.insert(engagementRequirement).values(rows.slice(i, i + 500));
  const applicable = rows.filter((r) => r.applicable).length;
  return { applicable, notApplicable: rows.length - applicable };
}
