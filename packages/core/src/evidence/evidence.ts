// Evidence (PRD 9, DEC-016). Evidence belongs to the institution: stored once, versioned, linked with a reason. It is
// attached to items of the institution's own framework, and each engagement requirement mapped to those items is
// offered it as a suggestion; linking it to the requirement is still a decision with its own reason and review.
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  appUser, engagement, engagementRequirement, evidenceItem, evidenceLink, evidenceVersion, framework, frameworkVersion, requirement, requirementMapping,
} from '@ams/db';
import {
  CreateEvidenceSchema, LinkEvidenceSchema, periodYear, ReviewLinkSchema, STALE_AFTER_YEARS, UpdateEvidenceSchema,
  type CreateEvidence, type EvidenceDetail, type EvidenceItem, type EvidenceLink, type EvidenceSuggestion, type EvidenceVersion,
  type LinkEvidence, type ReviewLink, type UpdateEvidence,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman, getRequirement, isInternalVersion } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';

type ItemRow = typeof evidenceItem.$inferSelect;
type VersionRow = typeof evidenceVersion.$inferSelect;
type LinkRow = typeof evidenceLink.$inferSelect;
const any = { type: 'any' } as const;
/** Largest file accepted (bytes); files pass through the API until storage is reachable from browsers. */
export const MAX_UPLOAD_BYTES = Number(process.env.EVIDENCE_MAX_UPLOAD_MB ?? 50) * 1024 * 1024;

const versionDto = (v: VersionRow): EvidenceVersion => ({
  id: v.id, versionNo: v.versionNo, fileName: v.fileName, mime: v.mime, size: v.size, sha256: v.sha256, url: v.url,
  asOfDate: v.asOfDate, notes: v.notes, createdAt: v.createdAt.toISOString(),
});
const itemDto = (r: ItemRow, latest: VersionRow | null, linkCount: number): EvidenceItem => ({
  id: r.id, title: r.title, description: r.description, type: r.type, ownerUnitId: r.ownerUnitId, ownerUserId: r.ownerUserId,
  periodLabel: r.periodLabel, confidentiality: r.confidentiality, containsStudentData: r.containsStudentData, tags: r.tags,
  status: r.status, latest: latest ? versionDto(latest) : null, linkCount,
});

async function getItem(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(evidenceItem).where(eq(evidenceItem.id, id));
  if (!row) throw new NotFoundError(`evidence ${id}`);
  return row;
}
async function getVersionRow(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(evidenceVersion).where(eq(evidenceVersion.id, id));
  if (!row) throw new NotFoundError(`evidence version ${id}`);
  return row;
}
async function latestVersions(ctx: Ctx, itemIds: string[]) {
  if (!itemIds.length) return new Map<string, VersionRow>();
  const rows = await ctx.tx.select().from(evidenceVersion).where(inArray(evidenceVersion.evidenceItemId, itemIds)).orderBy(desc(evidenceVersion.versionNo));
  const out = new Map<string, VersionRow>();
  for (const r of rows) if (!out.has(r.evidenceItemId)) out.set(r.evidenceItemId, r);
  return out;
}

// ---- Items and versions --------------------------------------------------------------------------------------------

export async function createEvidence(ctx: Ctx, input: CreateEvidence): Promise<EvidenceItem> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  const d = CreateEvidenceSchema.parse(input);
  const [row] = await guardIntegrity(() => ctx.tx.insert(evidenceItem).values({
    institutionId: ctx.caller.institutionId, title: d.title, description: d.description ?? null, type: d.type,
    ownerUnitId: d.ownerUnitId ?? null, ownerUserId: ctx.caller.userId, periodLabel: d.periodLabel ?? null,
    confidentiality: d.confidentiality, containsStudentData: d.containsStudentData, tags: d.tags,
  }).returning());
  let latest: VersionRow | null = null;
  if (d.url) {
    [latest] = await ctx.tx.insert(evidenceVersion).values({ institutionId: ctx.caller.institutionId, evidenceItemId: row!.id, versionNo: 1, url: d.url }).returning() as [VersionRow];
  }
  return itemDto(row!, latest, 0);
}

export async function updateEvidence(ctx: Ctx, id: string, patch: UpdateEvidence): Promise<EvidenceItem> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  await getItem(ctx, id);
  const d = UpdateEvidenceSchema.parse(patch);
  const [row] = await guardIntegrity(() => ctx.tx.update(evidenceItem).set(d).where(eq(evidenceItem.id, id)).returning());
  return itemDto(row!, (await latestVersions(ctx, [id])).get(id) ?? null, 0);
}

