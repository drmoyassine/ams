// Editing the roadmap at engagement level (PRD 8.5). The framework's lifecycle is the master template; each engagement
// holds its own copy of the milestones. The lead and co-lead edit within these rules; the database enforces the
// hard ones too (locked milestones, skip reasons, template milestones keeping their phase), so a bug here cannot
// break them.
import { and, asc, eq, sql } from 'drizzle-orm';
import { engagement, milestone, reportTemplate } from '@ams/db';
import type { AddMilestone, LifecycleTemplate, Milestone, PhaseSummary, ReorderMilestones, UpdateEngagement, UpdateMilestone } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { getActiveEngagementRow, lifecycleVersionId, loadLifecycle, toMilestone, type EngagementRow, type MilestoneRow } from './common.js';
import { resolveDueRule, type IsoDate, type KeyDates } from './dates.js';

const manage = (ctx: Ctx, engagementId: string) => assertPermitted(ctx, 'engagement:manage', { type: 'engagement', id: engagementId });

/** The phases an engagement of this kind goes through, in template order, one entry per type. */
export function phasesFor(lifecycle: LifecycleTemplate, kind: EngagementRow['kind']) {
  const seen = new Set<string>();
  return lifecycle.phases.filter((p) => p.applies_to.includes(kind) && !seen.has(p.type) && !!seen.add(p.type));
}

/** Progress per phase: completed required milestones over required milestones (PRD 8.2). */
export function phaseSummary(lifecycle: LifecycleTemplate, kind: EngagementRow['kind'], current: string | null, ms: readonly Pick<MilestoneRow, 'phase' | 'required' | 'status'>[]): PhaseSummary[] {
  return phasesFor(lifecycle, kind).map((p) => {
    const here = ms.filter((m) => m.phase === p.type);
    const required = here.filter((m) => m.required);
    return {
      type: p.type, name: p.name, milestoneCount: here.length, requiredTotal: required.length,
      requiredDone: required.filter((m) => m.status === 'done' || m.status === 'skipped').length, current: p.type === current,
    };
  });
}

export const canAdvance = (summaries: readonly PhaseSummary[]): boolean => {
  const i = summaries.findIndex((s) => s.current);
  const cur = summaries[i];
  return !!cur && i < summaries.length - 1 && cur.requiredDone === cur.requiredTotal;
};

/**
 * Recomputes due dates after a key date, the review year or a completion changed. Template milestones follow their rule;
 * a modified milestone keeps the date a person set, and only gets one from its rule while it has none; local
 * milestones have no rule. Returns how many changed.
 */
export async function refreshDueDates(ctx: Ctx, e: EngagementRow): Promise<number> {
  const rows = await ctx.tx.select().from(milestone).where(eq(milestone.engagementId, e.id));
  const completed = new Map<string, IsoDate>();
  for (const m of rows) if (m.status === 'done' && m.templateKey && m.completedAt) completed.set(m.templateKey, m.completedAt.toISOString().slice(0, 10));
  let changed = 0;
  for (const m of rows) {
    if (!m.dueRule || m.origin === 'local' || (m.origin === 'modified' && m.dueDate !== null)) continue;
    const { dueDate, dateNeeded } = resolveDueRule(m.dueRule as Parameters<typeof resolveDueRule>[0], {
      reviewYear: e.reviewYear, keyDates: e.keyDates as KeyDates, completedOn: (k) => completed.get(k) ?? null,
    });
    if (dueDate === m.dueDate && dateNeeded === m.dateNeeded) continue;
    await ctx.tx.update(milestone).set({ dueDate, dateNeeded }).where(eq(milestone.id, m.id));
    changed += 1;
  }
  return changed;
}

/** Key dates, review year and title; the dates they feed are recomputed. */
export async function updateEngagement(ctx: Ctx, engagementId: string, patch: UpdateEngagement) {
  assertHuman(ctx);
  await manage(ctx, engagementId);
  const row = await getActiveEngagementRow(ctx, engagementId);
  const keyDates = { ...(row.keyDates as Record<string, string>) };
  for (const [k, v] of Object.entries(patch.keyDates ?? {})) { if (typeof v === 'string') keyDates[k] = v; else delete keyDates[k]; }
  const [updated] = await ctx.tx.update(engagement).set({
    keyDates, ...(patch.title ? { title: patch.title } : {}), ...(patch.reviewYear ? { reviewYear: patch.reviewYear } : {}),
  }).where(eq(engagement.id, engagementId)).returning();
  return { engagement: updated!, datesChanged: await refreshDueDates(ctx, updated!) };
}

