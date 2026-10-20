// Evidence (PRD 9, DEC-016). Evidence belongs to the institution: stored once, versioned, linked with a reason. It is
// attached to items of the institution's own framework, and each engagement requirement mapped to those items is
// offered it as a suggestion; linking it to the requirement is still a decision with its own reason and review.
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  accreditor, appUser, datasetResponse, datasetSpec, engagement, engagementRequirement, evidenceItem, evidenceLink, evidenceRequest, evidenceVersion, framework,
  frameworkVersion, requirement, requirementMapping,
} from '@ams/db';
import {
  CreateEvidenceSchema, LinkEvidenceSchema, periodYear, ResubmitLinkSchema, ReviewLinkSchema, STALE_AFTER_YEARS, UpdateEvidenceSchema,
  type CreateEvidence, type EvidenceDetail, type EvidenceItem, type EvidenceLink, type EvidenceSuggestion, type EvidenceVersion,
  type LinkEvidence, type RequirementContext, type RequirementContexts, type ResubmitLink, type ReviewLink, type UpdateEvidence,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman, getRequirement, getVersion, require_ } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted, isPermitted } from '../permissions.js';
import { reportUndo } from '../trash/store.js';
import { loadAssignments } from '../scope/assignments.js';
import { noteEvidenceVersion } from '../cycles/evidence-hook.js';
import { loadPlanAssignments } from '../cycles/plan-service.js';
import { trashEvidenceLink } from '../trash/delete.js';
import { readRows } from '../trash/rows.js';
import { createNotification, dismissFor } from '../notifications/store.js';

type ItemRow = typeof evidenceItem.$inferSelect;
type VersionRow = typeof evidenceVersion.$inferSelect;
type LinkRow = typeof evidenceLink.$inferSelect;
const any = { type: 'any' } as const;
/** Largest file accepted (bytes); files pass through the API until storage is reachable from browsers. */
export const MAX_UPLOAD_BYTES = Number(process.env.EVIDENCE_MAX_UPLOAD_MB ?? 50) * 1024 * 1024;

export const versionDto = (v: VersionRow): EvidenceVersion => ({
  id: v.id, versionNo: v.versionNo, fileName: v.fileName, mime: v.mime, size: v.size, sha256: v.sha256, url: v.url,
  asOfDate: v.asOfDate, notes: v.notes, createdAt: v.createdAt.toISOString(),
  rowCount: Array.isArray((v.data as { rows?: unknown } | null)?.rows) ? (v.data as { rows: unknown[] }).rows.length : null,
});
/** What the repository shows about an item besides its own fields: its links, open requests and form. */
interface ItemStats { linkCount: number; proposedLinkCount: number; openRequestCount: number; formOpen: boolean; pendingResponses: number }
const NO_STATS: ItemStats = { linkCount: 0, proposedLinkCount: 0, openRequestCount: 0, formOpen: false, pendingResponses: 0 };

const itemDto = (r: ItemRow, latest: VersionRow | null, stats: ItemStats): EvidenceItem => ({
  id: r.id, title: r.title, description: r.description, type: r.type, subtype: r.subtype, ownerUnitId: r.ownerUnitId, ownerUserId: r.ownerUserId,
  periodLabel: r.periodLabel, confidentiality: r.confidentiality, containsStudentData: r.containsStudentData, tags: r.tags,
  status: r.status, latest: latest ? versionDto(latest) : null, ...stats,
});

