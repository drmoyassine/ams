// The requirement workspace (PRD 8.4): context from the framework, the engagement's work on it, who may do what.
//
// Statuses follow the PRD: a contributor takes a requirement to `ready_for_review`; a reviewer moves it to `approved`
// or `needs_work`. `approved` means "internally ready" and the label is "Internally approved" (DEC-005): nothing here,
// and nothing built on it, may say a requirement is met or compliant.
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { appUser, auditEvent, engagementRequirement, requirement, requirementNote, roleAssignment } from '@ams/db';
import type {
  AssignRequirements, EngagementRequirement, RequirementList, SetApplicability, UpdateRequirementWork, Workspace,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted, isPermitted } from '../permissions.js';
import { getActiveEngagementRow, getEngagementRow } from './common.js';

type Status = EngagementRequirement['status'];
type Row = typeof engagementRequirement.$inferSelect;

/** Who may give a requirement to whom: members of the engagement in a role that does that kind of work. */
const OWNER_ROLES = ['engagement_lead', 'co_lead', 'contributor'];
const REVIEWER_ROLES = ['engagement_lead', 'co_lead', 'reviewer'];

/** The steps that move a requirement forward, and the permission each needs (PRD 8.4). */
const TRANSITIONS: Record<Status, readonly { to: Status; needs: 'work' | 'review' }[]> = {
  not_started: [{ to: 'in_progress', needs: 'work' }],
  in_progress: [{ to: 'ready_for_review', needs: 'work' }, { to: 'not_started', needs: 'work' }],
  ready_for_review: [{ to: 'approved', needs: 'review' }, { to: 'needs_work', needs: 'review' }, { to: 'in_progress', needs: 'work' }],
  needs_work: [{ to: 'in_progress', needs: 'work' }, { to: 'ready_for_review', needs: 'work' }],
  approved: [{ to: 'needs_work', needs: 'review' }],
};

const scope = (engagementId: string) => ({ type: 'engagement', id: engagementId }) as const;

interface Access { manage: boolean; work: boolean; review: boolean }
/** What the caller may do with this requirement: the lead manages all; others only what is assigned to them. */
async function accessFor(ctx: Ctx, row: Row): Promise<Access> {
  const me = ctx.caller.userId;
  const manage = await isPermitted(ctx.tx, 'engagement:manage', scope(row.engagementId));
  const work = manage || (await isPermitted(ctx.tx, 'engagement:work', scope(row.engagementId)) && row.ownerId !== null && row.ownerId === me);
  const review = manage || (await isPermitted(ctx.tx, 'engagement:review', scope(row.engagementId)) && row.reviewerId !== null && row.reviewerId === me);
  return { manage, work, review };
}

export const allowedStatuses = (current: Status, a: Access, applicable: boolean, engagementActive: boolean): Status[] =>
  !applicable || !engagementActive ? [] : TRANSITIONS[current].filter((t) => (t.needs === 'work' ? a.work : a.review)).map((t) => t.to);

async function load(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(engagementRequirement).where(eq(engagementRequirement.id, id));
  if (!row) throw new NotFoundError(`engagement requirement ${id}`);
  return row;
}

function toItem(r: Row, req: { code: string; title: string; levelLabel: string; displayOrder: number }, parentCode: string | null): EngagementRequirement {
  return {
    id: r.id, engagementId: r.engagementId, requirementId: r.requirementId, code: req.code, title: req.title, levelLabel: req.levelLabel,
    parentCode, displayOrder: req.displayOrder, applicable: r.applicable, naReason: r.naReason, ownerId: r.ownerId, reviewerId: r.reviewerId,
    status: r.status, dueDate: r.dueDate,
  };
}

/** All requirements of an engagement in tree order, with counts of the applicable ones by status. */
export async function listEngagementRequirements(ctx: Ctx, engagementId: string): Promise<RequirementList> {
  await assertPermitted(ctx, 'engagement:read', { type: 'any' });
  await getEngagementRow(ctx, engagementId);
  const rows = await ctx.tx.select({ er: engagementRequirement, req: requirement }).from(engagementRequirement)
    .innerJoin(requirement, eq(requirement.id, engagementRequirement.requirementId)).where(eq(engagementRequirement.engagementId, engagementId));
  const all = await ctx.tx.select({ id: requirement.id, parentId: requirement.parentId, code: requirement.code, displayOrder: requirement.displayOrder })
    .from(requirement).where(eq(requirement.frameworkVersionId, rows[0]?.req.frameworkVersionId ?? '00000000-0000-0000-0000-000000000000'));
  const codeOf = new Map(all.map((r) => [r.id, r.code]));
  const byParent = new Map<string | null, typeof all>();
  for (const r of all) byParent.set(r.parentId ?? null, [...(byParent.get(r.parentId ?? null) ?? []), r]);
  const order: string[] = [];
  const walk = (p: string | null) => { for (const r of (byParent.get(p) ?? []).sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code))) { order.push(r.id); walk(r.id); } };
  walk(null);
  const position = new Map(order.map((id, i) => [id, i]));
  // Assessable requirements only carry a row, but the tree path may pass through headings; parentCode names the nearest listed ancestor.
  const listed = new Set(rows.map((r) => r.req.id));
  const parentOf = new Map(all.map((r) => [r.id, r.parentId]));
  const nearest = (id: string): string | null => { let p = parentOf.get(id) ?? null; while (p && !listed.has(p)) p = parentOf.get(p) ?? null; return p ? codeOf.get(p) ?? null : null; };
  const items = rows.map(({ er, req }) => toItem(er, { ...req, displayOrder: position.get(req.id) ?? 0 }, nearest(req.id))).sort((a, b) => a.displayOrder - b.displayOrder);
  const byStatus: Record<string, number> = { not_started: 0, in_progress: 0, ready_for_review: 0, approved: 0, needs_work: 0 };
  for (const i of items) if (i.applicable) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
  return { items, byStatus };
}

