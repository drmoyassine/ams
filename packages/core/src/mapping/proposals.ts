import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { iqfItemProposal, requirement, requirementMapping } from '@ams/db';
import type { AcceptCoversResult, AcceptIqfProposal, IqfItemProposal, IqfProposals } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman, getVersion, isInternalVersion, require_ } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { languageOf, loadIqf, loadIqfDraft, loadIqfItems } from '../framework/analysis/iqf-context.js';
import { normalizeCode } from '../framework/analysis/merge.js';
import { relabelByDepth } from '../framework/requirements.js';

/**
 * Suggested new items of the institution's quality framework (step E; DEC-021, DEC-022). The analysis drafts them where
 * nothing in the framework fits an external requirement; nothing is in the framework until a person accepts one. Accepting
 * creates the item in the framework's DRAFT version (origin 'ai', still to be approved when that version is published, like
 * any item) and the links to the external requirements (accepted, because the same person decided). Dismissing is
 * remembered: a later analysis does not raise the same need again.
 */
type Row = typeof iqfItemProposal.$inferSelect;

async function externalVersion(ctx: Ctx, versionId: string) {
  const v = await getVersion(ctx, versionId);
  if (await isInternalVersion(ctx, versionId)) throw new ValidationError('suggestions are made for an external standard, not for the quality framework');
  return v;
}

async function getRow(ctx: Ctx, id: string): Promise<Row> {
  const [row] = await ctx.tx.select().from(iqfItemProposal).where(eq(iqfItemProposal.id, id));
  if (!row) throw new NotFoundError(`suggested item ${id}`);
  return row;
}

async function toDtos(ctx: Ctx, rows: Row[], versionId: string): Promise<IqfItemProposal[]> {
  const external = new Map((await ctx.tx.select({ id: requirement.id, code: requirement.code, title: requirement.title }).from(requirement)
    .where(eq(requirement.frameworkVersionId, versionId))).map((r) => [normalizeCode(r.code), r]));
  const iqf = await loadIqf(ctx);
  const parents = new Map((iqf?.items ?? []).map((i) => [normalizeCode(i.code), i.title]));
  return rows.map((r) => ({
    id: r.id, status: r.status as IqfItemProposal['status'], parentCode: r.parentCode, parentTitle: r.parentCode ? parents.get(normalizeCode(r.parentCode)) ?? null : null,
    levelLabel: r.levelLabel, code: r.code, title: r.title, description: r.description, reason: r.reason,
    links: r.links.map((l) => ({
      externalCode: l.externalCode, externalRequirementId: external.get(normalizeCode(l.externalCode))?.id ?? null,
      externalTitle: external.get(normalizeCode(l.externalCode))?.title ?? null, relation: l.relation as IqfItemProposal['links'][number]['relation'], reason: l.reason,
    })),
    acceptedRequirementId: r.acceptedRequirementId, createdAt: r.createdAt.toISOString(),
  }));
}

/** The suggested new items of a version's analysis (replaced ones are not shown), and whether the framework has a draft to accept them into. */
export async function listIqfProposals(ctx: Ctx, versionId: string): Promise<IqfProposals> {
  await require_(ctx, 'framework:read');
  await externalVersion(ctx, versionId);
  const rows = await ctx.tx.select().from(iqfItemProposal)
    .where(and(eq(iqfItemProposal.frameworkVersionId, versionId), ne(iqfItemProposal.status, 'superseded'))).orderBy(desc(iqfItemProposal.createdAt));
  const draft = await loadIqfDraft(ctx);
  rows.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  return { draftVersionId: draft?.version.id ?? null, proposals: await toDtos(ctx, rows, versionId) };
}

/**
 * Accepts a suggested new item, with the person's edits: creates it in the quality framework's draft and the suggested
 * links (accepted). Refused when the framework has no draft version, with the way forward in the message.
 */