/** Stats for many items in a fixed number of queries (one per kind of count, never one per item). */
async function itemStats(ctx: Ctx, itemIds: string[]): Promise<Map<string, ItemStats>> {
  const out = new Map(itemIds.map((id) => [id, { ...NO_STATS }]));
  if (!itemIds.length) return out;
  const links = await ctx.tx.select({
    item: evidenceVersion.evidenceItemId, n: sql<number>`count(*)::int`,
    proposed: sql<number>`(count(*) filter (where ${evidenceLink.reviewStatus} = 'proposed'))::int`,
  }).from(evidenceLink).innerJoin(evidenceVersion, eq(evidenceVersion.id, evidenceLink.evidenceVersionId))
    .where(inArray(evidenceVersion.evidenceItemId, itemIds)).groupBy(evidenceVersion.evidenceItemId);
  const requests = await ctx.tx.select({ item: evidenceRequest.dataItemId, n: sql<number>`count(*)::int` }).from(evidenceRequest)
    .where(and(inArray(evidenceRequest.dataItemId, itemIds), eq(evidenceRequest.status, 'open'))).groupBy(evidenceRequest.dataItemId);
  const specs = await ctx.tx.select({ item: datasetSpec.evidenceItemId, open: datasetSpec.formOpen }).from(datasetSpec).where(inArray(datasetSpec.evidenceItemId, itemIds));
  const responses = await ctx.tx.select({ item: datasetResponse.evidenceItemId, n: sql<number>`count(*)::int` }).from(datasetResponse)
    .where(and(inArray(datasetResponse.evidenceItemId, itemIds), isNull(datasetResponse.includedInVersionId))).groupBy(datasetResponse.evidenceItemId);
  for (const l of links) Object.assign(out.get(l.item)!, { linkCount: l.n, proposedLinkCount: l.proposed });
  for (const r of requests) if (r.item) out.get(r.item)!.openRequestCount = r.n;
  for (const f of specs) out.get(f.item)!.formOpen = f.open;
  for (const r of responses) out.get(r.item)!.pendingResponses = r.n;
  return out;
}

/** Items in the repository's shape: their latest version and stats. */
async function describeItems(ctx: Ctx, rows: ItemRow[]): Promise<EvidenceItem[]> {
  const ids = rows.map((r) => r.id);
  const latest = await latestVersions(ctx, ids);
  const stats = await itemStats(ctx, ids);
  return rows.map((r) => itemDto(r, latest.get(r.id) ?? null, stats.get(r.id)!));
}

export async function getItem(ctx: Ctx, id: string) {
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
    institutionId: ctx.caller.institutionId, title: d.title, description: d.description ?? null, type: d.type, subtype: d.subtype ?? null,
    ownerUnitId: d.ownerUnitId ?? null, ownerUserId: ctx.caller.userId, periodLabel: d.periodLabel ?? null,
    confidentiality: d.confidentiality, containsStudentData: d.containsStudentData, tags: d.tags,
  }).returning());
  let latest: VersionRow | null = null;
  if (d.url) {
    [latest] = await ctx.tx.insert(evidenceVersion).values({ institutionId: ctx.caller.institutionId, evidenceItemId: row!.id, versionNo: 1, url: d.url }).returning() as [VersionRow];
  }
  return itemDto(row!, latest, NO_STATS);
}

export async function updateEvidence(ctx: Ctx, id: string, patch: UpdateEvidence): Promise<EvidenceItem> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  const item = await getItem(ctx, id);
  const d = UpdateEvidenceSchema.parse(patch);
  if (d.type && d.type !== item.type) await assertMayChangeType(ctx, id, d.type);
  const [row] = await guardIntegrity(() => ctx.tx.update(evidenceItem).set(d).where(eq(evidenceItem.id, id)).returning());
  return (await describeItems(ctx, [row!]))[0]!;
}

/**
 * A document becomes data only while it holds no file or address, and data a document only while it holds no saved
 * data or form responses: what was stored stays readable as what it is.
 */
async function assertMayChangeType(ctx: Ctx, id: string, to: EvidenceItem['type']) {
  const versions = await ctx.tx.select({ filePath: evidenceVersion.filePath, url: evidenceVersion.url, data: evidenceVersion.data })
    .from(evidenceVersion).where(eq(evidenceVersion.evidenceItemId, id));
  if (to === 'data' && versions.some((v) => v.filePath || v.url)) throw new ConflictError('this document has file versions; it cannot become data');
  if (to === 'document') {
    const [response] = await ctx.tx.select({ id: datasetResponse.id }).from(datasetResponse).where(eq(datasetResponse.evidenceItemId, id)).limit(1);
    if (versions.some((v) => v.data !== null) || response) throw new ConflictError('this data has saved data or form responses; it cannot become a document');
  }
}

/**
 * The repository: every item the caller may see, newest first, optionally narrowed by a word in the title or tags.
 * Archived items are left out unless asked for.
 */