const link = (x: { sourceDocumentId: string | null; sourcePage: number | null; sourceQuote: string | null; quoteVerified: boolean }) =>
  x.sourceDocumentId && x.sourcePage ? { documentId: x.sourceDocumentId, page: x.sourcePage, quote: x.sourceQuote, quoteVerified: x.quoteVerified } : null;

export async function getWorkspace(ctx: Ctx, id: string): Promise<Workspace> {
  await assertPermitted(ctx, 'engagement:read', { type: 'any' });
  const row = await load(ctx, id);
  const e = await getEngagementRow(ctx, row.engagementId);
  const [req] = await ctx.tx.select().from(requirement).where(eq(requirement.id, row.requirementId));
  if (!req) throw new NotFoundError('requirement');

  const path: { code: string; title: string }[] = [];
  for (let p = req.parentId; p;) {
    const [parent] = await ctx.tx.select().from(requirement).where(eq(requirement.id, p));
    if (!parent) break;
    path.unshift({ code: parent.code, title: parent.title });
    p = parent.parentId;
  }
  const notes = await ctx.tx.select().from(requirementNote).where(eq(requirementNote.requirementId, req.id)).orderBy(asc(requirementNote.type), asc(requirementNote.authority), asc(requirementNote.text));

  const events = await ctx.tx.select({ at: auditEvent.at, actorId: auditEvent.actorId, action: auditEvent.action, before: auditEvent.before, after: auditEvent.after })
    .from(auditEvent).where(and(eq(auditEvent.targetType, 'engagement_requirement'), eq(auditEvent.targetId, id))).orderBy(desc(auditEvent.at)).limit(100);
  const actors = new Map<string, string>();
  const actorIds = [...new Set(events.map((x) => x.actorId).filter((x): x is string => !!x))];
  if (actorIds.length) for (const u of await ctx.tx.select({ id: appUser.id, name: appUser.fullName }).from(appUser).where(inArray(appUser.id, actorIds))) actors.set(u.id, u.name);
  const quiet = new Set(['updated_at', 'updated_by', 'created_at', 'created_by']);
  const history = events.map((ev) => {
    const before = (ev.before ?? {}) as Record<string, unknown>;
    const after = (ev.after ?? {}) as Record<string, unknown>;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!quiet.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k])) changes[k] = { from: before[k] ?? null, to: after[k] ?? null };
    }
    return { at: ev.at.toISOString(), actorName: ev.actorId ? actors.get(ev.actorId) ?? null : null, action: ev.action, changes };
  });

  const access = await accessFor(ctx, row);
  const item = toItem(row, { code: req.code, title: req.title, levelLabel: req.levelLabel, displayOrder: req.displayOrder }, path.at(-1)?.code ?? null);
  return {
    item,
    requirement: { code: req.code, title: req.title, levelLabel: req.levelLabel, officialText: req.officialText, language: req.language, translationEn: req.translationEn, path, source: link(req) },
    notes: notes.map((n) => ({ id: n.id, type: n.type, text: n.text, authority: n.authority, norm: n.norm ?? null, source: link(n) })),
    workingNotes: row.workingNotes,
    allowedStatuses: allowedStatuses(row.status, access, row.applicable, e.status === 'active'),
    canAssign: access.manage && e.status === 'active',
    canEdit: access.work && row.applicable && e.status === 'active',
    canLinkEvidence: e.status === 'active' && row.applicable && await isPermitted(ctx.tx, 'engagement:work', scope(row.engagementId)),
    canReviewEvidence: e.status === 'active' && await isPermitted(ctx.tx, 'engagement:review', scope(row.engagementId)),
    reports: [],
    history,
  };
}

async function assertMemberIn(ctx: Ctx, engagementId: string, userId: string, roles: string[], what: string) {
  const [m] = await ctx.tx.select({ role: roleAssignment.role }).from(roleAssignment)
    .where(and(eq(roleAssignment.scopeType, 'engagement'), eq(roleAssignment.scopeId, engagementId), eq(roleAssignment.userId, userId)));
  if (!m || !roles.includes(m.role)) throw new ValidationError(`${what} must be a member of this engagement who can do that work`);
}

