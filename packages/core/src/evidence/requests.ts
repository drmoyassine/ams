// Evidence requests (DEC-018). Someone asks a person, by email address, for evidence on an item of the institution's
// own framework. An AMS user answers from their requests; anyone else through a one-time link. The answer becomes
// evidence with a proposed link, which a reviewer approves or rejects like any other.
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { appUser, evidenceItem, evidenceLink, evidenceRequest, evidenceVersion, frameworkVersion, institution } from '@ams/db';
import {
  CreateEvidenceRequestSchema, REQUEST_LINK_DAYS,
  type CreateEvidenceRequest, type EvidenceRequest, type IssuedRequest, type RequestByLink,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman, getRequirement, isInternalVersion } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted, isPermitted } from '../permissions.js';
import { internalTitlesByCode, newLink, storeFileVersion, type UploadedFile } from './evidence.js';

type RequestRow = typeof evidenceRequest.$inferSelect;
const any = { type: 'any' } as const;

/** The SHA-256 (hex) of a link secret: the only form in which a link is stored. */
export const hashLinkToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** A fresh one-time link secret and what to store for it. */
function issueToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashLinkToken(token), tokenExpiresAt: new Date(Date.now() + REQUEST_LINK_DAYS * 86_400_000) };
}

const today = () => new Date().toISOString().slice(0, 10);

async function describe(ctx: Ctx, rows: RequestRow[]): Promise<EvidenceRequest[]> {
  if (!rows.length) return [];
  const userIds = [...new Set(rows.flatMap((r) => [r.assigneeUserId, r.requestedBy]).filter((x): x is string => !!x))];
  const names = new Map((userIds.length ? await ctx.tx.select({ id: appUser.id, name: appUser.fullName }).from(appUser).where(inArray(appUser.id, userIds)) : []).map((u) => [u.id, u.name]));
  const linkIds = rows.map((r) => r.evidenceLinkId).filter((x): x is string => !!x);
  const items = new Map((linkIds.length ? await ctx.tx.select({ link: evidenceLink.id, item: evidenceVersion.evidenceItemId }).from(evidenceLink)
    .innerJoin(evidenceVersion, eq(evidenceVersion.id, evidenceLink.evidenceVersionId)).where(inArray(evidenceLink.id, linkIds)) : []).map((x) => [x.link, x.item]));
  const titles = await internalTitlesByCode(ctx);
  const now = today();
  return rows.map((r) => ({
    id: r.id, internalCode: r.internalCode, internalTitle: titles.get(r.internalCode) ?? null, title: r.title, message: r.message,
    assigneeEmail: r.assigneeEmail, assigneeName: r.assigneeUserId ? names.get(r.assigneeUserId) ?? null : null, assigneeHasAccount: !!r.assigneeUserId,
    dueDate: r.dueDate, status: r.status, overdue: r.status === 'open' && !!r.dueDate && r.dueDate < now,
    requestedByName: r.requestedBy ? names.get(r.requestedBy) ?? null : null, createdAt: r.createdAt.toISOString(),
    suppliedAt: r.suppliedAt?.toISOString() ?? null, suppliedNote: r.suppliedNote,
    linkExpiresAt: r.status === 'open' && r.tokenHash ? r.tokenExpiresAt?.toISOString() ?? null : null,
    evidenceItemId: r.evidenceLinkId ? items.get(r.evidenceLinkId) ?? null : null,
  }));
}

async function getRequestRow(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(evidenceRequest).where(eq(evidenceRequest.id, id));
  if (!row) throw new NotFoundError(`request ${id}`);
  return row;
}

async function internalTarget(ctx: Ctx, internalRequirementId: string) {
  const req = await getRequirement(ctx, internalRequirementId);
  if (!(await isInternalVersion(ctx, req.frameworkVersionId))) throw new ValidationError('evidence is requested for items of the internal quality framework');
  const [v] = await ctx.tx.select({ frameworkId: frameworkVersion.frameworkId }).from(frameworkVersion).where(eq(frameworkVersion.id, req.frameworkVersionId));
  return { frameworkId: v!.frameworkId, code: req.code };
}

/**
 * Asks a person for evidence on an item of the internal framework. If the address belongs to an active AMS user the
 * request appears in their requests; otherwise a one-time link is issued and returned (once) to be sent to them.
 */
export async function createEvidenceRequest(ctx: Ctx, internalRequirementId: string, input: CreateEvidenceRequest): Promise<IssuedRequest> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  const d = CreateEvidenceRequestSchema.parse(input);
  const target = await internalTarget(ctx, internalRequirementId);
  const [user] = await ctx.tx.select({ id: appUser.id }).from(appUser).where(and(sql`lower(${appUser.email}) = ${d.assigneeEmail}`, eq(appUser.active, true)));
  const link = user ? null : issueToken();
  const [row] = await guardIntegrity(() => ctx.tx.insert(evidenceRequest).values({
    institutionId: ctx.caller.institutionId, internalFrameworkId: target.frameworkId, internalCode: target.code, title: d.title,
    message: d.message ?? null, assigneeEmail: d.assigneeEmail, assigneeUserId: user?.id ?? null, dueDate: d.dueDate ?? null,
    requestedBy: ctx.caller.userId, tokenHash: link?.tokenHash ?? null, tokenExpiresAt: link?.tokenExpiresAt ?? null,
  }).returning());
  return { request: (await describe(ctx, [row!]))[0]!, linkToken: link?.token ?? null };
}