export async function listEvidence(ctx: Ctx, opts: { q?: string; includeArchived?: boolean } = {}): Promise<EvidenceItem[]> {
  await assertPermitted(ctx, 'evidence:read', any);
  const q = opts.q?.trim();
  const rows = await ctx.tx.select().from(evidenceItem)
    .where(and(
      q ? sql`(${evidenceItem.title} ilike ${`%${q}%`} or ${q} = any(${evidenceItem.tags}))` : undefined,
      opts.includeArchived ? undefined : eq(evidenceItem.status, 'active'),
    ))
    .orderBy(desc(evidenceItem.createdAt));
  return describeItems(ctx, rows);
}

export async function getEvidence(ctx: Ctx, id: string): Promise<EvidenceDetail> {
  await assertPermitted(ctx, 'evidence:read', any);
  const row = await getItem(ctx, id);
  const versions = await ctx.tx.select().from(evidenceVersion).where(eq(evidenceVersion.evidenceItemId, id)).orderBy(desc(evidenceVersion.versionNo));
  const linkRows = versions.length
    ? await ctx.tx.select().from(evidenceLink).where(inArray(evidenceLink.evidenceVersionId, versions.map((v) => v.id))).orderBy(desc(evidenceLink.createdAt))
    : [];
  const links = await describeLinks(ctx, linkRows);
  return { item: (await describeItems(ctx, [row]))[0]!, versions: versions.map(versionDto), links };
}

/** A file name safe to keep in a storage key and a header: path separators and control characters become _. */
const safeName = (s: string) => [...s.normalize('NFC')].map((ch) => (ch === '/' || ch === '\\' || ch.charCodeAt(0) < 32 ? '_' : ch)).join('').slice(0, 200) || 'file';

/** Stores an uploaded file as the item's next version. The stored size and SHA-256 are what the version records. */
export async function addFileVersion(ctx: Ctx, itemId: string, file: UploadedFile) {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  return storeFileVersion(ctx, itemId, file);
}

export interface UploadedFile { fileName: string; mime: string; bytes: Uint8Array; asOfDate?: string; notes?: string }

/** Stores the file as the item's next version; the caller has already decided who may do this. */
export async function storeFileVersion(ctx: Ctx, itemId: string, file: UploadedFile) {
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  const item = await getItem(ctx, itemId);
  if (item.status === 'archived') throw new ConflictError('this evidence is archived');
  if (file.bytes.byteLength === 0) throw new ValidationError('the file is empty');
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) throw new ValidationError(`the file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB`);
  const [last] = await ctx.tx.select({ n: evidenceVersion.versionNo }).from(evidenceVersion).where(eq(evidenceVersion.evidenceItemId, itemId)).orderBy(desc(evidenceVersion.versionNo)).limit(1);
  const versionNo = (last?.n ?? 0) + 1;
  const fileName = safeName(file.fileName);
  const key = `${ctx.caller.institutionId}/evidence/${itemId}/${versionNo}-${crypto.randomUUID()}/${fileName}`;
  let stored: { size: number; sha256: string };
  try {
    stored = await ctx.store.put(key, file.bytes, file.mime || 'application/octet-stream');
  } catch (e) {
    // Say what the storage service answered, so a misconfiguration can be seen and fixed rather than guessed at.
    const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    console.error(JSON.stringify({ level: 'error', msg: 'evidence upload: storage refused the file', name: err.name, status: err.$metadata?.httpStatusCode, detail: err.message }));
    throw new ConflictError(`the file could not be stored (${[err.name, err.$metadata?.httpStatusCode, err.message].filter(Boolean).join(' ')})`);
  }
  const [v] = await guardIntegrity(() => ctx.tx.insert(evidenceVersion).values({
    institutionId: ctx.caller.institutionId, evidenceItemId: itemId, versionNo, filePath: key, sha256: stored.sha256, fileName,
    mime: file.mime || 'application/octet-stream', size: stored.size, asOfDate: file.asOfDate ?? null, notes: file.notes ?? null,
  }).returning());
  await noteEvidenceVersion(ctx, itemId, { versionNo, what: fileName });
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
  await noteEvidenceVersion(ctx, itemId, { versionNo: v!.versionNo, what: input.url });
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
export async function describeLinks(ctx: Ctx, rows: LinkRow[]): Promise<EvidenceLink[]> {
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
  // Library-level targets: the institution's own framework, or any other standard (by framework and code).
  const targetFrameworks = new Map<string, { internal: boolean; label: string; titles: Map<string, string> }>();
  for (const id of new Set(rows.filter((r) => r.internalFrameworkId).map((r) => r.internalFrameworkId!))) {
    const [fw] = await ctx.tx.select({ internal: framework.internal, short: accreditor.shortName }).from(framework)
      .innerJoin(accreditor, eq(accreditor.id, framework.accreditorId)).where(eq(framework.id, id));
    targetFrameworks.set(id, { internal: fw?.internal ?? true, label: fw?.short ?? '', titles: await titlesByCode(ctx, id) });
  }
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
        : (() => {
          const fw = targetFrameworks.get(r.internalFrameworkId!);
          return {
            kind: fw?.internal === false ? ('external' as const) : ('internal' as const), code: r.internalCode!, title: fw?.titles.get(r.internalCode!) ?? null,
            engagementRequirementId: null, engagementId: null, engagementTitle: null, ...(fw?.internal === false ? { frameworkLabel: fw.label } : {}),
          };
        })(),
      rationale: r.rationale, reviewStatus: r.reviewStatus, reviewComment: r.reviewComment, linkedBy: r.linkedBy,
      linkedByName: r.linkedBy ? names.get(r.linkedBy) ?? null : null, reviewedByName: r.reviewedBy ? names.get(r.reviewedBy) ?? null : null,
      reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null, createdAt: r.createdAt.toISOString(),
    };
  });
}

