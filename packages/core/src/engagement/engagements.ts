import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  accreditor, appUser, engagement, engagementRequirement, framework, frameworkVersion, institution, milestone, program, reportTemplate,
  roleAssignment,
} from '@ams/db';
import {
  LifecycleTemplateSchema, type AddMember, type CreateEngagement, type Engagement, type EngagementDetail, type Handover, type Member,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';
import type { KeyDates } from './dates.js';
import { firstPhase, generateMilestones } from './generate.js';
import { getEngagementRow, loadLifecycle, toMilestone, todayIso } from './common.js';
import { canAdvance, phaseSummary } from './roadmap.js';
import { instantiateRequirements } from './instantiate.js';

type EngagementRow = typeof engagement.$inferSelect;

/** Drops null and undefined key dates: an unset date and a missing one are the same thing. */
export const cleanKeyDates = (k: Record<string, string | null | undefined> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(k ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));

export async function toEngagements(ctx: Ctx, rows: EngagementRow[]): Promise<Engagement[]> {
  if (rows.length === 0) return [];
  const versionIds = [...new Set(rows.map((r) => r.frameworkVersionId))];
  const versions = await ctx.tx.select({ v: frameworkVersion, f: framework, a: accreditor })
    .from(frameworkVersion).innerJoin(framework, eq(framework.id, frameworkVersion.frameworkId)).innerJoin(accreditor, eq(accreditor.id, framework.accreditorId))
    .where(inArray(frameworkVersion.id, versionIds));
  const byVersion = new Map(versions.map((x) => [x.v.id, x]));
  const programIds = rows.filter((r) => r.subjectType === 'program').map((r) => r.subjectId);
  const programs = programIds.length ? await ctx.tx.select({ id: program.id, name: program.nameEn }).from(program).where(inArray(program.id, programIds)) : [];
  const programName = new Map(programs.map((p) => [p.id, p.name]));
  const [inst] = await ctx.tx.select({ name: institution.nameEn }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  const users = await ctx.tx.select({ id: appUser.id, name: appUser.fullName }).from(appUser).where(inArray(appUser.id, [...new Set(rows.map((r) => r.leadUserId))]));
  const userName = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => {
    const v = byVersion.get(r.frameworkVersionId);
    return {
      id: r.id, title: r.title, kind: r.kind, status: r.status, reviewYear: r.reviewYear,
      keyDates: r.keyDates as Record<string, string | null>, currentPhase: r.currentPhase,
      subjectType: r.subjectType, subjectId: r.subjectId,
      subjectName: r.subjectType === 'program' ? programName.get(r.subjectId) ?? '' : inst?.name ?? '',
      frameworkVersionId: r.frameworkVersionId, frameworkName: v?.f.name ?? '', accreditorShortName: v?.a.shortName ?? '', edition: v?.v.edition ?? '',
      leadUserId: r.leadUserId, leadName: userName.get(r.leadUserId) ?? '',
      previousEngagementId: r.previousEngagementId, templateSyncedVersionId: r.templateSyncedVersionId,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** Engagements the caller can see (row-level security decides which), newest review year first. */
export async function listEngagements(ctx: Ctx): Promise<Engagement[]> {
  await assertPermitted(ctx, 'engagement:read', { type: 'any' });
  const rows = await ctx.tx.select().from(engagement).orderBy(desc(engagement.reviewYear), asc(engagement.title));
  return toEngagements(ctx, rows);
}

export async function listMembers(ctx: Ctx, engagementId: string): Promise<Member[]> {
  const rows = await ctx.tx.select({ userId: appUser.id, fullName: appUser.fullName, email: appUser.email, role: roleAssignment.role })
    .from(roleAssignment).innerJoin(appUser, eq(appUser.id, roleAssignment.userId))
    .where(and(eq(roleAssignment.scopeType, 'engagement'), eq(roleAssignment.scopeId, engagementId)))
    .orderBy(asc(appUser.fullName));
  const rank = (r: string) => (r === 'engagement_lead' ? 0 : r === 'co_lead' ? 1 : 2);
  return rows.map((r) => ({ ...r, role: r.role as Member['role'] })).sort((a, b) => rank(a.role) - rank(b.role) || a.fullName.localeCompare(b.fullName));
}

export async function requirementCounts(ctx: Ctx, engagementId: string): Promise<{ applicable: number; notApplicable: number }> {
  const [c] = await ctx.tx.select({
    applicable: sql<number>`count(*) filter (where ${engagementRequirement.applicable})::int`,
    notApplicable: sql<number>`count(*) filter (where not ${engagementRequirement.applicable})::int`,
  }).from(engagementRequirement).where(eq(engagementRequirement.engagementId, engagementId));
  return { applicable: c?.applicable ?? 0, notApplicable: c?.notApplicable ?? 0 };
}

export async function getEngagement(ctx: Ctx, id: string): Promise<EngagementDetail> {
  await assertPermitted(ctx, 'engagement:read', { type: 'any' });
  const row = await getEngagementRow(ctx, id);
  const [eng] = await toEngagements(ctx, [row]);
  const ms = await ctx.tx.select().from(milestone).where(eq(milestone.engagementId, id)).orderBy(asc(milestone.displayOrder));
  const today = todayIso();
  const phases = phaseSummary(await loadLifecycle(ctx, row.frameworkVersionId), row.kind, row.currentPhase, ms);
  return { engagement: eng!, phases, canAdvance: row.status === 'active' && canAdvance(phases), members: await listMembers(ctx, id), requirementCounts: await requirementCounts(ctx, id), milestones: ms.map((m) => toMilestone(m, today)) };
}

/**
 * The wizard's one transaction (PRD 8.1): the engagement, its lead, its requirements and its milestones.
 * Not yet done here, because they depend on later milestones: the self-study report (M4) and copying evidence links
 * and carrying forward open feedback from a previous engagement (M3, M5).
 */
export async function createEngagement(ctx: Ctx, input: CreateEngagement) {
  assertHuman(ctx);
  await assertPermitted(ctx, 'engagement:create', input.subjectType === 'program' ? { type: 'program', id: input.subjectId } : { type: 'institution' });

  let subjectName: string;
  if (input.subjectType === 'institution') {
    if (input.subjectId !== ctx.caller.institutionId) throw new ValidationError('an institution engagement must be for your own institution');
    const [i] = await ctx.tx.select({ name: institution.nameEn }).from(institution).where(eq(institution.id, input.subjectId));
    subjectName = i?.name ?? '';
  } else {
    const [p] = await ctx.tx.select({ name: program.nameEn }).from(program).where(eq(program.id, input.subjectId));
    if (!p) throw new NotFoundError(`program ${input.subjectId}`);
    subjectName = p.name;
  }

  const [v] = await ctx.tx.select({ v: frameworkVersion, f: framework, a: accreditor })
    .from(frameworkVersion).innerJoin(framework, eq(framework.id, frameworkVersion.frameworkId)).innerJoin(accreditor, eq(accreditor.id, framework.accreditorId))
    .where(eq(frameworkVersion.id, input.frameworkVersionId));
  if (!v) throw new NotFoundError(`framework version ${input.frameworkVersionId}`);
  if (v.v.status !== 'published') throw new ConflictError(`framework version is ${v.v.status}; an engagement needs a published version`);
  if (v.f.scope !== 'both' && v.f.scope !== input.subjectType) throw new ValidationError(`this framework is for ${v.f.scope} reviews, not ${input.subjectType} reviews`);

  const parsed = LifecycleTemplateSchema.safeParse(v.v.lifecycleTemplate);
  if (!parsed.success) throw new ConflictError('the framework version has no valid lifecycle');
  const lifecycle = parsed.data;
  const startPhase = firstPhase(lifecycle, input.kind);
  if (!startPhase) throw new ValidationError(`this framework has no phases for ${input.kind} reviews`);

  const [lead] = await ctx.tx.select({ id: appUser.id, active: appUser.active }).from(appUser).where(eq(appUser.id, input.leadUserId));
  if (!lead?.active) throw new ValidationError('the lead must be an active user of this institution');
  if (input.previousEngagementId) await getEngagementRow(ctx, input.previousEngagementId);

  const keyDates = cleanKeyDates(input.keyDates);
  const title = input.title ?? `${v.a.shortName}${v.f.commission ? ` ${v.f.commission}` : ''} ${input.reviewYear} — ${subjectName}`;

  return guardIntegrity(async () => {
    const [row] = await ctx.tx.insert(engagement).values({
      institutionId: ctx.caller.institutionId, frameworkVersionId: v.v.id, subjectType: input.subjectType, subjectId: input.subjectId,
      kind: input.kind, title, reviewYear: input.reviewYear, keyDates, currentPhase: startPhase, leadUserId: input.leadUserId,
      previousEngagementId: input.previousEngagementId ?? null, templateSyncedVersionId: v.v.id,
    }).returning();
    await ctx.tx.insert(roleAssignment).values({
      institutionId: ctx.caller.institutionId, userId: input.leadUserId, role: 'engagement_lead', scopeType: 'engagement', scopeId: row!.id,
    });

    const requirements = await instantiateRequirements(ctx, row!);

    const templates = await ctx.tx.select({ key: reportTemplate.key, kind: reportTemplate.kind }).from(reportTemplate).where(eq(reportTemplate.frameworkVersionId, v.v.id));
    const generated = generateMilestones({
      lifecycle, kind: input.kind, reviewYear: input.reviewYear, keyDates: keyDates as KeyDates, templateKinds: new Map(templates.map((t) => [t.key, t.kind])),
    });
    if (generated.length) {
      await ctx.tx.insert(milestone).values(generated.map((m) => ({
        institutionId: ctx.caller.institutionId, engagementId: row!.id, templateKey: m.templateKey, phase: m.phase, name: m.name, description: m.description,
        type: m.type, dueDate: m.dueDate, dueRule: m.dueRule, dateNeeded: m.dateNeeded, deliverable: m.deliverable, sourceRef: m.sourceRef,
        recurrence: m.recurrence, displayOrder: m.displayOrder, origin: 'template' as const, locked: m.locked, required: m.required,
      })));
    }
    const [eng] = await toEngagements(ctx, [row!]);
    return { engagement: eng!, requirementCounts: requirements, milestoneCount: generated.length };
  });
}

// ---- Members ------------------------------------------------------------------------------------------------

async function activeEngagement(ctx: Ctx, id: string) {
  const row = await getEngagementRow(ctx, id);
  if (row.status !== 'active') throw new ConflictError(`the engagement is ${row.status}`);
  return row;
}
async function activeUser(ctx: Ctx, userId: string) {
  const [u] = await ctx.tx.select({ id: appUser.id, active: appUser.active }).from(appUser).where(eq(appUser.id, userId));
  if (!u?.active) throw new ValidationError('that person is not an active user of this institution');
}

export async function addMember(ctx: Ctx, engagementId: string, input: AddMember): Promise<Member[]> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'engagement:manage', { type: 'engagement', id: engagementId });
  await activeEngagement(ctx, engagementId);
  await activeUser(ctx, input.userId);
  await guardIntegrity(async () => {
    const [existing] = await ctx.tx.select({ role: roleAssignment.role }).from(roleAssignment)
      .where(and(eq(roleAssignment.scopeType, 'engagement'), eq(roleAssignment.scopeId, engagementId), eq(roleAssignment.userId, input.userId)));
    if (existing) throw new ConflictError(`that person is already ${existing.role === 'engagement_lead' ? 'the lead' : `a ${existing.role}`} of this engagement; change their role instead`);
    await ctx.tx.insert(roleAssignment).values({ institutionId: ctx.caller.institutionId, userId: input.userId, role: input.role, scopeType: 'engagement', scopeId: engagementId });
  });
  return listMembers(ctx, engagementId);
}

export async function changeMemberRole(ctx: Ctx, engagementId: string, userId: string, role: AddMember['role']): Promise<Member[]> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'engagement:manage', { type: 'engagement', id: engagementId });
  const row = await activeEngagement(ctx, engagementId);
  if (row.leadUserId === userId) throw new ConflictError('the lead\'s role changes only by handing the lead over');
  const updated = await ctx.tx.update(roleAssignment).set({ role })
    .where(and(eq(roleAssignment.scopeType, 'engagement'), eq(roleAssignment.scopeId, engagementId), eq(roleAssignment.userId, userId))).returning({ id: roleAssignment.id });
  if (updated.length === 0) throw new NotFoundError('that person is not a member of this engagement');
  return listMembers(ctx, engagementId);
}

export async function removeMember(ctx: Ctx, engagementId: string, userId: string): Promise<Member[]> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'engagement:manage', { type: 'engagement', id: engagementId });
  const row = await activeEngagement(ctx, engagementId);
  if (row.leadUserId === userId) throw new ConflictError('the lead cannot be removed; hand the lead role over first');
  const removed = await ctx.tx.delete(roleAssignment)
    .where(and(eq(roleAssignment.scopeType, 'engagement'), eq(roleAssignment.scopeId, engagementId), eq(roleAssignment.userId, userId))).returning({ id: roleAssignment.id });
  if (removed.length === 0) throw new NotFoundError('that person is not a member of this engagement');
  return listMembers(ctx, engagementId);
}

