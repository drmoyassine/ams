// Step A of the framework analysis pipeline: reading a source's stored file into per-page text (PRD 15.1 step 3).
// requestTextExtraction() is the service behind "Read this file"; extractText() is the job handler that does the work.
import { and, eq, sql } from 'drizzle-orm';
import { sourceDocument, sourcePage } from '@ams/db';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError } from '../ctx.js';
import { enqueueJob } from '../jobs/jobs.js';
import { getDraftVersion, getSourceDocument, getVersion, require_ } from './common.js';
import { detectFormat, parseDocument, type OcrPageHook } from './parse-document.js';
import { loadSourceFile } from './sources.js';

/** Queues the reading of a draft version's source file. The page text appears when the worker has finished. */
export async function requestTextExtraction(ctx: Ctx, documentId: string) {
  await require_(ctx, 'framework:write');
  const doc = await getSourceDocument(ctx, documentId);
  await getDraftVersion(ctx, doc.frameworkVersionId);
  if (!doc.fileName) throw new ConflictError('upload the file first; there is nothing to read');
  if (!detectFormat({ bytes: new Uint8Array(), fileName: doc.fileName, mime: doc.mime })) {
    throw new ConflictError('this file type cannot be read; use PDF, DOCX, XLSX, PPTX or CSV');
  }
  await ctx.tx.update(sourceDocument).set({ textStatus: 'queued' }).where(eq(sourceDocument.id, documentId));
  const job = await enqueueJob(ctx, { type: 'extract_text', payload: { sourceDocumentId: documentId } });
  return { jobId: job.id, textStatus: 'queued' as const };
}

const PayloadSchema = z.object({ sourceDocumentId: z.uuid() });
const BATCH = 200;

export interface ExtractTextResult {
  ok: boolean;
  error?: string;
  format?: string;
  pages?: number;
  written?: number;
  /** Pages left as they were because a person typed, corrected or reviewed them. */
  keptPages?: number;
  needsOcr?: number;
  warnings?: string[];
}

/**
 * The `extract_text` job: reads the source's stored file with parseDocument(), stores each page's text (never replacing
 * a page a person edited or reviewed), flags pages that need OCR and sets the document's text status.
 * A file that cannot be read is a result ("failed" with the reason), not a crash: trying again would not help.
 */
export async function extractText(
  ctx: Ctx, payload: Record<string, unknown>,
  opts: {
    ocrPage?: OcrPageHook;
    /** Pages of one file the AI may read (Settings -> AI -> Reading); the rest stay flagged needsOcr with a warning. */
    ocrMaxPages?: number;
    /** Settings -> AI language hint; null is Auto: each source's own language. A hint is used for every scanned page. */
    ocrLanguage?: string | null;
    /** Added to the result's warnings, e.g. why scanned pages were not read by the AI. */
    notes?: string[];
  } = {},
): Promise<ExtractTextResult> {
  const { sourceDocumentId: id } = PayloadSchema.parse(payload);
  const doc = await getSourceDocument(ctx, id);
  const fail = async (error: string): Promise<ExtractTextResult> => {
    await ctx.tx.update(sourceDocument).set({ textStatus: 'failed' }).where(eq(sourceDocument.id, id));
    return { ok: false, error };
  };
  const version = await getVersion(ctx, doc.frameworkVersionId);
  if (version.status === 'published' || version.status === 'retired') return fail(`the framework version is ${version.status}; its sources are fixed`);

  let parsed;
  try {
    const file = await loadSourceFile(ctx, id);
    parsed = await parseDocument({
      bytes: file.bytes, mime: file.mime, fileName: file.fileName, language: opts.ocrLanguage || doc.language,
      ...(opts.ocrPage ? { ocrPage: opts.ocrPage } : {}), ...(opts.ocrMaxPages !== undefined ? { ocrMaxPages: opts.ocrMaxPages } : {}),
    });
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!parsed.pages.length) return fail(parsed.warnings[0] ?? 'the file has no pages to read');

  let written = 0;
  for (let i = 0; i < parsed.pages.length; i += BATCH) {
    const rows = parsed.pages.slice(i, i + BATCH).map((p) => ({
      institutionId: ctx.caller.institutionId, sourceDocumentId: id, pageNo: p.pageNo, text: p.text, method: p.method, needsOcr: p.needsOcr, fromFile: true,
    }));
    const done = await ctx.tx.insert(sourcePage).values(rows).onConflictDoUpdate({
      target: [sourcePage.sourceDocumentId, sourcePage.pageNo],
      set: { text: sql`excluded.text`, method: sql`excluded.method`, needsOcr: sql`excluded.needs_ocr`, fromFile: true },
      // Only a page that still holds exactly what an earlier reading wrote: a person's text and reviewed pages stay.
      setWhere: and(eq(sourcePage.fromFile, true), eq(sourcePage.reviewed, false)),
    }).returning({ pageNo: sourcePage.pageNo });
    written += done.length;
  }
  const [{ n: needsOcr } = { n: 0 }] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(sourcePage)
    .where(and(eq(sourcePage.sourceDocumentId, id), eq(sourcePage.needsOcr, true)));
  await ctx.tx.update(sourceDocument).set({ pageCount: parsed.pages.length, textStatus: needsOcr ? 'ocr_needed' : 'extracted' }).where(eq(sourceDocument.id, id));
  const warnings = [...(opts.notes ?? []), ...parsed.warnings, ...parsed.pages.flatMap((p) => p.warnings.map((w) => `page ${p.pageNo}: ${w}`))];
  return { ok: true, format: parsed.format, pages: parsed.pages.length, written, keptPages: parsed.pages.length - written, needsOcr, warnings };
}