/** Titles of a framework's requirements by code, from its newest published version (else its newest version). */
async function titlesByCode(ctx: Ctx, frameworkId: string) {
  const versions = await ctx.tx.select().from(frameworkVersion).where(eq(frameworkVersion.frameworkId, frameworkId)).orderBy(desc(frameworkVersion.createdAt));
  const v = versions.find((x) => x.status === 'published') ?? versions[0];
  if (!v) return new Map<string, string>();
  return new Map((await ctx.tx.select({ code: requirement.code, title: requirement.title }).from(requirement).where(eq(requirement.frameworkVersionId, v.id))).map((r) => [r.code, r.title]));
}

/** Titles of the internal framework's items by code, from its newest published version (else its newest version). */
export async function internalTitlesByCode(ctx: Ctx) {
  const [fw] = await ctx.tx.select({ id: framework.id }).from(framework).where(eq(framework.internal, true));
  return fw ? titlesByCode(ctx, fw.id) : new Map<string, string>();
}

/** A new link that always starts as proposed (an answer to a request keeps its own flow: a reviewer approves it). */
export async function newLink(ctx: Ctx, values: Omit<typeof evidenceLink.$inferInsert, 'institutionId'>) {
  const [row] = await guardIntegrity(() => ctx.tx.insert(evidenceLink).values({ ...values, institutionId: ctx.caller.institutionId, linkedBy: ctx.caller.userId }).returning());
  return (await describeLinks(ctx, [row!]))[0]!;
}

/** What reviewing a link takes: engagement review on its engagement, or evidence review for a library link. */
async function reviewRight(ctx: Ctx, engagementRequirementId: string | null | undefined) {
  if (engagementRequirementId) {
    const { e } = await engagementOf(ctx, engagementRequirementId);
    return { permission: 'engagement:review' as const, resource: { type: 'engagement' as const, id: e.id } };
  }
  return { permission: 'evidence:review' as const, resource: any };
}
async function mayReview(ctx: Ctx, engagementRequirementId: string | null | undefined): Promise<boolean> {
  const r = await reviewRight(ctx, engagementRequirementId);
  return isPermitted(ctx.tx, r.permission, r.resource);
}

/**
 * A new link made by a person (TASK-088): approved at once when its creator may review it (the same right as reviewing, with
 * reviewedBy = the creator and no comment; the audit trail records it), else proposed for a reviewer. The AI never approves
 * (the callers have passed assertHuman).
 */
async function createLink(ctx: Ctx, values: Omit<typeof evidenceLink.$inferInsert, 'institutionId'>) {
  const approve = !!ctx.caller.userId && await mayReview(ctx, values.engagementRequirementId);
  return newLink(ctx, approve ? { ...values, reviewStatus: 'approved', reviewedBy: ctx.caller.userId, reviewedAt: new Date() } : values);
}
const linkedLabel = (l: EvidenceLink, target: string) => (l.reviewStatus === 'approved'
  ? `Linked and approved ${l.evidenceTitle} to ${target}` : `Proposed ${l.evidenceTitle} for ${target}: a reviewer approves it`);

