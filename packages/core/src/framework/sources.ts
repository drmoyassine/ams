import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { requirement, requirementNote, sourceDocument, sourcePage } from '@ams/db';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
import { getDraftVersion, getSourceDocument, require_ } from './common.js';

export const AddSourceDocumentSchema = z.object({
  versionId: z.uuid(),
  title: z.string().trim().min(1),
  role: z.enum(['standards', 'policy_procedure', 'guidance', 'report_template', 'evidence_guidance', 'amendment', 'sample_report', 'correspondence', 'other']),
  authority: z.enum(['binding', 'interpretive', 'informational']),
  language: z.string().min(2).default('en'),
  /** Set by an import that already holds the file; otherwise the document starts without one and a file can be uploaded. */
  filePath: z.string().min(1).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, '64 lowercase hex characters').optional(),
});

/** Registers a source document of a draft version. The original can be uploaded to it; reading its text arrives with M7. */
export async function addSourceDocument(ctx: Ctx, input: z.input<typeof AddSourceDocumentSchema>) {
  await require_(ctx, 'framework:write');
  const data = AddSourceDocumentSchema.parse(input);
  await getDraftVersion(ctx, data.versionId);
  const { versionId, ...given } = data;
  const rest = { ...given, filePath: given.filePath ?? `manual/${crypto.randomUUID()}`, sha256: given.sha256 ?? createHash('sha256').update(given.title).digest('hex') };
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

/** A version's sources, each with the number of pages whose text is stored and whether its original file is held. */
export async function listSourceDocuments(ctx: Ctx, versionId: string) {
  await require_(ctx, 'framework:read');
  const rows = await ctx.tx.select({
    d: sourceDocument, pages: sql<number>`(select count(*)::int from source_page p where p.source_document_id = source_document.id)`,
  }).from(sourceDocument).where(eq(sourceDocument.frameworkVersionId, versionId)).orderBy(asc(sourceDocument.title));
  return rows.map(({ d, pages }) => ({ ...d, pageCount: Math.max(pages, d.pageCount ?? 0), storedPages: pages, hasFile: !!d.fileName }));
}

export const UpdateSourceDocumentSchema = AddSourceDocumentSchema.pick({ title: true, role: true, authority: true }).partial()
  .extend({ language: z.string().min(2).optional() }).strict();

/** Changes how a draft version's source is described. */
export async function updateSourceDocument(ctx: Ctx, id: string, input: z.input<typeof UpdateSourceDocumentSchema>) {
  await require_(ctx, 'framework:write');
  const doc = await getSourceDocument(ctx, id);
  await getDraftVersion(ctx, doc.frameworkVersionId);
  const d = UpdateSourceDocumentSchema.parse(input);
  const [row] = await guardIntegrity(() => ctx.tx.update(sourceDocument).set(d).where(eq(sourceDocument.id, id)).returning());
  return row!;
}

/** Removes a draft version's source and its pages, unless a requirement or note cites it. */
export async function deleteSourceDocument(ctx: Ctx, id: string) {
  await require_(ctx, 'framework:write');
  const doc = await getSourceDocument(ctx, id);
  await getDraftVersion(ctx, doc.frameworkVersionId);
  const [cited] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(requirementNote).where(eq(requirementNote.sourceDocumentId, id));
  const [citedReq] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(requirement).where(eq(requirement.sourceDocumentId, id));
  const n = (cited?.n ?? 0) + (citedReq?.n ?? 0);
  if (n) throw new ConflictError(`${n} requirement${n === 1 ? ' or note cites' : 's or notes cite'} this source; remove those citations first`);
  await ctx.tx.delete(sourcePage).where(eq(sourcePage.sourceDocumentId, id));
  await guardIntegrity(() => ctx.tx.delete(sourceDocument).where(eq(sourceDocument.id, id)));
}

/** Every stored page of a source, in order. */
export async function listSourcePages(ctx: Ctx, documentId: string) {
  await require_(ctx, 'framework:read');
  await getSourceDocument(ctx, documentId);
  return ctx.tx.select().from(sourcePage).where(eq(sourcePage.sourceDocumentId, documentId)).orderBy(asc(sourcePage.pageNo));
}

/** Sets a page's text on a draft (adds the page or corrects it). Quotes are verified against exactly this text. */
export async function setSourcePage(ctx: Ctx, documentId: string, pageNo: number, text: string) {
  await require_(ctx, 'framework:write');
  const doc = await getSourceDocument(ctx, documentId);
  await getDraftVersion(ctx, doc.frameworkVersionId);
  if (!text.trim()) throw new ValidationError('page text is empty');
  if (!Number.isInteger(pageNo) || pageNo < 1) throw new ValidationError('page numbers start at 1');
  const [row] = await guardIntegrity(() => ctx.tx.insert(sourcePage).values({
    institutionId: ctx.caller.institutionId, sourceDocumentId: documentId, pageNo, text, method: 'pdf_text',
  }).onConflictDoUpdate({ target: [sourcePage.sourceDocumentId, sourcePage.pageNo], set: { text, reviewed: false } }).returning());
  return row!;
}

export async function deleteSourcePage(ctx: Ctx, documentId: string, pageNo: number) {
  await require_(ctx, 'framework:write');
  const doc = await getSourceDocument(ctx, documentId);
  await getDraftVersion(ctx, doc.frameworkVersionId);
  const [cited] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(requirementNote)
    .where(and(eq(requirementNote.sourceDocumentId, documentId), eq(requirementNote.sourcePage, pageNo)));
  if (cited?.n) throw new ConflictError('a note quotes this page; remove that citation first');
  await ctx.tx.delete(sourcePage).where(and(eq(sourcePage.sourceDocumentId, documentId), eq(sourcePage.pageNo, pageNo)));
}

/** Largest original accepted (bytes). */
export const MAX_SOURCE_BYTES = Number(process.env.SOURCE_MAX_UPLOAD_MB ?? 50) * 1024 * 1024;
const safeName = (s: string) => [...s.normalize('NFC')].map((ch) => (ch === '/' || ch === '\\' || ch.charCodeAt(0) < 32 ? '_' : ch)).join('').slice(0, 200) || 'file';

/** Stores the original file of a draft version's source (a PDF, usually), replacing any earlier one. */
export async function uploadSourceFile(ctx: Ctx, documentId: string, file: { fileName: string; mime: string; bytes: Uint8Array }) {
  await require_(ctx, 'framework:write');
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  const doc = await getSourceDocument(ctx, documentId);
  await getDraftVersion(ctx, doc.frameworkVersionId);
  if (!file.bytes.byteLength) throw new ValidationError('the file is empty');
  if (file.bytes.byteLength > MAX_SOURCE_BYTES) throw new ValidationError(`the file is larger than ${Math.round(MAX_SOURCE_BYTES / 1048576)} MB`);
  const fileName = safeName(file.fileName);
  const key = `${ctx.caller.institutionId}/sources/${documentId}/${crypto.randomUUID()}/${fileName}`;
  let stored: { size: number; sha256: string };
  try { stored = await ctx.store.put(key, file.bytes, file.mime || 'application/octet-stream'); } catch (e) {
    throw new ConflictError(`the file could not be stored (${(e as Error).message})`);
  }
  const [row] = await ctx.tx.update(sourceDocument).set({ filePath: key, sha256: stored.sha256, fileName, mime: file.mime || 'application/octet-stream', size: stored.size })
    .where(eq(sourceDocument.id, documentId)).returning();
  return row!;
}

/** The original file of a source, to view or download. */
export async function readSourceFile(ctx: Ctx, documentId: string) {
  await require_(ctx, 'framework:read');
  const doc = await getSourceDocument(ctx, documentId);
  if (!doc.fileName) throw new NotFoundError('no file has been uploaded for this source');
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  const obj = await ctx.store.get(doc.filePath);
  if (!obj) throw new NotFoundError('the stored file is missing');
  return { bytes: obj.body, mime: doc.mime ?? obj.mime, fileName: doc.fileName };
}

export async function getSourcePage(ctx: Ctx, documentId: string, pageNo: number) {
  await require_(ctx, 'framework:read');
  const [row] = await ctx.tx.select().from(sourcePage).where(and(eq(sourcePage.sourceDocumentId, documentId), eq(sourcePage.pageNo, pageNo)));
  return row ?? null;
}