export async function acceptIqfProposal(ctx: Ctx, id: string, edits: AcceptIqfProposal = {}): Promise<IqfItemProposal> {
  await require_(ctx, 'framework:review');
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const p = await getRow(ctx, id);
  if (p.status !== 'pending') throw new ConflictError(`this suggestion was already ${p.status}`);
  const draft = await loadIqfDraft(ctx);
  if (!draft) throw new ConflictError('The quality framework has no draft version to add this to. Start a new version of the quality framework first (Settings, Quality framework), then accept the suggestion.');
  const items = await loadIqfItems(ctx, draft.version.id);
  const parentCode = edits.parentCode !== undefined ? edits.parentCode : p.parentCode;
  const parent = parentCode ? items.find((i) => normalizeCode(i.code) === normalizeCode(parentCode)) ?? null : null;
  if (parentCode && !parent) throw new ValidationError(`there is no item coded ${parentCode} in the draft of the quality framework to put this under`);
  const code = (edits.code ?? p.code).trim();
  if (items.some((i) => normalizeCode(i.code) === normalizeCode(code))) throw new ConflictError(`code ${code} is already used in the draft of the quality framework; choose another code`);
  const title = (edits.title ?? p.title).trim();
  const description = edits.description !== undefined ? (edits.description?.trim() || null) : p.description;

  const siblings = items.filter((i) => (i.parentId ?? null) === (parent?.id ?? null));
  const [created] = await guardIntegrity(() => ctx.tx.insert(requirement).values({
    institutionId: ctx.caller.institutionId, frameworkVersionId: draft.version.id, parentId: parent?.id ?? null, code, levelLabel: p.levelLabel, title,
    officialText: description, language: languageOf(`${title} ${description ?? ''}`), isAssessable: parent !== null,
    displayOrder: siblings.reduce((n, s) => Math.max(n, s.displayOrder), -1) + 1, origin: 'ai',
  }).returning());
  await relabelByDepth(ctx, draft.version.id);

  const now = new Date();
  for (const l of p.links) {
    const [existing] = await ctx.tx.select().from(requirementMapping).where(and(
      eq(requirementMapping.frameworkId, p.frameworkId), eq(requirementMapping.externalCode, l.externalCode), eq(requirementMapping.internalCode, code)));
    if (existing) {
      if (existing.reviewStatus !== 'approved') await ctx.tx.update(requirementMapping).set({ reviewStatus: 'approved', reviewedBy: ctx.caller.userId, reviewedAt: now }).where(eq(requirementMapping.id, existing.id));
      continue;
    }
    await ctx.tx.insert(requirementMapping).values({
      institutionId: ctx.caller.institutionId, frameworkId: p.frameworkId, externalCode: l.externalCode, internalFrameworkId: p.internalFrameworkId, internalCode: code,
      relation: l.relation as 'covers' | 'partly_covers' | 'related', rationale: l.reason, origin: 'ai', reviewStatus: 'approved', reviewedBy: ctx.caller.userId, reviewedAt: now,
    });
  }
  const [row] = await ctx.tx.update(iqfItemProposal).set({
    status: 'accepted', code, title, description, parentCode: parent?.code ?? null, decidedBy: ctx.caller.userId, decidedAt: now, acceptedRequirementId: created!.id,
  }).where(eq(iqfItemProposal.id, id)).returning();
  return (await toDtos(ctx, [row!], p.frameworkVersionId))[0]!;
}

/** Dismisses a suggested new item. Remembered: a later analysis does not suggest it again. */
export async function dismissIqfProposal(ctx: Ctx, id: string): Promise<IqfItemProposal> {
  await require_(ctx, 'framework:review');
  assertHuman(ctx);
  const p = await getRow(ctx, id);
  if (p.status !== 'pending') throw new ConflictError(`this suggestion was already ${p.status}`);
  const [row] = await ctx.tx.update(iqfItemProposal).set({ status: 'dismissed', decidedBy: ctx.caller.userId, decidedAt: new Date() }).where(eq(iqfItemProposal.id, id)).returning();
  return (await toDtos(ctx, [row!], p.frameworkVersionId))[0]!;
}

/**
 * "Accept all in this view": approves the listed suggested links that say "covers". A link that only partly covers or is
 * related, one that is no longer a pending suggestion, or one of another standard is left as it is and counted as skipped.
 */
export async function acceptCoverSuggestions(ctx: Ctx, versionId: string, ids: string[]): Promise<AcceptCoversResult> {
  await require_(ctx, 'framework:review');
  assertHuman(ctx);
  const v = await externalVersion(ctx, versionId);
  const rows = await ctx.tx.select().from(requirementMapping).where(and(eq(requirementMapping.frameworkId, v.frameworkId), inArray(requirementMapping.id, ids)));
  const ok = rows.filter((m) => m.origin === 'ai' && m.reviewStatus === 'pending' && m.relation === 'covers').map((m) => m.id);
  if (ok.length > 0) {
    await ctx.tx.update(requirementMapping).set({ reviewStatus: 'approved', reviewedBy: ctx.caller.userId, reviewedAt: new Date() }).where(inArray(requirementMapping.id, ok));
  }
  return { accepted: ok.length, skipped: ids.length - ok.length };
}
