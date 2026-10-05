import { and, asc, eq } from 'drizzle-orm';
import { sourceDocument, sourcePage } from '@ams/db';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ValidationError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
import { getDraftVersion, getSourceDocument, require_ } from './common.js';

export const AddSourceDocumentSchema = z.object({
  versionId: z.uuid(),
  title: z.string().trim().min(1),
  role: z.enum(['standards', 'policy_procedure', 'guidance', 'report_template', 'evidence_guidance', 'amendment', 'sample_report', 'correspondence', 'other']),
  authority: z.enum(['binding', 'interpretive', 'informational']),
  language: z.string().min(2).default('en'),
  filePath: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, '64 lowercase hex characters'),
});

/** Registers a source document of a draft version. File upload and text extraction arrive with M7. */
export async function addSourceDocument(ctx: Ctx, input: z.input<typeof AddSourceDocumentSchema>) {
  await require_(ctx, 'framework:write');
  const data = AddSourceDocumentSchema.parse(input);
  await getDraftVersion(ctx, data.versionId);
  const { versionId, ...rest } = data;
  const [row] = await guardIntegrity(() => ctx.tx.insert(sourceDocument).values({ ...rest, frameworkVersionId: versionId, institutionId: ctx.caller.institutionId }).returning());
  return row!;
}

/** Stores the text of one page as transcribed or extracted; quote verification reads exactly this text. */
export async function addSourcePage(ctx: Ctx, input: { documentId: string; pageNo: number; text: string; method: 'pdf_text' | 'ocr' }) {
  await require_(ctx, 'framework:write');
  const doc = await getSourceDocument(ctx, input.documentId);
  await getDraftVersion(ctx, doc.frameworkVersionId);
  if (!input.text.trim()) throw new ValidationError('page text is empty');
  const [row] = await guardIntegrity(() => ctx.tx.insert(sourcePage).values({
    institutionId: ctx.caller.institutionId, sourceDocumentId: doc.id, pageNo: input.pageNo, text: input.text, method: input.method,
  }).returning());
  return row!;
}

export async function listSourceDocuments(ctx: Ctx, versionId: string) {
  await require_(ctx, 'framework:read');
  return ctx.tx.select().from(sourceDocument).where(eq(sourceDocument.frameworkVersionId, versionId)).orderBy(asc(sourceDocument.title));
}

export async function getSourcePage(ctx: Ctx, documentId: string, pageNo: number) {
  await require_(ctx, 'framework:read');
  const [row] = await ctx.tx.select().from(sourcePage).where(and(eq(sourcePage.sourceDocumentId, documentId), eq(sourcePage.pageNo, pageNo)));
  return row ?? null;
}