/**
 * Attaches evidence to a requirement of any standard, the institution's own framework or an external one, keyed by the
 * framework and the requirement's code so the link carries over to new versions of that standard. It lives outside the
 * frozen version tables, so a published version can be linked too. It starts as proposed for a person who cannot review it
 * (evidence review approves it) and as approved for one who can.
 */
export async function linkToRequirement(ctx: Ctx, requirementId: string, input: LinkEvidence): Promise<EvidenceLink> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  const d = LinkEvidenceSchema.parse(input);
  const req = await getRequirement(ctx, requirementId);
  const [v] = await ctx.tx.select({ frameworkId: frameworkVersion.frameworkId }).from(frameworkVersion).where(eq(frameworkVersion.id, req.frameworkVersionId));
  await getVersionRow(ctx, d.evidenceVersionId);
  const [dup] = await ctx.tx.select({ id: evidenceLink.id }).from(evidenceLink).where(and(
    eq(evidenceLink.evidenceVersionId, d.evidenceVersionId), eq(evidenceLink.internalFrameworkId, v!.frameworkId), eq(evidenceLink.internalCode, req.code)));
  if (dup) throw new ConflictError('this evidence version is already attached here');
  const link = await createLink(ctx, { evidenceVersionId: d.evidenceVersionId, internalFrameworkId: v!.frameworkId, internalCode: req.code, rationale: d.rationale });
  reportUndo(ctx, { label: linkedLabel(link, req.code), method: 'DELETE', path: `/api/evidence-links/${link.id}` });
  return link;
}
/** The original name: the internal framework was the only target at first. */
export const linkToInternal = linkToRequirement;

async function engagementOf(ctx: Ctx, engagementRequirementId: string) {
  const [row] = await ctx.tx.select({ er: engagementRequirement, e: engagement }).from(engagementRequirement)
    .innerJoin(engagement, eq(engagement.id, engagementRequirement.engagementId)).where(eq(engagementRequirement.id, engagementRequirementId));
  if (!row) throw new NotFoundError(`engagement requirement ${engagementRequirementId}`);
  return row;
}

/** Links evidence to a requirement of an engagement, with this requirement's own reason; proposed, or approved at once for a reviewer of the engagement. */
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
  const link = await createLink(ctx, { evidenceVersionId: d.evidenceVersionId, engagementRequirementId, rationale: d.rationale });
  reportUndo(ctx, { label: linkedLabel(link, link.target.code), method: 'DELETE', path: `/api/evidence-links/${link.id}` });
  return link;
}

async function getLink(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(evidenceLink).where(eq(evidenceLink.id, id));
  if (!row) throw new NotFoundError(`link ${id}`);
  return row;
}
/** Reviewing an engagement link is part of the engagement's review; reviewing a library one is evidence review. */
async function assertMayReview(ctx: Ctx, link: LinkRow) {
  const r = await reviewRight(ctx, link.engagementRequirementId);
  await assertPermitted(ctx, r.permission, r.resource);
}

/** How a link reads in a notice: its standard or requirement, with its title. */
const targetLabel = (t: EvidenceLink['target']) => `${t.code}${t.title ? ` · ${t.title}` : ''}${t.engagementTitle ? ` (${t.engagementTitle})` : ''}`;

/**
 * A person approves or rejects a link; the AI never does (DEC-006). A rejection says why (the proposer sees it); the proposer
 * is told in the app of a rejection, or of an approval by someone else, never of their own decision.
 */
