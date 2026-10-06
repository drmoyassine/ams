import { and, asc, eq, inArray } from 'drizzle-orm';
import { accreditor, framework, frameworkVersion, reportTemplate, requirement, requirementNote } from '@ams/db';
import {
  DecisionVocabSchema, FindingVocabSchema, LevelLabelsSchema, LifecycleTemplateSchema, RatingMethodSchema, ResponseVocabSchema,
  validateFrameworkConfig, type FrameworkConfig,
} from '@ams/shared';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, ValidationError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
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

export async function listFrameworks(ctx: Ctx) {
  await require_(ctx, 'framework:read');
  return ctx.tx.select({
    id: framework.id, name: framework.name, scope: framework.scope, commission: framework.commission,
    accreditorId: accreditor.id, accreditorShortName: accreditor.shortName,
  }).from(framework).innerJoin(accreditor, eq(accreditor.id, framework.accreditorId)).where(eq(framework.internal, false)).orderBy(asc(accreditor.shortName), asc(framework.name));
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

