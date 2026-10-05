// "Template updated — review changes" (PRD 8.5). Running engagements are never changed when a newer framework
// version is published. The lead sees what changed in the lifecycle and accepts or ignores each change; milestones
// they modified or added are never overwritten. `template_synced_version_id` records the version last reviewed.
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { engagement, frameworkVersion, milestone, reportTemplate } from '@ams/db';
import { LifecycleTemplateSchema, type ApplyTemplateUpdate, type TemplateChange, type TemplateUpdate } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { getActiveEngagementRow, getEngagementRow, lifecycleVersionId, type EngagementRow, type MilestoneRow } from './common.js';
import { resolveDueRule, type KeyDates } from './dates.js';
import { generateMilestones, type GeneratedMilestone } from './generate.js';

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function newerPublishedVersion(ctx: Ctx, e: EngagementRow) {
  const syncedId = lifecycleVersionId(e);
  const [synced] = await ctx.tx.select().from(frameworkVersion).where(eq(frameworkVersion.id, syncedId));
  if (!synced) throw new NotFoundError(`framework version ${syncedId}`);
  const [newer] = await ctx.tx.select().from(frameworkVersion)
    .where(and(eq(frameworkVersion.frameworkId, synced.frameworkId), eq(frameworkVersion.status, 'published'), gt(frameworkVersion.publishedAt, synced.publishedAt!)))
    .orderBy(desc(frameworkVersion.publishedAt)).limit(1);
  return { synced, newer: newer ?? null };
}

async function generatedFor(ctx: Ctx, e: EngagementRow, versionId: string): Promise<GeneratedMilestone[]> {
  const [v] = await ctx.tx.select().from(frameworkVersion).where(eq(frameworkVersion.id, versionId));
  const lifecycle = LifecycleTemplateSchema.safeParse(v?.lifecycleTemplate);
  if (!lifecycle.success) throw new ConflictError('the newer framework version has no valid lifecycle');
  const templates = await ctx.tx.select({ key: reportTemplate.key, kind: reportTemplate.kind }).from(reportTemplate).where(eq(reportTemplate.frameworkVersionId, versionId));
  return generateMilestones({ lifecycle: lifecycle.data, kind: e.kind, reviewYear: e.reviewYear, keyDates: e.keyDates as KeyDates, templateKinds: new Map(templates.map((t) => [t.key, t.kind])) });
}

const summary = (m: Pick<GeneratedMilestone, 'name' | 'description' | 'type' | 'phase' | 'required' | 'deliverable'> & { dueRule: unknown; dueDate: string | null }) => ({
  name: m.name, description: m.description, type: m.type, phase: m.phase, required: m.required, deliverable: m.deliverable, dueRule: m.dueRule ?? null, dueDate: m.dueDate,
});

/** What changed between the engagement's milestones (from the version last reviewed) and the newer version's lifecycle. */
export async function getTemplateUpdate(ctx: Ctx, engagementId: string): Promise<TemplateUpdate> {
  await assertPermitted(ctx, 'engagement:read', { type: 'any' });
  const e = await getEngagementRow(ctx, engagementId);
  const { synced, newer } = await newerPublishedVersion(ctx, e);
  const from = { id: synced.id, edition: synced.edition };
  if (!newer || e.status !== 'active') return { available: false, fromVersion: from, toVersion: null, changes: [] };

  const next = new Map((await generatedFor(ctx, e, newer.id)).map((m) => [m.templateKey, m]));
  const mine = await ctx.tx.select().from(milestone).where(eq(milestone.engagementId, engagementId));
  const have = new Map(mine.filter((m) => m.templateKey && (m.origin === 'template' || m.origin === 'modified')).map((m) => [m.templateKey!, m]));
  const changes: TemplateChange[] = [];
  const push = (kind: TemplateChange['kind'], key: string, name: string, phase: TemplateChange['phase'], protectedByEdit: boolean, blocked: string | null, before: unknown, after: unknown) =>
    changes.push({ id: `${kind}:${key}`, kind, templateKey: key, name, phase, protectedByEdit, blocked, before: (before as Record<string, unknown>) ?? null, after: (after as Record<string, unknown>) ?? null });

  for (const [key, n] of next) {
    const m = have.get(key);
    if (!m) { push('added', key, n.name, n.phase, false, null, null, summary(n)); continue; }
    const edited = m.origin === 'modified';
    if (!same(m.dueRule, n.dueRule)) push('redated', key, n.name, n.phase, edited, null, summary({ ...m, dueRule: m.dueRule, deliverable: m.deliverable as GeneratedMilestone['deliverable'] }), summary(n));
    if (m.name !== n.name || (m.description ?? null) !== n.description || m.type !== n.type || m.phase !== n.phase || m.required !== n.required || !same(m.deliverable, n.deliverable)) {
      push('changed', key, n.name, n.phase, edited, null, summary({ ...m, deliverable: m.deliverable as GeneratedMilestone['deliverable'] }), summary(n));
    }
  }
  for (const [key, m] of have) {
    if (next.has(key)) continue;
    push('removed', key, m.name, m.phase, m.origin === 'modified', m.locked ? `"${m.name}" is locked and stays` : null, summary({ ...m, deliverable: m.deliverable as GeneratedMilestone['deliverable'] }), null);
  }
  return { available: true, fromVersion: from, toVersion: { id: newer.id, edition: newer.edition }, changes };
}

