import { and, asc, eq } from 'drizzle-orm';
import { accreditor, framework, frameworkVersion, requirement } from '@ams/db';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, ValidationError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
import { syncLevelTerms } from '../glossary/glossary.js';
import { require_ } from './common.js';

/**
 * The institution's own quality framework (DEC-016) lives in the framework library like any standard, but is owned
 * by the institution and names its own levels. There is at most one per institution (a partial unique index).
 */
export const DEFAULT_INTERNAL_LEVELS = ['Standard', 'Sub-standard'];

export const SetUpQualityFrameworkSchema = z.object({
  name: z.string().trim().min(1).default('Internal Quality Framework'),
  levelLabels: z.array(z.string().trim().min(1)).min(1).default(DEFAULT_INTERNAL_LEVELS),
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
  return { framework: { id: fw!.id, name: fw!.name }, versions: [version!] };
}

/**
 * Sets the level names of the quality framework, top first, on its newest version, which must still be a draft. A level
 * renamed in place renames what the requirements of that version carry; levels can only be dropped from the bottom, and
 * only when no requirement is at them. The glossary's level terms follow (see `syncLevelTerms`).
 */
export async function setQualityLevels(ctx: Ctx, levelLabels: string[]) {
  await require_(ctx, 'framework:write');
  const labels = z.array(z.string().trim().min(1)).min(1).parse(levelLabels);
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) throw new ValidationError('level names must be different from each other');
  const { versions } = await getQualityFramework(ctx);
  const latest = versions[versions.length - 1];
  if (!latest) throw new ConflictError('set up the quality framework first');
  if (latest.status !== 'draft') throw new ConflictError(`the newest version is ${latest.status.replace('_', ' ')}; create a new version to change the level names`);
  const old = latest.levelLabels as string[];
  for (const gone of old.slice(labels.length)) {
    const [used] = await ctx.tx.select({ id: requirement.id }).from(requirement)
      .where(and(eq(requirement.frameworkVersionId, latest.id), eq(requirement.levelLabel, gone))).limit(1);
    if (used) throw new ConflictError(`"${gone}" is still used by requirements; move or delete them first`);
  }
  // Two passes through a placeholder, so that renaming A to B while B becomes C cannot rename a requirement twice.
  const changed = old.flatMap((from, i) => (labels[i] !== undefined && labels[i] !== from ? [{ from, to: labels[i]!, tmp: `__renaming_${i}__` }] : []));
  const move = (from: string, to: string) => ctx.tx.update(requirement)
    .set({ levelLabel: to, reviewStatus: 'pending', reviewedBy: null, reviewedAt: null })
    .where(and(eq(requirement.frameworkVersionId, latest.id), eq(requirement.levelLabel, from)));
  for (const c of changed) await move(c.from, c.tmp);
  for (const c of changed) await move(c.tmp, c.to);
  await guardIntegrity(() => ctx.tx.update(frameworkVersion).set({ levelLabels: labels }).where(eq(frameworkVersion.id, latest.id)));
  await syncLevelTerms(ctx);
  return getQualityFramework(ctx);
}