export async function reviewLink(ctx: Ctx, id: string, input: ReviewLink): Promise<EvidenceLink> {
  assertHuman(ctx);
  const d = ReviewLinkSchema.parse(input);
  const link = await getLink(ctx, id);
  await assertMayReview(ctx, link);
  const [row] = await ctx.tx.update(evidenceLink).set({ reviewStatus: d.decision, reviewedBy: ctx.caller.userId, reviewedAt: new Date(), reviewComment: d.comment ?? null })
    .where(eq(evidenceLink.id, id)).returning();
  const dto = (await describeLinks(ctx, [row!]))[0]!;
  if (row!.linkedBy && row!.linkedBy !== ctx.caller.userId) {
    const what = `${dto.evidenceTitle} to ${targetLabel(dto.target)}`;
    await createNotification(ctx, d.decision === 'rejected'
      ? { userId: row!.linkedBy, kind: 'link_rejected', title: 'Your link was rejected', body: `Your link of ${what} was rejected: ${d.comment}`, refKind: 'evidence_link', refId: id }
      : { userId: row!.linkedBy, kind: 'link_approved', title: 'Your link was approved', body: `Your link of ${what} was approved${d.comment ? `: ${d.comment}` : '.'}`, refKind: 'evidence_link', refId: id });
  }
  return dto;
}

/**
 * The proposer answers a rejection: the link goes back to review (proposed) with a new reason and no decision on it; the audit
 * trail keeps the rejected state and its reason. Only the person who made the link, and only while it is rejected.
 */
export async function resubmitLink(ctx: Ctx, id: string, input: ResubmitLink): Promise<EvidenceLink> {
  assertHuman(ctx);
  const d = ResubmitLinkSchema.parse(input);
  const link = await getLink(ctx, id);
  if (!ctx.caller.userId || link.linkedBy !== ctx.caller.userId) throw new ForbiddenError('only the person who proposed this link can resubmit it');
  if (link.reviewStatus !== 'rejected') throw new ConflictError('only a rejected link can be resubmitted');
  if (link.engagementRequirementId) {
    const { e } = await engagementOf(ctx, link.engagementRequirementId);
    await assertPermitted(ctx, 'engagement:work', { type: 'engagement', id: e.id });
  } else await assertPermitted(ctx, 'evidence:write', any);
  const [row] = await ctx.tx.update(evidenceLink).set({ reviewStatus: 'proposed', rationale: d.rationale, reviewedBy: null, reviewedAt: null, reviewComment: null })
    .where(eq(evidenceLink.id, id)).returning();
  await dismissFor(ctx, 'evidence_link', id);
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
  const [d] = await describeLinks(ctx, [link]);
  const [raw] = await readRows(ctx, 'evidence_link', [id]);
  // The link goes to the Trash (restorable for 30 days); the evidence itself is never deleted.
  await trashEvidenceLink(ctx, raw!, { text: d ? `${d.evidenceTitle} → ${d.target.code}` : 'Evidence link', place: d?.target.engagementTitle ?? (d?.target.kind === 'external' ? d.target.frameworkLabel ?? 'Standard' : 'Internal quality framework') });
}

export async function linksForEngagementRequirement(ctx: Ctx, engagementRequirementId: string): Promise<EvidenceLink[]> {
  await assertPermitted(ctx, 'evidence:read', any);
  await engagementOf(ctx, engagementRequirementId);
  const rows = await ctx.tx.select().from(evidenceLink).where(eq(evidenceLink.engagementRequirementId, engagementRequirementId)).orderBy(desc(evidenceLink.createdAt));
  return describeLinks(ctx, rows);
}

/** Evidence linked directly to a requirement of any standard (by its framework and code). */
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

const CONTEXT_LIST = 5;

/**
 * What every requirement of an external standard holds, in one answer for the whole version (the hover card reads it once
 * rather than asking per row): the IQF items it is mapped to (proposed or approved), the evidence linked on those items
 * through APPROVED mappings (inherited, collected once), and the evidence linked to the requirement itself. Keyed by the
 * requirement's code. The effective evidence of a requirement is the direct links plus the inherited ones. Evidence parts
 * are left empty for a caller who cannot read evidence.
 */
