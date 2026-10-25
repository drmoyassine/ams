// Shared loading and permission checks of the report services (TASK-091). Reports follow the cycles' shape: the route's
// coarse gate is report:read / report:write / report:manage, and the service checks report:manage against the report's
// wrapper — the engagement it belongs to, or the subject it is about.
import { eq } from 'drizzle-orm';
import { engagement, institution, orgUnit, program, report, reportSection } from '@ams/db';
import type { Scope } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { NotFoundError } from '../ctx.js';
import { assertPermitted } from '../permissions.js';

export type ReportRow = typeof report.$inferSelect;
export type Report = ReportRow;

export async function loadReport(ctx: Ctx, id: string): Promise<Report> {
  const [row] = await ctx.tx.select().from(report).where(eq(report.id, id));
  if (!row || row.institutionId !== ctx.caller.institutionId) throw new NotFoundError(`report ${id}`);
  return row;
}

export async function loadSection(ctx: Ctx, sectionId: string) {
  const [row] = await ctx.tx.select().from(reportSection).where(eq(reportSection.id, sectionId));
  if (!row || row.institutionId !== ctx.caller.institutionId) throw new NotFoundError(`report section ${sectionId}`);
  return row;
}

/** The wrapper scope a report is governed through. */
export function scopeOf(r: Pick<Report, 'engagementId' | 'subjectKind' | 'subjectId'>): Scope {
  if (r.engagementId) return { type: 'engagement', id: r.engagementId };
  if (r.subjectKind === 'program' && r.subjectId) return { type: 'program', id: r.subjectId };
  if (r.subjectKind === 'org_unit' && r.subjectId) return { type: 'org_unit', id: r.subjectId };
  return { type: 'institution' };
}

/** Throws unless the caller holds report:manage for the report's wrapper. */
export async function assertManage(ctx: Ctx, r: Pick<Report, 'engagementId' | 'subjectKind' | 'subjectId'>): Promise<void> {
  await assertPermitted(ctx, 'report:manage', scopeOf(r));
}

/** The display name of what a report is about (the list and the detail header). */
export async function subjectName(ctx: Ctx, kind: string | null, id: string | null): Promise<string | null> {
  if (!kind || !id) return null;
  if (kind === 'program') {
    const [row] = await ctx.tx.select({ name: program.nameEn }).from(program).where(eq(program.id, id));
    return row?.name ?? null;
  }
  if (kind === 'org_unit') {
    const [row] = await ctx.tx.select({ name: orgUnit.nameEn }).from(orgUnit).where(eq(orgUnit.id, id));
    return row?.name ?? null;
  }
  if (kind === 'institution') {
    const [row] = await ctx.tx.select({ name: institution.nameEn }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
    return row?.name ?? null;
  }
  const [row] = await ctx.tx.select({ name: engagement.title }).from(engagement).where(eq(engagement.id, id));
  return row?.name ?? null;
}