/** Work on one requirement: status, working notes, owner, reviewer, due date. */
export async function updateRequirementWork(ctx: Ctx, id: string, patch: UpdateRequirementWork): Promise<Workspace> {
  assertHuman(ctx);
  const row = await load(ctx, id);
  const e = await getActiveEngagementRow(ctx, row.engagementId);
  const access = await accessFor(ctx, row);
  if (!row.applicable) throw new ConflictError('this requirement is not applicable to the engagement; switch it on first');
  const set: Partial<typeof engagementRequirement.$inferInsert> = {};

  if (patch.ownerId !== undefined || patch.reviewerId !== undefined || patch.dueDate !== undefined) {
    if (!access.manage) throw new ConflictError('only the engagement lead or co-lead can assign owners, reviewers and due dates');
    if (patch.ownerId) await assertMemberIn(ctx, e.id, patch.ownerId, OWNER_ROLES, 'the owner');
    if (patch.reviewerId) await assertMemberIn(ctx, e.id, patch.reviewerId, REVIEWER_ROLES, 'the reviewer');
    if (patch.ownerId !== undefined) set.ownerId = patch.ownerId;
    if (patch.reviewerId !== undefined) set.reviewerId = patch.reviewerId;
    if (patch.dueDate !== undefined) set.dueDate = patch.dueDate;
  }
  if (patch.workingNotes !== undefined) {
    if (!access.work) throw new ConflictError('only the owner, or the engagement lead, can edit working notes');
    set.workingNotes = patch.workingNotes;
  }
  if (patch.status !== undefined && patch.status !== row.status) {
    const allowed = allowedStatuses(row.status, access, row.applicable, true);
    if (!allowed.includes(patch.status)) {
      const step = TRANSITIONS[row.status].find((t) => t.to === patch.status);
      throw new ConflictError(step
        ? `you cannot move this requirement to ${patch.status.replace(/_/g, ' ')}: ${step.needs === 'review' ? 'only its reviewer, or the engagement lead,' : 'only its owner, or the engagement lead,'} can`
        : `a requirement cannot go from ${row.status.replace(/_/g, ' ')} to ${patch.status.replace(/_/g, ' ')}`);
    }
    set.status = patch.status;
  }
  if (Object.keys(set).length) await guardIntegrity(() => ctx.tx.update(engagementRequirement).set(set).where(eq(engagementRequirement.id, id)));
  return getWorkspace(ctx, id);
}

/** Switches a requirement on or off for this engagement, with a reason (PRD 7.3, 8.3). The reason is kept and audited. */
export async function setApplicability(ctx: Ctx, id: string, input: SetApplicability): Promise<Workspace> {
  assertHuman(ctx);
  const row = await load(ctx, id);
  await assertPermitted(ctx, 'engagement:manage', scope(row.engagementId));
  await getActiveEngagementRow(ctx, row.engagementId);
  if (!input.reason.trim()) throw new ValidationError('a reason is required to change applicability');
  if (row.applicable === input.applicable) throw new ConflictError(`this requirement is already ${input.applicable ? 'applicable' : 'not applicable'}`);
  await ctx.tx.update(engagementRequirement).set({ applicable: input.applicable, naReason: input.reason }).where(eq(engagementRequirement.id, id));
  return getWorkspace(ctx, id);
}

/** Gives several requirements an owner, reviewer or due date at once: "assign criterion owners". */
export async function assignRequirements(ctx: Ctx, engagementId: string, input: AssignRequirements): Promise<{ updated: number }> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'engagement:manage', scope(engagementId));
  await getActiveEngagementRow(ctx, engagementId);
  if (input.ownerId) await assertMemberIn(ctx, engagementId, input.ownerId, OWNER_ROLES, 'the owner');
  if (input.reviewerId) await assertMemberIn(ctx, engagementId, input.reviewerId, REVIEWER_ROLES, 'the reviewer');
  const set: Partial<typeof engagementRequirement.$inferInsert> = {};
  if (input.ownerId !== undefined) set.ownerId = input.ownerId;
  if (input.reviewerId !== undefined) set.reviewerId = input.reviewerId;
  if (input.dueDate !== undefined) set.dueDate = input.dueDate;
  if (Object.keys(set).length === 0) throw new ValidationError('nothing to assign');
  const rows = await ctx.tx.update(engagementRequirement).set(set)
    .where(and(eq(engagementRequirement.engagementId, engagementId), inArray(engagementRequirement.requirementId, input.requirementIds), eq(engagementRequirement.applicable, true)))
    .returning({ id: engagementRequirement.id });
  if (rows.length !== new Set(input.requirementIds).size) {
    throw new ConflictError('some requirements are not part of this engagement or are not applicable; nothing was assigned');
  }
  return { updated: rows.length };
}