async function getMilestone(ctx: Ctx, id: string): Promise<MilestoneRow> {
  const [m] = await ctx.tx.select().from(milestone).where(eq(milestone.id, id));
  if (!m) throw new NotFoundError(`milestone ${id}`);
  return m;
}

async function assertKnownTemplate(ctx: Ctx, e: EngagementRow, key: string) {
  const [t] = await ctx.tx.select({ key: reportTemplate.key }).from(reportTemplate).where(and(eq(reportTemplate.frameworkVersionId, lifecycleVersionId(e)), eq(reportTemplate.key, key)));
  if (!t) throw new ValidationError(`the framework has no report template "${key}"`);
}

export async function updateMilestone(ctx: Ctx, milestoneId: string, patch: UpdateMilestone): Promise<Milestone> {
  assertHuman(ctx);
  const m = await getMilestone(ctx, milestoneId);
  await manage(ctx, m.engagementId);
  const e = await getActiveEngagementRow(ctx, m.engagementId);
  const set: Partial<typeof milestone.$inferInsert> = {};

  // Naming, describing, assigning or re-dating a template milestone makes it "modified" (PRD 8.5).
  const edited = patch.name !== undefined || patch.description !== undefined || patch.ownerId !== undefined || patch.dueDate !== undefined;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.ownerId !== undefined) set.ownerId = patch.ownerId;
  if (patch.dueDate !== undefined) { set.dueDate = patch.dueDate; set.dateNeeded = false; }
  if (edited && m.origin === 'template') set.origin = 'modified';

  if (patch.phase !== undefined && patch.phase !== m.phase) {
    if (m.origin !== 'local') throw new ConflictError('only milestones you added can move to another phase');
    const phases = phasesFor(await loadLifecycle(ctx, lifecycleVersionId(e)), e.kind).map((p) => p.type as string);
    if (!phases.includes(patch.phase)) throw new ConflictError('phases cannot be added to an engagement');
    const [{ next }] = await ctx.tx.select({ next: sql<number>`coalesce(max(${milestone.displayOrder}), -1) + 1` }).from(milestone).where(and(eq(milestone.engagementId, e.id), eq(milestone.phase, patch.phase))) as [{ next: number }];
    set.phase = patch.phase; set.displayOrder = next;
  }
  if (patch.deliverableTemplateKey !== undefined) {
    if (m.origin !== 'local') throw new ConflictError('the report a template milestone produces cannot be changed; start a new engagement or a new framework version');
    if (patch.deliverableTemplateKey !== null) await assertKnownTemplate(ctx, e, patch.deliverableTemplateKey);
    set.deliverable = patch.deliverableTemplateKey === null ? null : { report_template_key: patch.deliverableTemplateKey };
  }

  if (patch.status !== undefined && patch.status !== m.status) {
    set.status = patch.status;
    if (patch.status === 'done') set.completedAt = new Date();
    else if (m.status === 'done') set.completedAt = null;
    if (patch.status === 'skipped') {
      const reason = (patch.skipReason ?? m.skipReason ?? '').trim();
      if (m.required && !reason) throw new ValidationError('a required milestone can only be skipped with a reason');
      set.skipReason = reason || null;
    } else {
      set.skipReason = null; // un-skipping is always allowed
    }
  } else if (patch.skipReason !== undefined && m.status === 'skipped') {
    set.skipReason = patch.skipReason?.trim() || (m.required ? m.skipReason : null);
  }

  if (Object.keys(set).length === 0) return toMilestone(m);
  const [row] = await guardIntegrity(() => ctx.tx.update(milestone).set(set).where(eq(milestone.id, milestoneId)).returning());
  // A completion can resolve "N days after <milestone>" dates elsewhere in the roadmap.
  if (patch.status !== undefined) await refreshDueDates(ctx, e);
  return toMilestone(row!);
}

export async function addLocalMilestone(ctx: Ctx, engagementId: string, input: Partial<Pick<AddMilestone, 'type' | 'required'>> & Omit<AddMilestone, 'type' | 'required'>): Promise<Milestone> {
  assertHuman(ctx);
  await manage(ctx, engagementId);
  const e = await getActiveEngagementRow(ctx, engagementId);
  const phases = phasesFor(await loadLifecycle(ctx, lifecycleVersionId(e)), e.kind).map((p) => p.type as string);
  if (!phases.includes(input.phase)) throw new ConflictError('phases cannot be added to an engagement');
  if (input.deliverableTemplateKey) {
    if (input.type !== 'deliverable' && input.type !== 'submission') throw new ValidationError('only a deliverable or submission milestone can produce a report');
    await assertKnownTemplate(ctx, e, input.deliverableTemplateKey);
  }
  const [{ next }] = await ctx.tx.select({ next: sql<number>`coalesce(max(${milestone.displayOrder}), -1) + 1` }).from(milestone).where(and(eq(milestone.engagementId, e.id), eq(milestone.phase, input.phase))) as [{ next: number }];
  const [row] = await ctx.tx.insert(milestone).values({
    institutionId: ctx.caller.institutionId, engagementId, templateKey: null, phase: input.phase, name: input.name, description: input.description ?? null,
    type: input.type ?? 'task', dueDate: input.dueDate ?? null, ownerId: input.ownerId ?? null, required: input.required ?? false, origin: 'local', locked: false, displayOrder: next,
    deliverable: input.deliverableTemplateKey ? { report_template_key: input.deliverableTemplateKey } : null,
  }).returning();
  return toMilestone(row!);
}