/** Requests on an item of the internal framework, newest first. */
export async function requestsForInternal(ctx: Ctx, internalRequirementId: string): Promise<EvidenceRequest[]> {
  await assertPermitted(ctx, 'evidence:read', any);
  const target = await internalTarget(ctx, internalRequirementId);
  const rows = await ctx.tx.select().from(evidenceRequest)
    .where(and(eq(evidenceRequest.internalFrameworkId, target.frameworkId), eq(evidenceRequest.internalCode, target.code)))
    .orderBy(desc(evidenceRequest.createdAt));
  return describe(ctx, rows);
}

/** Requests asked of the caller (`mine`), or every request in the institution. Open ones first, then newest first. */
export async function listEvidenceRequests(ctx: Ctx, opts: { mine?: boolean } = {}): Promise<EvidenceRequest[]> {
  await assertPermitted(ctx, 'evidence:read', any);
  if (opts.mine && !ctx.caller.userId) return [];
  const rows = await ctx.tx.select().from(evidenceRequest)
    .where(opts.mine ? eq(evidenceRequest.assigneeUserId, ctx.caller.userId!) : undefined)
    .orderBy(sql`${evidenceRequest.status} = 'open' desc`, desc(evidenceRequest.createdAt));
  return describe(ctx, rows);
}

export async function cancelEvidenceRequest(ctx: Ctx, id: string): Promise<EvidenceRequest> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  const row = await getRequestRow(ctx, id);
  if (row.status !== 'open') throw new ConflictError('this request is already closed');
  const [out] = await ctx.tx.update(evidenceRequest).set({ status: 'cancelled', tokenHash: null }).where(eq(evidenceRequest.id, id)).returning();
  return (await describe(ctx, [out!]))[0]!;
}

/** Replaces the one-time link of an open request (a lost or expired one stops working). */
export async function renewRequestLink(ctx: Ctx, id: string): Promise<IssuedRequest> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  const row = await getRequestRow(ctx, id);
  if (row.status !== 'open') throw new ConflictError('this request is already closed');
  if (row.assigneeUserId) throw new ConflictError('this person answers in the AMS; no link is needed');
  const link = issueToken();
  const [out] = await ctx.tx.update(evidenceRequest).set({ tokenHash: link.tokenHash, tokenExpiresAt: link.tokenExpiresAt }).where(eq(evidenceRequest.id, id)).returning();
  return { request: (await describe(ctx, [out!]))[0]!, linkToken: link.token };
}

/** The answer: the file becomes evidence, linked to the request's item as proposed, and the request is closed. */
async function supply(ctx: Ctx, row: RequestRow, file: UploadedFile, note: string | undefined): Promise<EvidenceRequest> {
  if (row.status !== 'open') throw new ConflictError('this request is already closed');
  const [item] = await guardIntegrity(() => ctx.tx.insert(evidenceItem).values({
    institutionId: ctx.caller.institutionId, title: row.title, type: 'document', ownerUserId: ctx.caller.userId,
  }).returning());
  const version = await storeFileVersion(ctx, item!.id, file);
  const trimmed = note?.trim() || undefined;
  const link = await newLink(ctx, {
    evidenceVersionId: version.id, internalFrameworkId: row.internalFrameworkId, internalCode: row.internalCode,
    rationale: trimmed ?? `Supplied in answer to the request "${row.title}"`,
  });
  const [out] = await ctx.tx.update(evidenceRequest).set({
    status: 'supplied', suppliedAt: new Date(), suppliedNote: trimmed ?? null, tokenHash: null, evidenceLinkId: link.id,
  }).where(eq(evidenceRequest.id, row.id)).returning();
  return (await describe(ctx, [out!]))[0]!;
}

/** A signed-in person answers: the person asked, or anyone who may add evidence (answering on their behalf). */
export async function answerEvidenceRequest(ctx: Ctx, id: string, file: UploadedFile, note?: string): Promise<EvidenceRequest> {
  assertHuman(ctx);
  const row = await getRequestRow(ctx, id);
  if (row.assigneeUserId !== ctx.caller.userId && !(await isPermitted(ctx.tx, 'evidence:write', any))) {
    throw new ForbiddenError('this request was not sent to you');
  }
  return supply(ctx, row, file, note);
}

/** What the one-time link page shows. `requestId` comes from the link itself, never from the caller. */
export async function requestByLink(ctx: Ctx, requestId: string): Promise<RequestByLink> {
  const row = await getRequestRow(ctx, requestId);
  const [d] = await describe(ctx, [row]);
  const [inst] = await ctx.tx.select({ name: institution.nameEn }).from(institution).where(eq(institution.id, row.institutionId));
  return {
    title: row.title, message: row.message, dueDate: row.dueDate, internalCode: row.internalCode, internalTitle: d!.internalTitle,
    requestedByName: d!.requestedByName, institutionName: inst?.name ?? '',
  };
}

/** The answer through a one-time link; the link stops working once it is used. */
export async function answerByLink(ctx: Ctx, requestId: string, file: UploadedFile, note?: string): Promise<void> {
  const row = await getRequestRow(ctx, requestId);
  if (row.assigneeUserId) throw new ConflictError('this request is answered in the AMS');
  await supply(ctx, row, file, note);
}
