import { and, desc, eq } from 'drizzle-orm';
import { framework, frameworkVersion, requirement, requirementMapping } from '@ams/db';
import type { CreateMapping, Mapping, Mappings, UpdateMapping } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman, getRequirement, getVersion, isInternalVersion, require_ } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { listRequirements } from '../framework/requirements.js';
import { reportUndo } from '../trash/store.js';
import { trashMapping } from '../trash/delete.js';
import { readRows } from '../trash/rows.js';

/**
 * Mappings from an external standard onto the institution's quality framework (DEC-016). They belong to the
 * institution, not to a published version, and are keyed by requirement code within each framework so they carry over
 * to new versions of either side. A mapping says how much of the external requirement an internal item answers
 * (covers, partly covers, related) and is never "equivalent". A person proposes or edits it; a person approves it.
 */
type Row = typeof requirementMapping.$inferSelect;

async function externalVersion(ctx: Ctx, versionId: string) {
  const v = await getVersion(ctx, versionId);
  if (await isInternalVersion(ctx, versionId)) throw new ValidationError('mappings are made from an external standard, not from the quality framework');
  return v;
}

/** The internal version the choices come from: the latest published one, else the latest draft. */
async function currentInternalVersion(ctx: Ctx) {
  const [fw] = await ctx.tx.select({ id: framework.id }).from(framework).where(eq(framework.internal, true));
  if (!fw) return null;
  const versions = await ctx.tx.select().from(frameworkVersion).where(eq(frameworkVersion.frameworkId, fw.id)).orderBy(desc(frameworkVersion.createdAt));
  return { frameworkId: fw.id, version: versions.find((v) => v.status === 'published') ?? versions[0] ?? null };
}

export async function getMappings(ctx: Ctx, versionId: string): Promise<Mappings> {
  await require_(ctx, 'framework:read');
  const v = await externalVersion(ctx, versionId);
  const internal = await currentInternalVersion(ctx);
  const rows = await ctx.tx.select().from(requirementMapping).where(eq(requirementMapping.frameworkId, v.frameworkId));
  const external = new Map((await ctx.tx.select({ id: requirement.id, code: requirement.code }).from(requirement).where(eq(requirement.frameworkVersionId, versionId))).map((r) => [r.code, r.id]));
  const options = internal?.version ? await listRequirements(ctx, internal.version.id) : [];
  const byCode = new Map(options.map((o) => [o.code, o]));
  const dto = (r: Row): Mapping => ({
    id: r.id, externalCode: r.externalCode, externalRequirementId: external.get(r.externalCode) ?? null,
    internalCode: r.internalCode, internalRequirementId: byCode.get(r.internalCode)?.id ?? null, internalTitle: byCode.get(r.internalCode)?.title ?? null,
    relation: r.relation, rationale: r.rationale, origin: r.origin, reviewStatus: r.reviewStatus,
    stale: !external.has(r.externalCode) || !byCode.has(r.internalCode),
  });
  return {
    internalVersionId: internal?.version?.id ?? null,
    internalOptions: options.map((o) => ({ id: o.id, code: o.code, title: o.title, levelLabel: o.levelLabel, depth: o.depth })),
    mappings: rows.map(dto).sort((a, b) => a.externalCode.localeCompare(b.externalCode) || a.internalCode.localeCompare(b.internalCode)),
  };
}

async function getRow(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(requirementMapping).where(eq(requirementMapping.id, id));
  if (!row) throw new NotFoundError(`mapping ${id}`);
  return row;
}

async function toDto(ctx: Ctx, row: Row, versionId?: string): Promise<Mapping> {
  const all = versionId ? (await getMappings(ctx, versionId)).mappings : null;
  const found = all?.find((m) => m.id === row.id);
  if (found) return found;
  return {
    id: row.id, externalCode: row.externalCode, externalRequirementId: null, internalCode: row.internalCode, internalRequirementId: null, internalTitle: null,
    relation: row.relation, rationale: row.rationale, origin: row.origin, reviewStatus: row.reviewStatus, stale: true,
  };
}

export async function createMapping(ctx: Ctx, versionId: string, input: CreateMapping): Promise<Mapping> {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const v = await externalVersion(ctx, versionId);
  const ext = await getRequirement(ctx, input.externalRequirementId);
  if (ext.frameworkVersionId !== versionId) throw new ValidationError('that requirement belongs to another version');
  const int = await getRequirement(ctx, input.internalRequirementId);
  const [intVersion] = await ctx.tx.select({ frameworkId: frameworkVersion.frameworkId }).from(frameworkVersion).where(eq(frameworkVersion.id, int.frameworkVersionId));
  const [intFw] = await ctx.tx.select({ internal: framework.internal }).from(framework).where(eq(framework.id, intVersion!.frameworkId));
  if (!intFw?.internal) throw new ValidationError('map onto an item of the quality framework');
  const [dup] = await ctx.tx.select({ id: requirementMapping.id }).from(requirementMapping).where(and(
    eq(requirementMapping.frameworkId, v.frameworkId), eq(requirementMapping.externalCode, ext.code), eq(requirementMapping.internalCode, int.code)));
  if (dup) throw new ConflictError('this requirement is already mapped to that item');
  const [row] = await guardIntegrity(() => ctx.tx.insert(requirementMapping).values({
    institutionId: ctx.caller.institutionId, frameworkId: v.frameworkId, externalCode: ext.code, internalFrameworkId: intVersion!.frameworkId,
    internalCode: int.code, relation: input.relation, rationale: input.rationale ?? null, origin: 'manual',
  }).returning());
  reportUndo(ctx, { label: `Linked ${ext.code} to ${int.code}`, method: 'DELETE', path: `/api/mappings/${row!.id}` });
  return toDto(ctx, row!, versionId);
}

/** Any change returns the mapping to review, like an edited requirement. */
export async function updateMapping(ctx: Ctx, id: string, patch: UpdateMapping): Promise<Mapping> {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const prior = await getRow(ctx, id);
  const set: Partial<typeof requirementMapping.$inferInsert> = { reviewStatus: 'pending', reviewedBy: null, reviewedAt: null };
  if (patch.relation !== undefined) set.relation = patch.relation;
  if (patch.rationale !== undefined) set.rationale = patch.rationale || null;
  const [row] = await ctx.tx.update(requirementMapping).set(set).where(eq(requirementMapping.id, id)).returning();
  reportUndo(ctx, { label: `Edited the link ${prior.externalCode} to ${prior.internalCode}`, method: 'PATCH', path: `/api/mappings/${id}`, body: { relation: prior.relation, rationale: prior.rationale } });
  return toDto(ctx, row!);
}

export async function reviewMapping(ctx: Ctx, id: string, decision: 'approved' | 'rejected'): Promise<Mapping> {
  await require_(ctx, 'framework:review');
  assertHuman(ctx);
  await getRow(ctx, id);
  const [row] = await ctx.tx.update(requirementMapping)
    .set({ reviewStatus: decision, reviewedBy: ctx.caller.userId, reviewedAt: new Date() }).where(eq(requirementMapping.id, id)).returning();
  return toDto(ctx, row!);
}

export async function deleteMapping(ctx: Ctx, id: string): Promise<void> {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const row = await getRow(ctx, id);
  const [raw] = await readRows(ctx, 'requirement_mapping', [id]);
  const [fw] = await ctx.tx.select({ name: framework.name }).from(framework).where(eq(framework.id, row.frameworkId));
  await trashMapping(ctx, raw!, { place: fw?.name ?? '', text: `${row.externalCode} → ${row.internalCode}` });
}