/** The repository: every item the caller may see, newest first, optionally narrowed by a word in the title or tags. */
export async function listEvidence(ctx: Ctx, opts: { q?: string } = {}): Promise<EvidenceItem[]> {
  await assertPermitted(ctx, 'evidence:read', any);
  const q = opts.q?.trim();
  const rows = await ctx.tx.select().from(evidenceItem)
    .where(q ? sql`(${evidenceItem.title} ilike ${`%${q}%`} or ${q} = any(${evidenceItem.tags}))` : undefined)
    .orderBy(desc(evidenceItem.createdAt));
  const ids = rows.map((r) => r.id);
  const latest = await latestVersions(ctx, ids);
  const counts = new Map<string, number>();
  if (ids.length) {
    const linked = await ctx.tx.select({ item: evidenceVersion.evidenceItemId }).from(evidenceLink)
      .innerJoin(evidenceVersion, eq(evidenceVersion.id, evidenceLink.evidenceVersionId)).where(inArray(evidenceVersion.evidenceItemId, ids));
    for (const l of linked) counts.set(l.item, (counts.get(l.item) ?? 0) + 1);
  }
  return rows.map((r) => itemDto(r, latest.get(r.id) ?? null, counts.get(r.id) ?? 0));
}

export async function getEvidence(ctx: Ctx, id: string): Promise<EvidenceDetail> {
  await assertPermitted(ctx, 'evidence:read', any);
  const row = await getItem(ctx, id);
  const versions = await ctx.tx.select().from(evidenceVersion).where(eq(evidenceVersion.evidenceItemId, id)).orderBy(desc(evidenceVersion.versionNo));
  const linkRows = versions.length
    ? await ctx.tx.select().from(evidenceLink).where(inArray(evidenceLink.evidenceVersionId, versions.map((v) => v.id))).orderBy(desc(evidenceLink.createdAt))
    : [];
  const links = await describeLinks(ctx, linkRows);
  return { item: itemDto(row, versions[0] ?? null, links.length), versions: versions.map(versionDto), links };
}

/** A file name safe to keep in a storage key and a header: path separators and control characters become _. */
const safeName = (s: string) => [...s.normalize('NFC')].map((ch) => (ch === '/' || ch === '\\' || ch.charCodeAt(0) < 32 ? '_' : ch)).join('').slice(0, 200) || 'file';

/** Stores an uploaded file as the item's next version. The stored size and SHA-256 are what the version records. */
export async function addFileVersion(ctx: Ctx, itemId: string, file: { fileName: string; mime: string; bytes: Uint8Array; asOfDate?: string; notes?: string }) {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  const item = await getItem(ctx, itemId);
  if (item.status === 'archived') throw new ConflictError('this evidence is archived');
  if (file.bytes.byteLength === 0) throw new ValidationError('the file is empty');
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) throw new ValidationError(`the file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB`);
  const [last] = await ctx.tx.select({ n: evidenceVersion.versionNo }).from(evidenceVersion).where(eq(evidenceVersion.evidenceItemId, itemId)).orderBy(desc(evidenceVersion.versionNo)).limit(1);
  const versionNo = (last?.n ?? 0) + 1;
  const fileName = safeName(file.fileName);
  const key = `${ctx.caller.institutionId}/evidence/${itemId}/${versionNo}-${crypto.randomUUID()}/${fileName}`;
  const stored = await ctx.store.put(key, file.bytes, file.mime || 'application/octet-stream');
  const [v] = await guardIntegrity(() => ctx.tx.insert(evidenceVersion).values({
    institutionId: ctx.caller.institutionId, evidenceItemId: itemId, versionNo, filePath: key, sha256: stored.sha256, fileName,
    mime: file.mime || 'application/octet-stream', size: stored.size, asOfDate: file.asOfDate ?? null, notes: file.notes ?? null,
  }).returning());
  return versionDto(v!);
}

/** Registers a new address (e.g. an updated SharePoint document) as the item's next version. */
export async function addUrlVersion(ctx: Ctx, itemId: string, input: { url: string; asOfDate?: string; notes?: string }) {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  await getItem(ctx, itemId);
  const [last] = await ctx.tx.select({ n: evidenceVersion.versionNo }).from(evidenceVersion).where(eq(evidenceVersion.evidenceItemId, itemId)).orderBy(desc(evidenceVersion.versionNo)).limit(1);
  const [v] = await guardIntegrity(() => ctx.tx.insert(evidenceVersion).values({
    institutionId: ctx.caller.institutionId, evidenceItemId: itemId, versionNo: (last?.n ?? 0) + 1, url: input.url,
    asOfDate: input.asOfDate ?? null, notes: input.notes ?? null,
  }).returning());
  return versionDto(v!);
}

