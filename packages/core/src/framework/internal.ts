import { asc, eq } from 'drizzle-orm';
import { accreditor, framework, frameworkVersion } from '@ams/db';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
import { syncLevelTerms } from '../glossary/glossary.js';
import { require_ } from './common.js';

/**
 * The institution's own quality framework (DEC-016) lives in the framework library like any standard, but is owned
 * by the institution and names its own levels. There is at most one per institution (a partial unique index).
 */
export const DEFAULT_INTERNAL_LEVELS = ['Standard', 'Sub-standard'];

export const SetUpQualityFrameworkSchema = z.object({
  name: z.string().trim().min(1).default('Quality framework'),
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
