// Reading reports (TASK-091): the list with its counts, and the detail with the section tree, the resolved requirements
// and the owners. The generated blocks render at read time later (TASK-093); the sections carry what people wrote.
import { and, asc, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { appUser, report, reportSection, reportSectionRequirement, requirement } from '@ams/db';
import type { ReportDetail, ReportFilter, ReportSection, ReportSummary } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { loadReport, subjectName, type Report } from './common.js';

const summaries = async (ctx: Ctx, rows: Report[]): Promise<ReportSummary[]> => {
  const ids = rows.map((r) => r.id);
  const counts = ids.length ? await ctx.tx.select({
    reportId: reportSection.reportId,
    total: sql<number>`count(*)::int`,
    approved: sql<number>`count(*) filter (where ${reportSection.status} = 'approved')::int`,
  }).from(reportSection).where(inArray(reportSection.reportId, ids)).groupBy(reportSection.reportId) : [];
  const byReport = new Map(counts.map((c) => [c.reportId, c]));
  const subjects = new Map<string, string | null>();
  for (const r of rows) {
    if (r.subjectKind && r.subjectId && !subjects.has(`${r.subjectKind}:${r.subjectId}`)) {
      subjects.set(`${r.subjectKind}:${r.subjectId}`, await subjectName(ctx, r.subjectKind, r.subjectId));
    }
  }
  return rows.map((r) => {
    const c = byReport.get(r.id);
    return {
      id: r.id, title: r.title, status: r.status, round: r.round, kind: r.kind, language: r.language,
      frameworkVersionId: r.frameworkVersionId, templateKey: r.templateKey, templateName: r.templateName,
      engagementId: r.engagementId, subjectKind: r.subjectKind, subjectId: r.subjectId,
      subjectName: r.subjectKind && r.subjectId ? subjects.get(`${r.subjectKind}:${r.subjectId}`) ?? null : null,
      requiresAttestation: r.requiresAttestation, wordLimit: r.wordLimit,
      sectionCount: c?.total ?? 0, approvedSections: c?.approved ?? 0,
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    };
  });
};

export async function listReports(ctx: Ctx, filter: ReportFilter = {}): Promise<ReportSummary[]> {
  const where = [eq(report.institutionId, ctx.caller.institutionId)];
  if (filter.engagementId) where.push(eq(report.engagementId, filter.engagementId));
  if (filter.subjectKind) where.push(eq(report.subjectKind, filter.subjectKind));
  if (filter.subjectId) where.push(sql`${report.subjectId} = ${filter.subjectId}::uuid`);
  if (filter.frameworkVersionId) where.push(eq(report.frameworkVersionId, filter.frameworkVersionId));
  if (filter.status) where.push(eq(report.status, filter.status));
  if (filter.q) where.push(ilike(report.title, `%${filter.q}%`));
  const rows = await ctx.tx.select().from(report).where(and(...where)).orderBy(desc(report.updatedAt)).limit(200);
  return summaries(ctx, rows);
}

/** Flattened sections of a report with their resolved requirements and owner names. */
export async function loadSections(ctx: Ctx, reportId: string) {
  const rows = await ctx.tx.select().from(reportSection).where(eq(reportSection.reportId, reportId)).orderBy(asc(reportSection.displayOrder));
  const ids = rows.map((r) => r.id);
  const links = ids.length ? await ctx.tx.select({
    sectionId: reportSectionRequirement.sectionId, requirementId: reportSectionRequirement.requirementId,
    code: reportSectionRequirement.code, title: requirement.title, displayOrder: reportSectionRequirement.displayOrder,
  }).from(reportSectionRequirement).innerJoin(requirement, eq(requirement.id, reportSectionRequirement.requirementId))
    .where(inArray(reportSectionRequirement.sectionId, ids)) : [];
  const ownerIds = [...new Set(rows.map((r) => r.ownerId).filter((v): v is string => typeof v === 'string'))];
  const owners = ownerIds.length ? await ctx.tx.select({ id: appUser.id, name: appUser.fullName }).from(appUser).where(inArray(appUser.id, ownerIds)) : [];
  const names = new Map(owners.map((o) => [o.id, o.name]));
  const linksOf = new Map<string, { requirementId: string; code: string; title: string }[]>();
  for (const l of links.sort((a, b) => a.displayOrder - b.displayOrder)) {
    linksOf.set(l.sectionId, [...(linksOf.get(l.sectionId) ?? []), { requirementId: l.requirementId, code: l.code, title: l.title }]);
  }
  return rows.map((r) => ({
    id: r.id, key: r.key, parentId: r.parentId, title: r.title, blockType: r.blockType, displayOrder: r.displayOrder,
    prompt: r.prompt, requirements: linksOf.get(r.id) ?? [],
    ownerId: r.ownerId, ownerName: r.ownerId ? names.get(r.ownerId) ?? null : null, ownerUnresolved: r.ownerUnresolved,
    status: r.status, wordLimit: r.wordLimit, wordCount: r.wordCount, content: r.content,
  }));
}

export async function getReport(ctx: Ctx, id: string): Promise<ReportDetail> {
  const row = await loadReport(ctx, id);
  const flat = await loadSections(ctx, id);
  const byParent = new Map<string | null, typeof flat>();
  for (const s of flat) {
    const list = byParent.get(s.parentId) ?? [];
    list.push(s as ReportSection);
    byParent.set(s.parentId, list);
  }
  const tree = (parent: string | null): ReportSection[] => (byParent.get(parent) ?? []).map((s) => ({ ...s, children: tree(s.id) }));
  const [summary] = await summaries(ctx, [row]);
  return { ...summary!, sections: tree(null), wordCount: flat.reduce((n, s) => n + (s.blockType === 'narrative' ? s.wordCount ?? 0 : 0), 0) };
}