export async function requirementContexts(ctx: Ctx, versionId: string): Promise<RequirementContexts> {
  await require_(ctx, 'framework:read');
  const v = await getVersion(ctx, versionId);
  const codes = (await ctx.tx.select({ code: requirement.code }).from(requirement).where(eq(requirement.frameworkVersionId, versionId))).map((r) => r.code);
  const byCode: Record<string, RequirementContext> = {};
  const assigned = await loadAssignments(ctx, versionId);
  const planned = await loadPlanAssignments(ctx, versionId);
  for (const code of codes) byCode[code] = { mappings: [], inherited: [], inheritedCount: 0, direct: [], directCount: 0, ...(assigned.has(code) ? { scope: assigned.get(code)!.scope, champion: assigned.get(code)!.champion } : {}), ...(planned.has(code) ? { plans: planned.get(code)! } : {}) };
  const maps = (await ctx.tx.select().from(requirementMapping).where(eq(requirementMapping.frameworkId, v.frameworkId)))
    .filter((m) => m.reviewStatus !== 'rejected' && byCode[m.externalCode]);
  const titles = new Map<string, Map<string, string>>();
  for (const id of new Set(maps.map((m) => m.internalFrameworkId))) titles.set(id, await titlesByCode(ctx, id));
  for (const m of maps.sort((a, b) => a.internalCode.localeCompare(b.internalCode, undefined, { numeric: true }))) {
    byCode[m.externalCode]!.mappings.push({
      id: m.id, internalCode: m.internalCode, internalTitle: titles.get(m.internalFrameworkId)?.get(m.internalCode) ?? null, relation: m.relation, reviewStatus: m.reviewStatus,
    });
  }
  if (!(await isPermitted(ctx.tx, 'evidence:read', any))) return { byCode };

  const direct = await ctx.tx.select({ l: evidenceLink, v: evidenceVersion, i: evidenceItem }).from(evidenceLink)
    .innerJoin(evidenceVersion, eq(evidenceVersion.id, evidenceLink.evidenceVersionId)).innerJoin(evidenceItem, eq(evidenceItem.id, evidenceVersion.evidenceItemId))
    .where(and(eq(evidenceLink.internalFrameworkId, v.frameworkId), isNull(evidenceLink.engagementRequirementId), sql`${evidenceLink.reviewStatus} <> 'rejected'`));
  const directVersions = new Map<string, Set<string>>();
  for (const { l, v: ver, i } of direct.sort((a, b) => b.l.createdAt.getTime() - a.l.createdAt.getTime())) {
    const ctxOf = byCode[l.internalCode!];
    if (!ctxOf) continue;
    ctxOf.directCount += 1;
    if (ctxOf.direct.length < CONTEXT_LIST) ctxOf.direct.push({ evidenceItemId: i.id, title: i.title, versionNo: ver.versionNo, periodLabel: i.periodLabel, reviewStatus: l.reviewStatus });
    if (!directVersions.has(l.internalCode!)) directVersions.set(l.internalCode!, new Set());
    directVersions.get(l.internalCode!)!.add(ver.id);
  }

  const approved = maps.filter((m) => m.reviewStatus === 'approved');
  if (!approved.length) return { byCode };
  const onItems = await ctx.tx.select({ l: evidenceLink, v: evidenceVersion, i: evidenceItem }).from(evidenceLink)
    .innerJoin(evidenceVersion, eq(evidenceVersion.id, evidenceLink.evidenceVersionId)).innerJoin(evidenceItem, eq(evidenceItem.id, evidenceVersion.evidenceItemId))
    .where(and(eq(evidenceLink.reviewStatus, 'approved'), isNull(evidenceLink.engagementRequirementId),
      inArray(evidenceLink.internalFrameworkId, [...new Set(approved.map((m) => m.internalFrameworkId))]),
      inArray(evidenceLink.internalCode, [...new Set(approved.map((m) => m.internalCode))])));
  for (const code of codes) {
    const seen = new Set(directVersions.get(code) ?? []);
    const mine = approved.filter((m) => m.externalCode === code);
    const found: (RequirementContext['inherited'][number])[] = [];
    for (const m of mine) {
      for (const { l, v: ver, i } of onItems) {
        if (l.internalFrameworkId !== m.internalFrameworkId || l.internalCode !== m.internalCode || i.status === 'archived' || seen.has(ver.id)) continue;
        seen.add(ver.id);
        found.push({ evidenceItemId: i.id, title: i.title, versionNo: ver.versionNo, periodLabel: i.periodLabel, internalCode: m.internalCode });
      }
    }
    found.sort((a, b) => a.internalCode.localeCompare(b.internalCode, undefined, { numeric: true }) || a.title.localeCompare(b.title));
    byCode[code]!.inheritedCount = found.length;
    byCode[code]!.inherited = found.slice(0, CONTEXT_LIST);
  }
  return { byCode };
}