/**
 * Hands the lead role to another person (PRD 4): only an admin or the current lead. The new lead may already be a
 * member. The outgoing lead becomes a member with `outgoingRole`, or leaves when it is null. The database requires
 * exactly one lead at commit, so the order inside the transaction does not matter to it.
 */
export async function handoverLead(ctx: Ctx, engagementId: string, input: Handover): Promise<Member[]> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'engagement:lead', { type: 'engagement', id: engagementId });
  const row = await activeEngagement(ctx, engagementId);
  if (row.leadUserId === input.newLeadUserId) throw new ConflictError('that person is already the lead');
  await activeUser(ctx, input.newLeadUserId);
  const member = (userId: string) => and(eq(roleAssignment.scopeType, 'engagement'), eq(roleAssignment.scopeId, engagementId), eq(roleAssignment.userId, userId));
  await guardIntegrity(async () => {
    // The new lead is added first: after this statement the caller may no longer hold the lead role in the database.
    await ctx.tx.delete(roleAssignment).where(member(input.newLeadUserId));
    await ctx.tx.insert(roleAssignment).values({ institutionId: ctx.caller.institutionId, userId: input.newLeadUserId, role: 'engagement_lead', scopeType: 'engagement', scopeId: engagementId });
    await ctx.tx.update(engagement).set({ leadUserId: input.newLeadUserId }).where(eq(engagement.id, engagementId));
    if (input.outgoingRole) await ctx.tx.update(roleAssignment).set({ role: input.outgoingRole }).where(member(row.leadUserId));
    else await ctx.tx.delete(roleAssignment).where(member(row.leadUserId));
  });
  return listMembers(ctx, engagementId);
}