/** The bytes of a stored version, for download or preview; row-level security decides whether the caller may see it. */
export async function readVersionFile(ctx: Ctx, versionId: string) {
  await assertPermitted(ctx, 'evidence:read', any);
  const v = await getVersionRow(ctx, versionId);
  if (!v.filePath) throw new NotFoundError('this version is a link, not a stored file');
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  const obj = await ctx.store.get(v.filePath);
  if (!obj) throw new NotFoundError('the stored file is missing');
  return { bytes: obj.body, mime: v.mime ?? obj.mime, fileName: v.fileName ?? 'file' };
}

// ---- Links -------------------------------------------------------------------------------------------------------

/** Links in the shape the screens use: what they point at, whether a newer version exists, whether they are stale. */
async function describeLinks(ctx: Ctx, rows: LinkRow[]): Promise<EvidenceLink[]> {
  if (!rows.length) return [];
  const versions = await ctx.tx.select({ v: evidenceVersion, i: evidenceItem }).from(evidenceVersion)
    .innerJoin(evidenceItem, eq(evidenceItem.id, evidenceVersion.evidenceItemId)).where(inArray(evidenceVersion.id, [...new Set(rows.map((r) => r.evidenceVersionId))]));
  const byVersion = new Map(versions.map((x) => [x.v.id, x]));
  const latest = await latestVersions(ctx, [...new Set(versions.map((x) => x.i.id))]);
  const erIds = [...new Set(rows.map((r) => r.engagementRequirementId).filter((x): x is string => !!x))];
  const ers = erIds.length ? await ctx.tx.select({ er: engagementRequirement, req: requirement, e: engagement }).from(engagementRequirement)
    .innerJoin(requirement, eq(requirement.id, engagementRequirement.requirementId)).innerJoin(engagement, eq(engagement.id, engagementRequirement.engagementId))
    .where(inArray(engagementRequirement.id, erIds)) : [];
  const erById = new Map(ers.map((x) => [x.er.id, x]));
  const internalTitles = await internalTitlesByCode(ctx);
  const userIds = [...new Set(rows.flatMap((r) => [r.linkedBy, r.reviewedBy]).filter((x): x is string => !!x))];
  const names = new Map((userIds.length ? await ctx.tx.select({ id: appUser.id, name: appUser.fullName }).from(appUser).where(inArray(appUser.id, userIds)) : []).map((u) => [u.id, u.name]));
  return rows.map((r) => {
    const { v, i } = byVersion.get(r.evidenceVersionId)!;
    const latestNo = latest.get(i.id)?.versionNo ?? v.versionNo;
    const er = r.engagementRequirementId ? erById.get(r.engagementRequirementId) : undefined;
    const year = periodYear(i.periodLabel);
    return {
      id: r.id, evidenceItemId: i.id, evidenceTitle: i.title, evidenceVersionId: v.id, versionNo: v.versionNo, latestVersionNo: latestNo,
      newerVersionAvailable: latestNo > v.versionNo, periodLabel: i.periodLabel,
      stale: !!er && year !== null && year < er.e.reviewYear - STALE_AFTER_YEARS,
      target: er
        ? { kind: 'engagement' as const, code: er.req.code, title: er.req.title, engagementRequirementId: er.er.id, engagementId: er.e.id, engagementTitle: er.e.title }
        : { kind: 'internal' as const, code: r.internalCode!, title: internalTitles.get(r.internalCode!) ?? null, engagementRequirementId: null, engagementId: null, engagementTitle: null },
      rationale: r.rationale, reviewStatus: r.reviewStatus, reviewComment: r.reviewComment,
      linkedByName: r.linkedBy ? names.get(r.linkedBy) ?? null : null, reviewedByName: r.reviewedBy ? names.get(r.reviewedBy) ?? null : null,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** Titles of the internal framework's items by code, from its newest published version (else its newest version). */
async function internalTitlesByCode(ctx: Ctx) {
  const [fw] = await ctx.tx.select({ id: framework.id }).from(framework).where(eq(framework.internal, true));
  if (!fw) return new Map<string, string>();
  const versions = await ctx.tx.select().from(frameworkVersion).where(eq(frameworkVersion.frameworkId, fw.id)).orderBy(desc(frameworkVersion.createdAt));
  const v = versions.find((x) => x.status === 'published') ?? versions[0];
  if (!v) return new Map<string, string>();
  return new Map((await ctx.tx.select({ code: requirement.code, title: requirement.title }).from(requirement).where(eq(requirement.frameworkVersionId, v.id))).map((r) => [r.code, r.title]));
}

async function newLink(ctx: Ctx, values: Omit<typeof evidenceLink.$inferInsert, 'institutionId'>) {
  const [row] = await guardIntegrity(() => ctx.tx.insert(evidenceLink).values({ ...values, institutionId: ctx.caller.institutionId, linkedBy: ctx.caller.userId }).returning());
  return (await describeLinks(ctx, [row!]))[0]!;
}

/** Attaches evidence to an item of the internal framework (keyed by its code, so it carries over to new versions). */
export async function linkToInternal(ctx: Ctx, internalRequirementId: string, input: LinkEvidence): Promise<EvidenceLink> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  const d = LinkEvidenceSchema.parse(input);
  const req = await getRequirement(ctx, internalRequirementId);
  if (!(await isInternalVersion(ctx, req.frameworkVersionId))) throw new ValidationError('evidence is attached to items of the internal quality framework');
  const [v] = await ctx.tx.select({ frameworkId: frameworkVersion.frameworkId }).from(frameworkVersion).where(eq(frameworkVersion.id, req.frameworkVersionId));
  await getVersionRow(ctx, d.evidenceVersionId);
  const [dup] = await ctx.tx.select({ id: evidenceLink.id }).from(evidenceLink).where(and(
    eq(evidenceLink.evidenceVersionId, d.evidenceVersionId), eq(evidenceLink.internalFrameworkId, v!.frameworkId), eq(evidenceLink.internalCode, req.code)));
  if (dup) throw new ConflictError('this evidence version is already attached here');
  return newLink(ctx, { evidenceVersionId: d.evidenceVersionId, internalFrameworkId: v!.frameworkId, internalCode: req.code, rationale: d.rationale });
}

async function engagementOf(ctx: Ctx, engagementRequirementId: string) {
  const [row] = await ctx.tx.select({ er: engagementRequirement, e: engagement }).from(engagementRequirement)
    .innerJoin(engagement, eq(engagement.id, engagementRequirement.engagementId)).where(eq(engagementRequirement.id, engagementRequirementId));
  if (!row) throw new NotFoundError(`engagement requirement ${engagementRequirementId}`);
  return row;
}

/** Links evidence to a requirement of an engagement, with this requirement's own reason; it starts as proposed. */
export async function linkToEngagementRequirement(ctx: Ctx, engagementRequirementId: string, input: LinkEvidence): Promise<EvidenceLink> {
  assertHuman(ctx);
  const d = LinkEvidenceSchema.parse(input);
  const { e } = await engagementOf(ctx, engagementRequirementId);
  await assertPermitted(ctx, 'engagement:work', { type: 'engagement', id: e.id });
  if (e.status !== 'active') throw new ConflictError('the engagement is not active');
  await getVersionRow(ctx, d.evidenceVersionId);
  const [dup] = await ctx.tx.select({ id: evidenceLink.id }).from(evidenceLink).where(and(
    eq(evidenceLink.evidenceVersionId, d.evidenceVersionId), eq(evidenceLink.engagementRequirementId, engagementRequirementId)));
  if (dup) throw new ConflictError('this evidence version is already linked here');
  return newLink(ctx, { evidenceVersionId: d.evidenceVersionId, engagementRequirementId, rationale: d.rationale });
}

async function getLink(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(evidenceLink).where(eq(evidenceLink.id, id));
  if (!row) throw new NotFoundError(`link ${id}`);
  return row;
}
/** Reviewing an engagement link is part of the engagement's review; reviewing an internal one is evidence review. */
async function assertMayReview(ctx: Ctx, link: LinkRow) {
  if (link.engagementRequirementId) {
    const { e } = await engagementOf(ctx, link.engagementRequirementId);
    await assertPermitted(ctx, 'engagement:review', { type: 'engagement', id: e.id });
  } else await assertPermitted(ctx, 'evidence:review', any);
}

/** A person approves or rejects a link; the AI never does (DEC-006). */
export async function reviewLink(ctx: Ctx, id: string, input: ReviewLink): Promise<EvidenceLink> {
  assertHuman(ctx);
  const d = ReviewLinkSchema.parse(input);
  const link = await getLink(ctx, id);
  await assertMayReview(ctx, link);
  const [row] = await ctx.tx.update(evidenceLink).set({ reviewStatus: d.decision, reviewedBy: ctx.caller.userId, reviewedAt: new Date(), reviewComment: d.comment ?? null })
    .where(eq(evidenceLink.id, id)).returning();
  return (await describeLinks(ctx, [row!]))[0]!;
}

/** Removes a link. One that was approved can be removed only by someone who may review it. */
export async function removeLink(ctx: Ctx, id: string): Promise<void> {
  assertHuman(ctx);
  const link = await getLink(ctx, id);
  if (link.reviewStatus === 'approved') await assertMayReview(ctx, link);
  else if (link.engagementRequirementId) {
    const { e } = await engagementOf(ctx, link.engagementRequirementId);
    await assertPermitted(ctx, 'engagement:work', { type: 'engagement', id: e.id });
  } else await assertPermitted(ctx, 'evidence:write', any);
  await ctx.tx.delete(evidenceLink).where(eq(evidenceLink.id, id));
}

export async function linksForEngagementRequirement(ctx: Ctx, engagementRequirementId: string): Promise<EvidenceLink[]> {
  await assertPermitted(ctx, 'evidence:read', any);
  await engagementOf(ctx, engagementRequirementId);
  const rows = await ctx.tx.select().from(evidenceLink).where(eq(evidenceLink.engagementRequirementId, engagementRequirementId)).orderBy(desc(evidenceLink.createdAt));
  return describeLinks(ctx, rows);
}

export async function linksForInternal(ctx: Ctx, internalRequirementId: string): Promise<EvidenceLink[]> {
  await assertPermitted(ctx, 'evidence:read', any);
  const req = await getRequirement(ctx, internalRequirementId);
  const [v] = await ctx.tx.select({ frameworkId: frameworkVersion.frameworkId }).from(frameworkVersion).where(eq(frameworkVersion.id, req.frameworkVersionId));
  const rows = await ctx.tx.select().from(evidenceLink)
    .where(and(eq(evidenceLink.internalFrameworkId, v!.frameworkId), eq(evidenceLink.internalCode, req.code), isNull(evidenceLink.engagementRequirementId)))
    .orderBy(desc(evidenceLink.createdAt));
  return describeLinks(ctx, rows);
}

/**
 * What the institution's own framework already holds for an engagement requirement: evidence approved on the internal
 * items its standard maps to (approved mappings only), that is not yet linked to this requirement.
 */
export async function suggestionsFor(ctx: Ctx, engagementRequirementId: string): Promise<EvidenceSuggestion[]> {
  await assertPermitted(ctx, 'evidence:read', any);
  const { er } = await engagementOf(ctx, engagementRequirementId);
  const [ext] = await ctx.tx.select({ code: requirement.code, frameworkId: frameworkVersion.frameworkId }).from(requirement)
    .innerJoin(frameworkVersion, eq(frameworkVersion.id, requirement.frameworkVersionId)).where(eq(requirement.id, er.requirementId));
  if (!ext) return [];
  const maps = await ctx.tx.select().from(requirementMapping).where(and(
    eq(requirementMapping.frameworkId, ext.frameworkId), eq(requirementMapping.externalCode, ext.code), eq(requirementMapping.reviewStatus, 'approved')));
  if (!maps.length) return [];
  const internal = await ctx.tx.select({ l: evidenceLink, v: evidenceVersion, i: evidenceItem }).from(evidenceLink)
    .innerJoin(evidenceVersion, eq(evidenceVersion.id, evidenceLink.evidenceVersionId)).innerJoin(evidenceItem, eq(evidenceItem.id, evidenceVersion.evidenceItemId))
    .where(and(eq(evidenceLink.reviewStatus, 'approved'), inArray(evidenceLink.internalCode, maps.map((m) => m.internalCode)),
      inArray(evidenceLink.internalFrameworkId, [...new Set(maps.map((m) => m.internalFrameworkId))])));
  const already = new Set((await ctx.tx.select({ v: evidenceLink.evidenceVersionId }).from(evidenceLink).where(eq(evidenceLink.engagementRequirementId, engagementRequirementId))).map((x) => x.v));
  const titles = await internalTitlesByCode(ctx);
  const relation = new Map(maps.map((m) => [m.internalCode, m.relation]));
  const seen = new Set<string>();
  const out: EvidenceSuggestion[] = [];
  for (const { l, v, i } of internal) {
    if (already.has(v.id) || seen.has(v.id) || i.status === 'archived') continue;
    seen.add(v.id);
    out.push({
      evidenceItemId: i.id, evidenceVersionId: v.id, title: i.title, versionNo: v.versionNo, periodLabel: i.periodLabel,
      internalCode: l.internalCode!, internalTitle: titles.get(l.internalCode!) ?? null, relation: relation.get(l.internalCode!)!, internalRationale: l.rationale,
    });
  }
  return out.sort((a, b) => a.internalCode.localeCompare(b.internalCode) || a.title.localeCompare(b.title));
}