async function applyOne(ctx: Ctx, e: EngagementRow, c: TemplateChange, row: MilestoneRow | undefined, target: GeneratedMilestone | undefined) {
  if (c.kind === 'added' && target) {
    const [{ next }] = await ctx.tx.select({ next: sql<number>`coalesce(max(${milestone.displayOrder}), -1) + 1` }).from(milestone).where(and(eq(milestone.engagementId, e.id), eq(milestone.phase, target.phase))) as [{ next: number }];
    await ctx.tx.insert(milestone).values({
      institutionId: e.institutionId, engagementId: e.id, templateKey: target.templateKey, phase: target.phase, name: target.name, description: target.description,
      type: target.type, dueDate: target.dueDate, dueRule: target.dueRule, dateNeeded: target.dateNeeded, deliverable: target.deliverable, sourceRef: target.sourceRef,
      recurrence: target.recurrence, displayOrder: next, origin: 'template', locked: target.locked, required: target.required,
    });
    return;
  }
  if (!row) return;
  if (c.kind === 'removed') { await ctx.tx.delete(milestone).where(eq(milestone.id, row.id)); return; }
  if (!target) return;
  if (c.kind === 'redated') {
    const { dueDate, dateNeeded } = resolveDueRule(target.dueRule as Parameters<typeof resolveDueRule>[0], { reviewYear: e.reviewYear, keyDates: e.keyDates as KeyDates });
    await ctx.tx.update(milestone).set({ dueRule: target.dueRule, dueDate, dateNeeded }).where(eq(milestone.id, row.id));
  } else {
    await ctx.tx.update(milestone).set({ name: target.name, description: target.description, type: target.type, required: target.required, deliverable: target.deliverable, ...(row.phase !== target.phase ? { phase: target.phase } : {}) }).where(eq(milestone.id, row.id));
  }
}

/**
 * Applies the lead's decisions, one per change, then records the newer version as reviewed. Changes to milestones the
 * lead modified, and changes that cannot apply (a locked milestone), are not applied, whatever the decision. Returns
 * what was applied and what was left alone.
 */
export async function applyTemplateUpdate(ctx: Ctx, engagementId: string, input: ApplyTemplateUpdate) {
  assertHuman(ctx);
  await assertPermitted(ctx, 'engagement:manage', { type: 'engagement', id: engagementId });
  const e = await getActiveEngagementRow(ctx, engagementId);
  const update = await getTemplateUpdate(ctx, engagementId);
  if (!update.available || update.toVersion?.id !== input.toVersionId) throw new ConflictError('that is not the newer version to review; reload the roadmap');
  const missing = update.changes.filter((c) => !input.decisions[c.id]);
  if (missing.length) throw new ValidationError(`decide every change (accept or ignore): ${missing.map((c) => c.id).join(', ')}`);
  const unknown = Object.keys(input.decisions).filter((id) => !update.changes.some((c) => c.id === id));
  if (unknown.length) throw new ValidationError(`unknown change(s): ${unknown.join(', ')}`);

  const target = new Map((await generatedFor(ctx, e, input.toVersionId)).map((m) => [m.templateKey, m]));
  const mine = await ctx.tx.select().from(milestone).where(eq(milestone.engagementId, engagementId));
  const rows = new Map(mine.filter((m) => m.templateKey).map((m) => [m.templateKey!, m]));
  const applied: string[] = [];
  const left: { id: string; reason: string }[] = [];
  await guardIntegrity(async () => {
    for (const c of update.changes) {
      if (input.decisions[c.id] === 'ignore') { left.push({ id: c.id, reason: 'ignored' }); continue; }
      if (c.protectedByEdit) { left.push({ id: c.id, reason: 'you changed this milestone, so it is not overwritten' }); continue; }
      if (c.blocked) { left.push({ id: c.id, reason: c.blocked }); continue; }
      await applyOne(ctx, e, c, rows.get(c.templateKey), target.get(c.templateKey));
      applied.push(c.id);
    }
    await ctx.tx.update(engagement).set({ templateSyncedVersionId: input.toVersionId }).where(eq(engagement.id, engagementId));
  });
  return { applied, left, syncedVersionId: input.toVersionId };
}
