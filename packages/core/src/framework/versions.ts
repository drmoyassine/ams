import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { accreditor, engagement, framework, frameworkVersion, reportTemplate, requirement, requirementMapping, requirementNote } from '@ams/db';
import {
  DecisionVocabSchema, FindingVocabSchema, LevelLabelsSchema, LifecycleTemplateSchema, RatingMethodSchema, ResponseVocabSchema,
  validateFrameworkConfig, type FrameworkConfig,
} from '@ams/shared';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
import { syncLevelTerms } from '../glossary/glossary.js';
import { assertHuman, getDraftVersion, getVersion, isInternalVersion, require_ } from './common.js';

const ROW_META = ['id', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'] as const;
/** A row without its identity and audit stamps, ready to be inserted as a copy. */
function copyable<T extends object>(row: T): Omit<T, (typeof ROW_META)[number]> {
  const out = { ...(row as Record<string, unknown>) };
  for (const k of ROW_META) delete out[k];
  return out as Omit<T, (typeof ROW_META)[number]>;
}

// ---- Accreditors and frameworks ---------------------------------------------------------------

export const CreateAccreditorSchema = z.object({
  name: z.string().trim().min(1),
  shortName: z.string().trim().min(1),
  type: z.enum(['institutional', 'programmatic', 'regulatory']),
  country: z.string().trim().min(1).optional(),
  website: z.url().optional(),
});

export async function createAccreditor(ctx: Ctx, input: z.infer<typeof CreateAccreditorSchema>) {
  await require_(ctx, 'framework:write');
  const [row] = await guardIntegrity(() => ctx.tx.insert(accreditor).values({ ...CreateAccreditorSchema.parse(input), institutionId: ctx.caller.institutionId }).returning());
  return row!;
}

export const CreateFrameworkSchema = z.object({
  accreditorId: z.uuid(),
  name: z.string().trim().min(1),
  commission: z.string().trim().min(1).optional(),
  scope: z.enum(['institution', 'program', 'both']),
  description: z.string().optional(),
});

export async function createFramework(ctx: Ctx, input: z.infer<typeof CreateFrameworkSchema>) {
  await require_(ctx, 'framework:write');
  const data = CreateFrameworkSchema.parse(input);
  const [row] = await guardIntegrity(() => ctx.tx.insert(framework).values({ ...data, institutionId: ctx.caller.institutionId }).returning());
  return row!;
}

/**
 * The accreditors' standards for the External Standards page: each with its accreditor (and logo), and every version with
 * how many requirements it has, how many of the assessable ones are mapped (approved mapping) to the institution's own
 * standards, and how many engagements use it.
 */
export async function listFrameworks(ctx: Ctx, opts: { id?: string } = {}) {
  await require_(ctx, 'framework:read');
  const rows = await ctx.tx.select({
    id: framework.id, name: framework.name, scope: framework.scope, commission: framework.commission, description: framework.description,
    accreditorId: accreditor.id, accreditorShortName: accreditor.shortName, accreditorName: accreditor.name, accreditorType: accreditor.type,
    accreditorCountry: accreditor.country, accreditorWebsite: accreditor.website,
    logoUpdatedAt: accreditor.logoUpdatedAt, hasLogo: sql<boolean>`${accreditor.logoPath} is not null`,
  }).from(framework).innerJoin(accreditor, eq(accreditor.id, framework.accreditorId)).where(and(eq(framework.internal, false), opts.id ? eq(framework.id, opts.id) : undefined)).orderBy(asc(accreditor.shortName), asc(framework.name));
  if (!rows.length) return [];
  const versions = await ctx.tx.select({
    id: frameworkVersion.id, frameworkId: frameworkVersion.frameworkId, edition: frameworkVersion.edition, status: frameworkVersion.status,
    publishedAt: frameworkVersion.publishedAt, effectiveFrom: frameworkVersion.effectiveFrom, supersedesId: frameworkVersion.supersedesId,
  }).from(frameworkVersion).where(inArray(frameworkVersion.frameworkId, rows.map((r) => r.id))).orderBy(asc(frameworkVersion.edition));
  const ids = versions.map((v) => v.id);
  const counts = new Map<string, { total: number; assessable: number }>();
  const mapped = new Map<string, number>();
  const engagements = new Map<string, number>();
  if (ids.length) {
    for (const c of await ctx.tx.select({
      v: requirement.frameworkVersionId, total: sql<number>`count(*)::int`, assessable: sql<number>`count(*) filter (where ${requirement.isAssessable})::int`,
    }).from(requirement).where(inArray(requirement.frameworkVersionId, ids)).groupBy(requirement.frameworkVersionId)) counts.set(c.v, { total: c.total, assessable: c.assessable });
    for (const m of await ctx.tx.select({ v: requirement.frameworkVersionId, n: sql<number>`count(distinct ${requirement.id})::int` }).from(requirement)
      .innerJoin(frameworkVersion, eq(frameworkVersion.id, requirement.frameworkVersionId))
      .innerJoin(requirementMapping, and(eq(requirementMapping.frameworkId, frameworkVersion.frameworkId), eq(requirementMapping.externalCode, requirement.code), eq(requirementMapping.reviewStatus, 'approved')))
      .where(and(inArray(requirement.frameworkVersionId, ids), eq(requirement.isAssessable, true))).groupBy(requirement.frameworkVersionId)) mapped.set(m.v, m.n);
    for (const e of await ctx.tx.select({ v: engagement.frameworkVersionId, n: sql<number>`count(*)::int` }).from(engagement)
      .where(inArray(engagement.frameworkVersionId, ids)).groupBy(engagement.frameworkVersionId)) engagements.set(e.v, e.n);
  }
  return rows.map(({ logoUpdatedAt, hasLogo, ...r }) => ({
    ...r,
    logoVersion: hasLogo && logoUpdatedAt ? String(logoUpdatedAt.getTime()) : null,
    versions: versions.filter((v) => v.frameworkId === r.id).map((v) => ({
      id: v.id, edition: v.edition, status: v.status, publishedAt: v.publishedAt?.toISOString() ?? null, effectiveFrom: v.effectiveFrom, supersedesId: v.supersedesId,
      requirementCount: counts.get(v.id)?.total ?? 0, assessableCount: counts.get(v.id)?.assessable ?? 0, mappedCount: mapped.get(v.id) ?? 0, engagementCount: engagements.get(v.id) ?? 0,
    })),
  }));
}

/** One accreditor's standard, as on the External Standards page, with its description and the accreditor's contact details. */
export async function getFramework(ctx: Ctx, id: string) {
  const [row] = await listFrameworks(ctx, { id });
  if (!row) throw new NotFoundError(`standard ${id}`);
  return row;
}

export const UpdateFrameworkSchema = z.object({
  name: z.string().trim().min(1, 'give the standard a name').optional(),
  scope: z.enum(['institution', 'program', 'both']).optional(),
  commission: z.string().trim().min(1).nullable().optional(),
  description: z.string().trim().min(1).nullable().optional(),
}).strict();

/**
 * Edits what describes a standard (its name, scope, description). These belong to the standard, not to a version, so
 * they can change while its versions are published; the requirements themselves cannot.
 */
export async function updateFramework(ctx: Ctx, id: string, input: z.input<typeof UpdateFrameworkSchema>) {
  await require_(ctx, 'framework:write');
  const d = UpdateFrameworkSchema.parse(input);
  const [f] = await ctx.tx.select({ internal: framework.internal }).from(framework).where(eq(framework.id, id));
  if (!f) throw new NotFoundError(`standard ${id}`);
  if (f.internal) throw new ConflictError('the internal quality framework is edited in Settings → Internal Quality Framework');
  await guardIntegrity(() => ctx.tx.update(framework).set(d).where(eq(framework.id, id)));
  return getFramework(ctx, id);
}

export const UpdateAccreditorSchema = z.object({
  name: z.string().trim().min(1, 'give the accreditor a name').optional(),
  shortName: z.string().trim().min(1, 'give a short name').optional(),
  type: z.enum(['institutional', 'programmatic', 'regulatory']).optional(),
  country: z.string().trim().min(1).nullable().optional(),
  website: z.url('enter a web address').nullable().optional(),
}).strict();

export async function updateAccreditor(ctx: Ctx, id: string, input: z.input<typeof UpdateAccreditorSchema>) {
  await require_(ctx, 'framework:write');
  const d = UpdateAccreditorSchema.parse(input);
  const [row] = await guardIntegrity(() => ctx.tx.update(accreditor).set(d).where(eq(accreditor.id, id)).returning());
  if (!row) throw new NotFoundError(`accreditor ${id}`);
  return row;
}

// ---- Versions ------------------------------------------------------------------------------------

export const CreateVersionSchema = z.object({
  frameworkId: z.uuid(),
  edition: z.string().trim().min(1),
  effectiveFrom: z.iso.date().optional(),
  effectiveTo: z.iso.date().optional(),
  changeSummary: z.string().optional(),
});

export async function createVersion(ctx: Ctx, input: z.infer<typeof CreateVersionSchema>) {
  await require_(ctx, 'framework:write');
  const data = CreateVersionSchema.parse(input);
  const [row] = await guardIntegrity(() => ctx.tx.insert(frameworkVersion).values({ ...data, institutionId: ctx.caller.institutionId }).returning());
  return row!;
}

export async function listVersions(ctx: Ctx, frameworkId: string) {
  await require_(ctx, 'framework:read');
  return ctx.tx.select().from(frameworkVersion).where(eq(frameworkVersion.frameworkId, frameworkId)).orderBy(asc(frameworkVersion.edition));
}

export async function getVersionDetail(ctx: Ctx, id: string) {
  await require_(ctx, 'framework:read');
  const v = await getVersion(ctx, id);
  return { ...v, internal: await isInternalVersion(ctx, id) };
}

const ConfigPatchSchema = z.object({
  levelLabels: LevelLabelsSchema.optional(),
  lifecycleTemplate: LifecycleTemplateSchema.optional(),
  decisionVocab: DecisionVocabSchema.optional(),
  findingVocab: FindingVocabSchema.optional(),
  responseVocab: ResponseVocabSchema.optional(),
  ratingMethod: RatingMethodSchema.optional(),
  effectiveFrom: z.iso.date().nullable().optional(),
  effectiveTo: z.iso.date().nullable().optional(),
  changeSummary: z.string().nullable().optional(),
}).strict();

/** Saves configuration fields of a draft version. Each field is validated alone; references are checked on submit. */
export async function updateVersionConfig(ctx: Ctx, versionId: string, patch: z.input<typeof ConfigPatchSchema>) {
  await require_(ctx, 'framework:write');
  await getDraftVersion(ctx, versionId);
  const parsed = ConfigPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new ValidationError('invalid configuration', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  const [row] = await guardIntegrity(() => ctx.tx.update(frameworkVersion).set(parsed.data).where(eq(frameworkVersion.id, versionId)).returning());
  if (parsed.data.levelLabels && await isInternalVersion(ctx, versionId)) await syncLevelTerms(ctx);
  return row!;
}

/** The configuration of a version as one object, templates included: what the validators and the exporter see. */
export async function loadConfig(ctx: Ctx, versionId: string): Promise<unknown> {
  const v = await getVersion(ctx, versionId);
  const templates = await ctx.tx.select().from(reportTemplate).where(eq(reportTemplate.frameworkVersionId, versionId)).orderBy(asc(reportTemplate.key));
  return {
    level_labels: v.levelLabels,
    lifecycle_template: v.lifecycleTemplate,
    decision_vocab: v.decisionVocab,
    finding_vocab: v.findingVocab,
    response_vocab: v.responseVocab,
    rating_method: v.ratingMethod,
    report_templates: templates.map((t) => ({
      key: t.key, name: t.name, kind: t.kind, language: t.language, structure: t.structure,
      word_limit: t.wordLimit, requires_attestation: t.requiresAttestation,
    })),
  };
}

export async function validateVersion(ctx: Ctx, versionId: string): Promise<{ ok: true; config?: FrameworkConfig } | { ok: false; issues: { path: string; message: string }[] }> {
  await require_(ctx, 'framework:read');
  if (await isInternalVersion(ctx, versionId)) {
    // The institution's own framework has no accreditor lifecycle, vocabularies or report templates: only its level names.
    const labels = LevelLabelsSchema.safeParse((await getVersion(ctx, versionId)).levelLabels);
    return labels.success ? { ok: true } : { ok: false, issues: [{ path: 'level_labels', message: 'name at least one level, e.g. Standard' }] };
  }
  const raw = await loadConfig(ctx, versionId) as Record<string, unknown>;
  if (raw.rating_method === null) delete raw.rating_method;
  return validateFrameworkConfig(raw);
}

async function assertReady(ctx: Ctx, versionId: string) {
  const result = await validateVersion(ctx, versionId);
  if (!result.ok) throw new ValidationError('the framework configuration is not valid', result.issues);
  const [anyRequirement] = await ctx.tx.select({ id: requirement.id }).from(requirement).where(eq(requirement.frameworkVersionId, versionId)).limit(1);
  if (!anyRequirement) throw new ValidationError('a framework version needs at least one requirement', [{ path: 'requirements', message: 'empty' }]);
}

async function transition(ctx: Ctx, versionId: string, from: string[], to: 'draft' | 'in_review' | 'retired') {
  const v = await getVersion(ctx, versionId);
  if (!from.includes(v.status)) throw new ConflictError(`cannot move a ${v.status} version to ${to}`);
  const [row] = await guardIntegrity(() => ctx.tx.update(frameworkVersion).set({ status: to }).where(eq(frameworkVersion.id, versionId)).returning());
  return row!;
}

export async function submitForReview(ctx: Ctx, versionId: string) {
  await require_(ctx, 'framework:write');
  await assertReady(ctx, versionId);
  return transition(ctx, versionId, ['draft'], 'in_review');
}

export async function returnToDraft(ctx: Ctx, versionId: string) {
  await require_(ctx, 'framework:write');
  return transition(ctx, versionId, ['in_review'], 'draft');
}

/** Only a person with framework:publish (Admin) can publish. The database publish gate has the last word. */
export async function publishVersion(ctx: Ctx, versionId: string) {
  await require_(ctx, 'framework:publish');
  assertHuman(ctx);
  const v = await getVersion(ctx, versionId);
  if (v.status !== 'in_review') throw new ConflictError(`only a version in review can be published (this one is ${v.status})`);
  await assertReady(ctx, versionId);
  const [row] = await guardIntegrity(() => ctx.tx.update(frameworkVersion)
    .set({ status: 'published', publishedAt: new Date(), publishedBy: ctx.caller.userId })
    .where(and(eq(frameworkVersion.id, versionId), eq(frameworkVersion.status, 'in_review'))).returning());
  if (!row) throw new ConflictError('the version changed while publishing');
  return row;
}

export async function retireVersion(ctx: Ctx, versionId: string) {
  await require_(ctx, 'framework:publish');
  assertHuman(ctx);
  return transition(ctx, versionId, ['published'], 'retired');
}

/**
 * Changes after publication need a new version: copy a version into a fresh draft that supersedes it. Requirements keep
 * their structure and approval state; reviewers re-approve what they change.
 */
export async function newVersionFrom(ctx: Ctx, sourceVersionId: string, input: { edition: string; changeSummary?: string }) {
  await require_(ctx, 'framework:write');
  const src = await getVersion(ctx, sourceVersionId);
  const [draft] = await guardIntegrity(() => ctx.tx.insert(frameworkVersion).values({
    institutionId: ctx.caller.institutionId, frameworkId: src.frameworkId, edition: input.edition, changeSummary: input.changeSummary ?? null,
    levelLabels: src.levelLabels, lifecycleTemplate: src.lifecycleTemplate, decisionVocab: src.decisionVocab,
    findingVocab: src.findingVocab, responseVocab: src.responseVocab, ratingMethod: src.ratingMethod, supersedesId: src.id,
  }).returning());
  const target = draft!;

  const reqs = await ctx.tx.select().from(requirement).where(eq(requirement.frameworkVersionId, src.id));
  const idMap = new Map<string, string>();
  // Parents before children so parent_id can point at the new rows.
  const byParent = (parent: string | null) => reqs.filter((r) => (r.parentId ?? null) === parent);
  const copyLevel = async (parent: string | null, newParent: string | null) => {
    for (const r of byParent(parent)) {
      const [copy] = await ctx.tx.insert(requirement).values({ ...copyable(r), frameworkVersionId: target.id, parentId: newParent }).returning();
      idMap.set(r.id, copy!.id);
      await copyLevel(r.id, copy!.id);
    }
  };
  await guardIntegrity(() => copyLevel(null, null));

  if (idMap.size > 0) {
    const notes = await ctx.tx.select().from(requirementNote).where(inArray(requirementNote.requirementId, [...idMap.keys()]));
    for (const n of notes) {
      await ctx.tx.insert(requirementNote).values({ ...copyable(n), requirementId: idMap.get(n.requirementId)! });
    }
  }
  const templates = await ctx.tx.select().from(reportTemplate).where(eq(reportTemplate.frameworkVersionId, src.id));
  for (const t of templates) {
    await ctx.tx.insert(reportTemplate).values({ ...copyable(t), frameworkVersionId: target.id });
  }
  return { version: target, requirementsCopied: idMap.size };
}

