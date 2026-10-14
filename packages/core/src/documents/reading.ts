// Reading an uploaded document (`import_document`) into pages: the parser service's `extract_text` job with an
// `importDocumentId` payload. Same parseDocument() as the standards' sources, same OCR hook and cap (Settings -> AI -> Reading).
// The worker's role may set the read status and write the pages of a document; it cannot create or delete one.
import { and, eq, gt, sql } from 'drizzle-orm';
import { importDocument, importPage } from '@ams/db';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError } from '../ctx.js';
import { parseDocument, type OcrPageHook, type ParserInfo } from '../framework/parse-document.js';

const PayloadSchema = z.object({ importDocumentId: z.uuid() });

/**
 * The version of the OCR prompt (`ocr`) a page of this document is read with: a picture of an org chart is written down as an
 * indented outline (v2, TASK-073) so its boxes and lines survive as text the import can cite; everything else is v1.
 */
export async function ocrPromptVersionFor(ctx: Ctx, payload: Record<string, unknown>): Promise<string> {
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) return 'v1';
  const [doc] = await ctx.tx.select({ scopeKind: importDocument.scopeKind }).from(importDocument).where(eq(importDocument.id, parsed.data.importDocumentId));
  return doc?.scopeKind === 'org_chart' ? 'v2' : 'v1';
}
const BATCH = 200;

export interface ExtractImportTextResult {
  ok: boolean;
  error?: string;
  format?: string;
  pages?: number;
  written?: number;
  needsOcr?: number;
  parser?: ParserInfo;
  warnings?: string[];
}

/** The stored original of an import document, without a permission check: the worker acts for the person who queued the job. */
async function loadImportFile(ctx: Ctx, id: string) {
  const [doc] = await ctx.tx.select().from(importDocument).where(eq(importDocument.id, id));
  if (!doc) throw new NotFoundError(`document ${id}`);
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  const obj = await ctx.store.get(doc.filePath);
  if (!obj) throw new NotFoundError('the stored file is missing');
  return { doc, bytes: obj.body, mime: doc.mime, fileName: doc.fileName };
}

/**
 * The `extract_text` job for an import document: reads the file with parseDocument(), replaces its pages, flags pages that need
 * OCR and sets the read status. A file that cannot be read is a result ("failed" with the reason), not a crash.
 */
export async function extractImportText(
  ctx: Ctx, payload: Record<string, unknown>,
  opts: { ocrPage?: OcrPageHook; ocrMaxPages?: number; ocrLanguage?: string | null; notes?: string[] } = {},
): Promise<ExtractImportTextResult> {
  const { importDocumentId: id } = PayloadSchema.parse(payload);
  const [exists] = await ctx.tx.select({ id: importDocument.id }).from(importDocument).where(eq(importDocument.id, id));
  if (!exists) return { ok: false, error: 'the document was deleted before it could be read' };
  // Show "Reading" at once (its own transaction), so the list does not say "waiting" for the whole parse.
  await ctx.detached?.((c) => c.tx.update(importDocument).set({ readStatus: 'reading', readError: null }).where(eq(importDocument.id, id)));
  const fail = async (error: string): Promise<ExtractImportTextResult> => {
    await ctx.tx.update(importDocument).set({ readStatus: 'failed', readError: error.slice(0, 500) }).where(eq(importDocument.id, id));
    return { ok: false, error };
  };
  try {
    return await readInto(ctx, id, opts, fail);
  } catch (e) {
    // An unexpected failure rolls this job back, and the "Reading" the list showed with it; say so in its own transaction.
    await ctx.detached?.((c) => c.tx.update(importDocument).set({ readStatus: 'failed', readError: String((e as Error).message).slice(0, 500) }).where(eq(importDocument.id, id)));
    throw e;
  }
}

async function readInto(
  ctx: Ctx, id: string, opts: { ocrPage?: OcrPageHook; ocrMaxPages?: number; ocrLanguage?: string | null; notes?: string[] },
  fail: (error: string) => Promise<ExtractImportTextResult>,
): Promise<ExtractImportTextResult> {
  let parsed;
  try {
    const file = await loadImportFile(ctx, id);
    parsed = await parseDocument({
      bytes: file.bytes, mime: file.mime, fileName: file.fileName, language: opts.ocrLanguage || file.doc.language,
      ...(opts.ocrPage ? { ocrPage: opts.ocrPage } : {}), ...(opts.ocrMaxPages !== undefined ? { ocrMaxPages: opts.ocrMaxPages } : {}),
    });
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!parsed.pages.length) return fail(parsed.warnings[0] ?? 'the file has no pages to read');

  let written = 0;
  for (let i = 0; i < parsed.pages.length; i += BATCH) {
    const rows = parsed.pages.slice(i, i + BATCH).map((p) => ({
      institutionId: ctx.caller.institutionId, importDocumentId: id, pageNo: p.pageNo, text: p.text, method: p.method, needsOcr: p.needsOcr, warnings: p.warnings,
    }));
    const done = await ctx.tx.insert(importPage).values(rows).onConflictDoUpdate({
      target: [importPage.importDocumentId, importPage.pageNo],
      set: { text: sql`excluded.text`, method: sql`excluded.method`, needsOcr: sql`excluded.needs_ocr`, warnings: sql`excluded.warnings` },
    }).returning({ pageNo: importPage.pageNo });
    written += done.length;
  }
  // A shorter file than before: the pages past its end are gone.
  await ctx.tx.delete(importPage).where(and(eq(importPage.importDocumentId, id), gt(importPage.pageNo, parsed.pages.length)));
  const [{ n: needsOcr } = { n: 0 }] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(importPage)
    .where(and(eq(importPage.importDocumentId, id), eq(importPage.needsOcr, true)));
  await ctx.tx.update(importDocument).set({ pageCount: parsed.pages.length, readStatus: needsOcr ? 'needs_ocr' : 'read', readError: null }).where(eq(importDocument.id, id));
  const warnings = [...(opts.notes ?? []), ...parsed.warnings, ...parsed.pages.flatMap((p) => p.warnings.map((w) => `page ${p.pageNo}: ${w}`))];
  return { ok: true, format: parsed.format, pages: parsed.pages.length, written, needsOcr, parser: parsed.parser, warnings };
}
