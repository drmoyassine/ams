import { asc, eq } from 'drizzle-orm';
import { accreditor, framework, frameworkVersion, requirement } from '@ams/db';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, ValidationError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
import { syncLevelTerms } from '../glossary/glossary.js';
import { getDraftVersion, getRequirement, getVersion, isInternalVersion, require_ } from './common.js';
import { INTERNAL_TEMPLATE } from './internal-template.js';
import { createRequirement, listRequirements, moveRequirement, relabelByDepth } from './requirements.js';

/**
 * The institution's own quality framework (DEC-016) lives in the framework library like any standard, but is owned
 * by the institution and names its own levels. There is at most one per institution (a partial unique index).
 */
export const DEFAULT_INTERNAL_LEVELS = ['Standard', 'Sub-standard'];

export const SetUpQualityFrameworkSchema = z.object({
  name: z.string().trim().min(1).default('Internal Quality Framework'),
  levelLabels: z.array(z.string().trim().min(1)).min(1).default(DEFAULT_INTERNAL_LEVELS),
  /** Start from the generic template rather than an empty tree. */
  template: z.boolean().default(false),
});

export async function getQualityFramework(ctx: Ctx) {
  await require_(ctx, 'framework:read');
  const [fw] = await ctx.tx.select({ id: framework.id, name: framework.name }).from(framework).where(eq(framework.internal, true));
  if (!fw) return { framework: null, versions: [] };
  const versions = await ctx.tx.select().from(frameworkVersion).where(eq(frameworkVersion.frameworkId, fw.id)).orderBy(asc(frameworkVersion.createdAt));
  return { framework: fw, versions };
}

/** Creates the framework and its first draft version, once. */
export async function setUpQualityFramework(ctx: Ctx, input: z.input<typeof SetUpQualityFrameworkSchema> = {}) {
  await require_(ctx, 'framework:write');
  const data = SetUpQualityFrameworkSchema.parse(input);
  const existing = await getQualityFramework(ctx);
  if (existing.framework) throw new ConflictError('the quality framework is already set up');
  const institutionId = ctx.caller.institutionId;
  // The framework table needs an accreditor; the institution stands in for it, and the Standards list never shows it.
  let [own] = await ctx.tx.select({ id: accreditor.id }).from(accreditor).where(eq(accreditor.shortName, 'Internal'));
  if (!own) {
    [own] = await ctx.tx.insert(accreditor).values({ institutionId, name: 'Our institution', shortName: 'Internal', type: 'institutional' }).returning({ id: accreditor.id });
  }
  const [fw] = await guardIntegrity(() => ctx.tx.insert(framework).values({
    institutionId, accreditorId: own!.id, name: data.name, scope: 'both', internal: true,
  }).returning());
  const [version] = await ctx.tx.insert(frameworkVersion).values({
    institutionId, frameworkId: fw!.id, edition: '1', levelLabels: data.levelLabels,
  }).returning();
  await syncLevelTerms(ctx);
  if (data.template) await applyQualityTemplate(ctx, version!.id);
  return { framework: { id: fw!.id, name: fw!.name }, versions: [version!] };
}

/** Sets the level names of the internal quality framework, top first, on its newest version, which must still be a draft. */
export async function setQualityLevels(ctx: Ctx, levelLabels: string[]) {
  await require_(ctx, 'framework:write');
  const labels = z.array(z.string().trim().min(1)).min(1).parse(levelLabels);
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) throw new ValidationError('level names must be different from each other');
  const { versions } = await getQualityFramework(ctx);
  const latest = versions[versions.length - 1];
  if (!latest) throw new ConflictError('set up the quality framework first');
  if (latest.status !== 'draft') throw new ConflictError(`the newest version is ${latest.status.replace('_', ' ')}; create a new version to change the level names`);
  await guardIntegrity(() => ctx.tx.update(frameworkVersion).set({ levelLabels: labels }).where(eq(frameworkVersion.id, latest.id)));
  await relabelByDepth(ctx, latest.id);
  await syncLevelTerms(ctx);
  return getQualityFramework(ctx);
}

async function internalVersion(ctx: Ctx, versionId: string) {
  const v = await getVersion(ctx, versionId);
  if (!(await isInternalVersion(ctx, versionId))) throw new ValidationError('this belongs to the internal quality framework');
  return v;
}

/**
 * Fills an empty draft of the internal framework with the generic starting template (eight areas, each with a few
 * items), numbered 1, 1.1 and so on. Refused once the draft has anything in it, so it never mixes with real content.
 */
export async function applyQualityTemplate(ctx: Ctx, versionId: string) {
  await require_(ctx, 'framework:write');
  await internalVersion(ctx, versionId);
  await getDraftVersion(ctx, versionId);
  if ((await listRequirements(ctx, versionId)).length > 0) throw new ConflictError('the framework already has items; the template only fills an empty one');
  for (const [i, area] of INTERNAL_TEMPLATE.entries()) {
    const top = await createRequirement(ctx, { versionId, code: String(i + 1), levelLabel: 'Level 1', title: area.title, displayOrder: i, isAssessable: false });
    for (const [j, title] of area.children.entries()) {
      await createRequirement(ctx, { versionId, parentId: top.id, code: `${i + 1}.${j + 1}`, levelLabel: 'Level 2', title, displayOrder: j });
    }
  }
  return listRequirements(ctx, versionId);
}

/** Indents a requirement under the sibling just above it; its level (and its subtree's) follows its new depth. */
export async function indentRequirement(ctx: Ctx, id: string) {
  await require_(ctx, 'framework:write');
  const r = await getRequirement(ctx, id);
  await internalVersion(ctx, r.frameworkVersionId);
  await getDraftVersion(ctx, r.frameworkVersionId);
  const rows = await listRequirements(ctx, r.frameworkVersionId);
  const siblings = rows.filter((x) => (x.parentId ?? null) === (r.parentId ?? null));
  const at = siblings.findIndex((x) => x.id === id);
  if (at <= 0) throw new ConflictError('there is nothing above it to indent under');
  const newParent = siblings[at - 1]!;
  const lastChild = rows.filter((x) => x.parentId === newParent.id).reduce((m, x) => Math.max(m, x.displayOrder), -1);
  await moveRequirement(ctx, id, newParent.id, lastChild + 1);
  return getRequirement(ctx, id);
}

/** Outdents a requirement to sit just after its parent; its level (and its subtree's) follows its new depth. */
export async function outdentRequirement(ctx: Ctx, id: string) {
  await require_(ctx, 'framework:write');
  const r = await getRequirement(ctx, id);
  await internalVersion(ctx, r.frameworkVersionId);
  await getDraftVersion(ctx, r.frameworkVersionId);
  if (!r.parentId) throw new ConflictError('it is already at the top level');
  const parent = await getRequirement(ctx, r.parentId);
  // Make room right after the parent among its siblings, then move there.
  const rows = await listRequirements(ctx, r.frameworkVersionId);
  for (const x of rows.filter((y) => (y.parentId ?? null) === (parent.parentId ?? null) && y.displayOrder > parent.displayOrder)) {
    await ctx.tx.update(requirement).set({ displayOrder: x.displayOrder + 1 }).where(eq(requirement.id, x.id));
  }
  await moveRequirement(ctx, id, parent.parentId ?? null, parent.displayOrder + 1);
  return getRequirement(ctx, id);
}
