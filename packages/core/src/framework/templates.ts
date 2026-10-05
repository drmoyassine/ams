import { and, eq } from 'drizzle-orm';
import { reportTemplate } from '@ams/db';
import { ReportTemplateConfigSchema } from '@ams/shared';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { NotFoundError, ValidationError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
import { assertHuman, getDraftVersion, require_, unreviewed } from './common.js';

/** Create or replace a report template by key. The structure is validated against the PRD 10.2 schema. */
export async function upsertReportTemplate(ctx: Ctx, versionId: string, input: z.input<typeof ReportTemplateConfigSchema>) {
  await require_(ctx, 'framework:write');
  await getDraftVersion(ctx, versionId);
  const parsed = ReportTemplateConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('invalid report template', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  const t = parsed.data;
  const values = {
    name: t.name, kind: t.kind, language: t.language, structure: t.structure,
    wordLimit: t.word_limit ?? null, requiresAttestation: t.requires_attestation, ...unreviewed,
  };
  const [existing] = await ctx.tx.select({ id: reportTemplate.id }).from(reportTemplate)
    .where(and(eq(reportTemplate.frameworkVersionId, versionId), eq(reportTemplate.key, t.key)));
  const [row] = await guardIntegrity(() => existing
    ? ctx.tx.update(reportTemplate).set(values).where(eq(reportTemplate.id, existing.id)).returning()
    : ctx.tx.insert(reportTemplate).values({ ...values, institutionId: ctx.caller.institutionId, frameworkVersionId: versionId, key: t.key, origin: 'manual' }).returning());
  return row!;
}

export async function listReportTemplates(ctx: Ctx, versionId: string) {
  await require_(ctx, 'framework:read');
  return ctx.tx.select().from(reportTemplate).where(eq(reportTemplate.frameworkVersionId, versionId));
}

async function getTemplate(ctx: Ctx, versionId: string, key: string) {
  const [row] = await ctx.tx.select().from(reportTemplate).where(and(eq(reportTemplate.frameworkVersionId, versionId), eq(reportTemplate.key, key)));
  if (!row) throw new NotFoundError(`report template ${key}`);
  return row;
}

export async function deleteReportTemplate(ctx: Ctx, versionId: string, key: string) {
  await require_(ctx, 'framework:write');
  await getDraftVersion(ctx, versionId);
  const t = await getTemplate(ctx, versionId, key);
  await guardIntegrity(() => ctx.tx.delete(reportTemplate).where(eq(reportTemplate.id, t.id)));
}

export async function reviewReportTemplate(ctx: Ctx, versionId: string, key: string, decision: 'approved' | 'rejected') {
  await require_(ctx, 'framework:review');
  assertHuman(ctx);
  await getDraftVersion(ctx, versionId);
  const t = await getTemplate(ctx, versionId, key);
  const [row] = await ctx.tx.update(reportTemplate)
    .set({ reviewStatus: decision, reviewedBy: ctx.caller.userId, reviewedAt: new Date() })
    .where(eq(reportTemplate.id, t.id)).returning();
  return row!;
}
