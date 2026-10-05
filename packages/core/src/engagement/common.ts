import { eq } from 'drizzle-orm';
import { engagement, frameworkVersion, milestone } from '@ams/db';
import { LifecycleTemplateSchema, type LifecycleTemplate, type Milestone } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError } from '../ctx.js';
import { isOverdue } from './dates.js';

export type EngagementRow = typeof engagement.$inferSelect;
export type MilestoneRow = typeof milestone.$inferSelect;

export const todayIso = () => new Date().toISOString().slice(0, 10);

export async function getEngagementRow(ctx: Ctx, id: string): Promise<EngagementRow> {
  const [row] = await ctx.tx.select().from(engagement).where(eq(engagement.id, id));
  if (!row) throw new NotFoundError(`engagement ${id}`);
  return row;
}

/** Roadmap, member and requirement changes only make sense while the engagement is running. */
export async function getActiveEngagementRow(ctx: Ctx, id: string): Promise<EngagementRow> {
  const row = await getEngagementRow(ctx, id);
  if (row.status !== 'active') throw new ConflictError(`the engagement is ${row.status}`);
  return row;
}

/** The lifecycle of the framework version the engagement was built on. Published versions never change. */
export async function loadLifecycle(ctx: Ctx, versionId: string): Promise<LifecycleTemplate> {
  const [v] = await ctx.tx.select({ lifecycle: frameworkVersion.lifecycleTemplate }).from(frameworkVersion).where(eq(frameworkVersion.id, versionId));
  const parsed = LifecycleTemplateSchema.safeParse(v?.lifecycle);
  if (!parsed.success) throw new ConflictError('the framework version has no valid lifecycle');
  return parsed.data;
}

export const toMilestone = (m: MilestoneRow, today = todayIso()): Milestone => ({
  id: m.id, engagementId: m.engagementId, templateKey: m.templateKey, phase: m.phase, name: m.name, description: m.description, type: m.type,
  dueDate: m.dueDate, dueRule: m.dueRule ?? null, dateNeeded: m.dateNeeded, overdue: isOverdue(m.dueDate, m.status, today),
  ownerId: m.ownerId, status: m.status, completedAt: m.completedAt?.toISOString() ?? null,
  deliverable: m.deliverable ?? null, sourceRef: m.sourceRef ?? null, recurrence: m.recurrence ?? null,
  displayOrder: m.displayOrder, origin: m.origin, locked: m.locked, required: m.required, skipReason: m.skipReason,
});