/** Only milestones you added can be deleted; template milestones are skipped instead (a locked one cannot even be skipped away). */
export async function deleteMilestone(ctx: Ctx, milestoneId: string): Promise<void> {
  assertHuman(ctx);
  const m = await getMilestone(ctx, milestoneId);
  await manage(ctx, m.engagementId);
  await getActiveEngagementRow(ctx, m.engagementId);
  if (m.locked) throw new ConflictError(`"${m.name}" is locked and cannot be deleted`);
  if (m.origin !== 'local') throw new ConflictError(`"${m.name}" comes from the framework; skip it instead of deleting it`);
  await ctx.tx.delete(milestone).where(eq(milestone.id, milestoneId));
}

/** Reorders the milestones of one phase. The list must be exactly that phase's milestones. */
export async function reorderMilestones(ctx: Ctx, engagementId: string, input: ReorderMilestones): Promise<Milestone[]> {
  assertHuman(ctx);
  await manage(ctx, engagementId);
  await getActiveEngagementRow(ctx, engagementId);
  const rows = await ctx.tx.select().from(milestone).where(and(eq(milestone.engagementId, engagementId), eq(milestone.phase, input.phase))).orderBy(asc(milestone.displayOrder));
  const have = new Set(rows.map((r) => r.id));
  if (input.milestoneIds.length !== have.size || !input.milestoneIds.every((id) => have.has(id)) || new Set(input.milestoneIds).size !== have.size) {
    throw new ValidationError('the list must contain exactly the milestones of that phase, each once');
  }
  for (const [i, id] of input.milestoneIds.entries()) await ctx.tx.update(milestone).set({ displayOrder: i }).where(eq(milestone.id, id));
  const after = await ctx.tx.select().from(milestone).where(and(eq(milestone.engagementId, engagementId), eq(milestone.phase, input.phase))).orderBy(asc(milestone.displayOrder));
  return after.map((m) => toMilestone(m));
}

/** Manual phase advance (PRD 8.2): every required milestone of the current phase is done or skipped. */
export async function advancePhase(ctx: Ctx, engagementId: string) {
  assertHuman(ctx);
  await manage(ctx, engagementId);
  const e = await getActiveEngagementRow(ctx, engagementId);
  const lifecycle = await loadLifecycle(ctx, lifecycleVersionId(e));
  const ms = await ctx.tx.select().from(milestone).where(eq(milestone.engagementId, engagementId));
  const summaries = phaseSummary(lifecycle, e.kind, e.currentPhase, ms);
  const i = summaries.findIndex((s) => s.current);
  if (i < 0) throw new ConflictError('the engagement has no current phase');
  if (i === summaries.length - 1) throw new ConflictError('the engagement is already in its last phase');
  const open = ms.filter((m) => m.phase === e.currentPhase && m.required && m.status !== 'done' && m.status !== 'skipped');
  if (open.length) throw new ConflictError(`${open.length} required milestone(s) in this phase are not done or skipped: ${open.map((m) => m.name).join('; ')}`);
  const next = summaries[i + 1]!.type;
  const [row] = await ctx.tx.update(engagement).set({ currentPhase: next }).where(eq(engagement.id, engagementId)).returning();
  return row!;
}

/** Withdrawing needs a reason and is the lead's alone (it ends the engagement). */
export async function withdrawEngagement(ctx: Ctx, engagementId: string, reason: string) {
  assertHuman(ctx);
  await assertPermitted(ctx, 'engagement:lead', { type: 'engagement', id: engagementId });
  await getActiveEngagementRow(ctx, engagementId);
  const [row] = await guardIntegrity(() => ctx.tx.update(engagement).set({ status: 'withdrawn', withdrawnReason: reason.trim() }).where(eq(engagement.id, engagementId)).returning());
  return row!;
}
