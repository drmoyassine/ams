// Documents of a Docs tab (TASK-075): the registry of uploads (`import_document`) and, through one adapter, the standards' own
// `source_document` rows, in one row shape. Reading a scope's list needs that scope's read permission; uploading, re-reading and
// deleting need its write permission. Actions on adapter rows delegate to the existing source services (nothing is migrated).
// Evidence is NEVER listed or sent here: this module does not touch the evidence tables (DEC-013, DEC-019).
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { appUser, importDocument, importPage, sourceDocument, sourcePage } from '@ams/db';
import {
  documentStatusText, fileKindOf, type DocScopeInfo, type DocStatus, type DocumentFilters, type DocumentList, type DocumentListItem, type DocumentRow,
  type ImportPage, type ImportReadStatus,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { detectFormat, UNSUPPORTED_FILE_MESSAGE } from '../framework/parse-document.js';
import { requestTextExtraction } from '../framework/reading.js';
import { getSourcePageView, type SourcePageView } from '../framework/source-view.js';
import { addSourceDocument, deleteSourceDocument, MAX_SOURCE_BYTES, readSourceFile, safeName, uploadSourceFile } from '../framework/sources.js';
import { locateQuote } from '../framework/quote-match.js';
import { trashImportDocument } from '../trash/delete.js';
import { readRows } from '../trash/rows.js';
import { enqueueJob } from '../jobs/jobs.js';
import { assertCanRead, assertCanWrite, canReadScope, canWriteScope, docScopes, getDocScope, scopeKey } from './scopes.js';

type ImportRow = typeof importDocument.$inferSelect;
type SourceRow = typeof sourceDocument.$inferSelect;

const SOURCE_STATUS: Record<SourceRow['textStatus'], DocStatus> = {
  pending: 'not_read', queued: 'queued', extracted: 'read', ocr_needed: 'needs_ocr', ocr_done: 'read', failed: 'failed',
};

function importRow(d: ImportRow, extra: { pages: number; ocr: number; by: string | null }): DocumentRow {
  const pages = Math.max(extra.pages, d.pageCount ?? 0);
  return {
    id: d.id, source: 'import', scopeKind: d.scopeKind, scopeId: d.scopeId, name: d.fileName, fileName: d.fileName, fileKind: fileKindOf(d.fileName), mime: d.mime, size: d.size,
    pageCount: d.pageCount ?? (extra.pages || null), status: d.readStatus, statusText: documentStatusText(d.readStatus, pages, extra.ocr, d.readError),
    needsOcrPages: extra.ocr, readError: d.readError, language: d.language, rotation: d.rotation, hasFile: true, uploadedBy: d.createdBy, uploadedByName: extra.by,
    uploadedAt: d.createdAt.toISOString(), role: null, roleOrigin: null, authority: null,
  };
}

function sourceRow(d: SourceRow, extra: { pages: number; ocr: number; by: string | null }): DocumentRow {
  const pages = Math.max(extra.pages, d.pageCount ?? 0);
  // A source whose pages were typed in has text without a file: it counts as read.
  const status: DocStatus = SOURCE_STATUS[d.textStatus] === 'not_read' && extra.pages > 0 && !d.fileName ? 'read' : SOURCE_STATUS[d.textStatus];
  return {
    id: d.id, source: 'source', scopeKind: 'framework_version', scopeId: d.frameworkVersionId, name: d.title, fileName: d.fileName, fileKind: fileKindOf(d.fileName ?? d.title),
    mime: d.mime, size: d.size, pageCount: pages || null, status, statusText: documentStatusText(status, pages, extra.ocr), needsOcrPages: extra.ocr,
    readError: status === 'failed' ? 'the file could not be read' : null, language: d.language, rotation: d.rotation, hasFile: !!d.fileName, uploadedBy: d.createdBy, uploadedByName: extra.by,
    uploadedAt: d.createdAt.toISOString(), role: d.roleOrigin === 'unset' ? null : d.role, roleOrigin: d.roleOrigin, authority: d.authority,
  };
}

const pagesStats = (table: 'import_page' | 'source_page') => table === 'import_page'
  ? { pages: sql<number>`(select count(*)::int from import_page p where p.import_document_id = import_document.id)`, ocr: sql<number>`(select count(*)::int from import_page p where p.import_document_id = import_document.id and p.needs_ocr)` }
  : { pages: sql<number>`(select count(*)::int from source_page p where p.source_document_id = source_document.id)`, ocr: sql<number>`(select count(*)::int from source_page p where p.source_document_id = source_document.id and p.needs_ocr)` };

async function importRows(ctx: Ctx, where: ReturnType<typeof and>): Promise<DocumentRow[]> {
  const rows = await ctx.tx.select({ d: importDocument, by: appUser.fullName, ...pagesStats('import_page') }).from(importDocument)
    .leftJoin(appUser, eq(appUser.id, importDocument.createdBy)).where(where).orderBy(desc(importDocument.createdAt), asc(importDocument.fileName));
  return rows.map((r) => importRow(r.d, { pages: r.pages, ocr: r.ocr, by: r.by }));
}

async function sourceRows(ctx: Ctx, where: ReturnType<typeof and>): Promise<DocumentRow[]> {
  const rows = await ctx.tx.select({ d: sourceDocument, by: appUser.fullName, ...pagesStats('source_page') }).from(sourceDocument)
    .leftJoin(appUser, eq(appUser.id, sourceDocument.createdBy)).where(where).orderBy(asc(sourceDocument.title));
  return rows.map((r) => sourceRow(r.d, { pages: r.pages, ocr: r.ocr, by: r.by }));
}

// ---- Lists ---------------------------------------------------------------------------------------------------------------

/** The documents of one place, newest first for uploads and by title for a standards version. Needs the place's read permission. */
export async function listDocuments(ctx: Ctx, scopeKind: string, scopeId: string | null): Promise<DocumentRow[]> {
  const { def } = await assertCanRead(ctx, scopeKind, scopeId);
  if (def.storage === 'source') return sourceRows(ctx, eq(sourceDocument.frameworkVersionId, scopeId!));
  return importRows(ctx, and(eq(importDocument.scopeKind, def.kind as never), scopeId ? eq(importDocument.scopeId, scopeId) : sql`${importDocument.scopeId} is null`));
}

/** What the person may do in a place, for the Docs tab (the tab hides what they cannot do). */
export async function getScopeInfo(ctx: Ctx, scopeKind: string, scopeId: string | null): Promise<DocScopeInfo> {
  const { def, place } = await assertCanRead(ctx, scopeKind, scopeId);
  const canWrite = await canWriteScope(ctx, def, scopeId);
  return { kind: def.kind, scopeId, label: place.label, canRead: true, canWrite, editable: place.editable, href: place.href };
}

const MAX_ALL = 1000;

/**
 * Every document the person may see across the institution (Settings -> Documents): uploads of the scopes they may read and the
 * standards' sources, with where each is used. Filters narrow it; nothing is hidden by the filters that the person could not see.
 */
export async function listAllDocuments(ctx: Ctx, filters: DocumentFilters = {}): Promise<DocumentList> {
  const readable = new Set<string>();
  for (const def of docScopes()) if (await canReadScope(ctx, def, null)) readable.add(def.kind);
  const rows: DocumentRow[] = [];
  const importKinds = [...readable].filter((k) => getDocScope(k).storage === 'import');
  if (importKinds.length) rows.push(...await importRows(ctx, inArray(importDocument.scopeKind, importKinds as never)));
  if (readable.has('framework_version')) rows.push(...await sourceRows(ctx, undefined));

  // Where each is used: one description per place.
  const places = new Map<string, { label: string; href: string }>();
  const placeOfRow = async (r: DocumentRow) => {
    const key = scopeKey(r.scopeKind, r.scopeId);
    if (!places.has(key)) {
      const p = await getDocScope(r.scopeKind).describe(ctx, r.scopeId);
      places.set(key, p ? { label: p.label, href: p.href } : { label: 'Unknown place', href: '/settings/documents' });
    }
    return places.get(key)!;
  };
  const all: DocumentListItem[] = [];
  for (const r of rows) all.push({ ...r, place: await placeOfRow(r) });

  const q = filters.q?.trim().normalize('NFC').toLowerCase();
  const from = filters.from ? new Date(filters.from).getTime() : null;
  const to = filters.to ? new Date(filters.to).getTime() + 86_400_000 : null; // the whole last day
  const matches = (r: DocumentListItem) => {
    if (filters.place && scopeKey(r.scopeKind, r.scopeId) !== filters.place && r.scopeKind !== filters.place) return false;
    if (filters.uploadedBy && r.uploadedBy !== filters.uploadedBy) return false;
    if (filters.fileKind && r.fileKind !== filters.fileKind) return false;
    if (filters.status && r.status !== filters.status) return false;
    const at = new Date(r.uploadedAt).getTime();
    if (from !== null && !Number.isNaN(from) && at < from) return false;
    if (to !== null && !Number.isNaN(to) && at >= to) return false;
    if (q && !r.name.normalize('NFC').toLowerCase().includes(q) && !r.place.label.toLowerCase().includes(q)) return false;
    return true;
  };
  const filtered = all.filter(matches).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || a.name.localeCompare(b.name));
  const uploaders = new Map<string, string>();
  for (const r of all) if (r.uploadedBy && r.uploadedByName) uploaders.set(r.uploadedBy, r.uploadedByName);
  const placeOptions = new Map<string, string>();
  for (const r of all) placeOptions.set(scopeKey(r.scopeKind, r.scopeId), r.place.label);
  return {
    items: filtered.slice(0, MAX_ALL), total: filtered.length, truncated: filtered.length > MAX_ALL,
    places: [...placeOptions].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
    uploaders: [...uploaders].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    fileKinds: [...new Set(all.map((r) => r.fileKind))].sort(),
  };
}

// ---- Finding one ---------------------------------------------------------------------------------------------------------

export type FoundDocument =
  | { source: 'import'; row: ImportRow; scopeKind: ImportRow['scopeKind']; scopeId: string | null }
  | { source: 'source'; row: SourceRow; scopeKind: 'framework_version'; scopeId: string };

/** A document by id, from either table. Its place's read permission is checked by the caller. */
export async function findDocument(ctx: Ctx, id: string): Promise<FoundDocument> {
  const [imp] = await ctx.tx.select().from(importDocument).where(eq(importDocument.id, id));
  if (imp) return { source: 'import', row: imp, scopeKind: imp.scopeKind, scopeId: imp.scopeId };
  const [src] = await ctx.tx.select().from(sourceDocument).where(eq(sourceDocument.id, id));
  if (src) return { source: 'source', row: src, scopeKind: 'framework_version', scopeId: src.frameworkVersionId };
  throw new NotFoundError(`document ${id}`);
}

export async function getDocument(ctx: Ctx, id: string): Promise<DocumentRow> {
  const f = await findDocument(ctx, id);
  await assertCanRead(ctx, f.scopeKind, f.scopeId);
  const [row] = f.source === 'import' ? await importRows(ctx, eq(importDocument.id, id)) : await sourceRows(ctx, eq(sourceDocument.id, id));
  return row!;
}

// ---- Upload --------------------------------------------------------------------------------------------------------------

export interface UploadInput { scopeKind: string; scopeId: string | null; fileName: string; mime: string; bytes: Uint8Array; language?: string }

/**
 * Stores one file for a place and queues its reading. Same rules as a source file: not empty, within MAX_SOURCE_BYTES, a kind the
 * parser reads, stored once under a key of its own with its SHA-256. The same file twice in one place is refused, naming the first.
 * For the standards scope the file becomes a new source document (its role left for the analysis to propose).
 */
export async function uploadDocument(ctx: Ctx, input: UploadInput): Promise<DocumentRow> {
  assertHuman(ctx);
  const { def } = await assertCanWrite(ctx, input.scopeKind, input.scopeId);
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  if (!input.bytes.byteLength) throw new ValidationError('the file is empty');
  if (input.bytes.byteLength > MAX_SOURCE_BYTES) throw new ValidationError(`the file is larger than ${Math.round(MAX_SOURCE_BYTES / 1048576)} MB`);
  const fileName = safeName(input.fileName);
  const mime = input.mime || 'application/octet-stream';
  if (!detectFormat({ bytes: input.bytes, fileName, mime })) throw new ValidationError(UNSUPPORTED_FILE_MESSAGE);
  const sha = createHash('sha256').update(input.bytes).digest('hex');
  const language = (input.language ?? 'en').trim() || 'en';

  if (def.storage === 'source') {
    const [dup] = await ctx.tx.select({ id: sourceDocument.id, title: sourceDocument.title }).from(sourceDocument)
      .where(and(eq(sourceDocument.frameworkVersionId, input.scopeId!), eq(sourceDocument.sha256, sha), sql`${sourceDocument.fileName} is not null`));
    if (dup) throw new ConflictError(`this file is already here as "${dup.title}"`, { code: 'duplicate', existingId: dup.id });
    const title = fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || fileName;
    const doc = await addSourceDocument(ctx, { versionId: input.scopeId!, title, authority: 'binding', language });
    await uploadSourceFile(ctx, doc.id, { fileName, mime, bytes: input.bytes });
    await requestTextExtraction(ctx, doc.id);
    return getDocument(ctx, doc.id);
  }

  const [dup] = await ctx.tx.select({ id: importDocument.id, name: importDocument.fileName }).from(importDocument).where(and(
    eq(importDocument.scopeKind, def.kind as never), input.scopeId ? eq(importDocument.scopeId, input.scopeId) : sql`${importDocument.scopeId} is null`, eq(importDocument.sha256, sha)));
  if (dup) throw new ConflictError(`this file is already here as "${dup.name}"`, { code: 'duplicate', existingId: dup.id });
  const id = crypto.randomUUID();
  const key = `${ctx.caller.institutionId}/documents/${def.kind}/${id}/${fileName}`;
  let stored: { size: number; sha256: string };
  try { stored = await ctx.store.put(key, input.bytes, mime); } catch (e) {
    throw new ConflictError(`the file could not be stored (${(e as Error).message})`);
  }
  const [row] = await ctx.tx.insert(importDocument).values({
    id, institutionId: ctx.caller.institutionId, scopeKind: def.kind as never, scopeId: input.scopeId, fileName, mime, size: stored.size, sha256: stored.sha256, filePath: key,
    language, readStatus: 'queued',
  }).returning();
  await enqueueJob(ctx, { type: 'extract_text', payload: { importDocumentId: row!.id } });
  return (await importRows(ctx, eq(importDocument.id, row!.id)))[0]!;
}

// ---- Reading, viewing, deleting ------------------------------------------------------------------------------------------

/** Queues reading the file again (pages are replaced; an import document has no hand-edited pages). */
export async function requestRead(ctx: Ctx, id: string): Promise<{ jobId: string; status: DocStatus }> {
  assertHuman(ctx);
  const f = await findDocument(ctx, id);
  await assertCanWrite(ctx, f.scopeKind, f.scopeId);
  if (f.source === 'source') {
    const r = await requestTextExtraction(ctx, id);
    return { jobId: r.jobId, status: 'queued' };
  }
  await ctx.tx.update(importDocument).set({ readStatus: 'queued', readError: null }).where(eq(importDocument.id, id));
  const job = await enqueueJob(ctx, { type: 'extract_text', payload: { importDocumentId: id } });
  return { jobId: job.id, status: 'queued' };
}

/**
 * Turns the page pictures of a scanned document (0, 90, 180 or 270 degrees clockwise) and queues reading it again, so the vision model
 * sees the pages upright. Pages already read stay until the new reading replaces them.
 */
export async function rotateDocument(ctx: Ctx, id: string, rotation: number): Promise<{ jobId: string; status: DocStatus; rotation: number }> {
  assertHuman(ctx);
  if (![0, 90, 180, 270].includes(rotation)) throw new ValidationError('the rotation is 0, 90, 180 or 270 degrees');
  const f = await findDocument(ctx, id);
  await assertCanWrite(ctx, f.scopeKind, f.scopeId);
  if (f.source === 'source') await ctx.tx.update(sourceDocument).set({ rotation }).where(eq(sourceDocument.id, id));
  else await ctx.tx.update(importDocument).set({ rotation }).where(eq(importDocument.id, id));
  return { ...(await requestRead(ctx, id)), rotation };
}

/** The original file, for viewing or download. */
export async function readDocumentFile(ctx: Ctx, id: string): Promise<{ bytes: Uint8Array; mime: string; fileName: string }> {
  const f = await findDocument(ctx, id);
  await assertCanRead(ctx, f.scopeKind, f.scopeId);
  if (f.source === 'source') return readSourceFile(ctx, id);
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  const obj = await ctx.store.get(f.row.filePath);
  if (!obj) throw new NotFoundError('the stored file is missing');
  return { bytes: obj.body, mime: f.row.mime, fileName: f.row.fileName };
}

/** Every stored page of a document, in order. */
export async function listDocumentPages(ctx: Ctx, id: string): Promise<ImportPage[]> {
  const f = await findDocument(ctx, id);
  await assertCanRead(ctx, f.scopeKind, f.scopeId);
  if (f.source === 'source') {
    const rows = await ctx.tx.select().from(sourcePage).where(eq(sourcePage.sourceDocumentId, id)).orderBy(asc(sourcePage.pageNo));
    return rows.map((p) => ({ pageNo: p.pageNo, text: p.text, method: p.method, needsOcr: p.needsOcr, warnings: [] }));
  }
  const rows = await ctx.tx.select().from(importPage).where(eq(importPage.importDocumentId, id)).orderBy(asc(importPage.pageNo));
  return rows.map((p) => ({ pageNo: p.pageNo, text: p.text, method: p.method, needsOcr: p.needsOcr, warnings: p.warnings }));
}

/** One page for the review's source viewer, with the quote located by the server's matcher (never the browser's). */
export async function getDocumentPageView(ctx: Ctx, id: string, pageNo: number, quote?: string): Promise<SourcePageView> {
  const f = await findDocument(ctx, id);
  await assertCanRead(ctx, f.scopeKind, f.scopeId);
  if (!Number.isInteger(pageNo) || pageNo < 1) throw new ValidationError('page numbers start at 1');
  if (f.source === 'source') return getSourcePageView(ctx, id, pageNo, quote);
  const nos = (await ctx.tx.select({ n: importPage.pageNo }).from(importPage).where(eq(importPage.importDocumentId, id)).orderBy(asc(importPage.pageNo))).map((r) => r.n);
  const near = [pageNo - 1, pageNo, pageNo + 1, pageNo + 2].filter((n) => n >= 1 && nos.includes(n));
  const rows = near.length ? await ctx.tx.select().from(importPage).where(and(eq(importPage.importDocumentId, id), inArray(importPage.pageNo, near))) : [];
  const mine = rows.find((r) => r.pageNo === pageNo) ?? null;
  const trimmed = quote?.trim() ?? '';
  let highlight: SourcePageView['highlight'] = null;
  let elsewhere: number | null = null;
  if (trimmed && mine) {
    const hit = locateQuote(trimmed, new Map(rows.map((r) => [r.pageNo, r.text])), pageNo);
    if (hit?.page === pageNo) highlight = { start: hit.start, end: hit.end, score: hit.score };
    else if (hit) elsewhere = hit.page;
  }
  return {
    document: { id, title: f.row.fileName, role: 'import', language: f.row.language, fileName: f.row.fileName, mime: f.row.mime, hasFile: true, pageCount: Math.max(nos.length, f.row.pageCount ?? 0) },
    pageNos: nos, page: mine ? { pageNo: mine.pageNo, text: mine.text, method: mine.method, needsOcr: mine.needsOcr } : null,
    highlight, quoteFoundOnPage: elsewhere, quoteGiven: !!trimmed,
  };
}

/** Deletes a document: it goes to the Trash with its pages and keeps its file until it leaves the Trash. */
export async function deleteDocument(ctx: Ctx, id: string) {
  assertHuman(ctx);
  const f = await findDocument(ctx, id);
  const { place } = await assertCanWrite(ctx, f.scopeKind, f.scopeId);
  if (f.source === 'source') return deleteSourceDocument(ctx, id);
  const [raw] = await readRows(ctx, 'import_document', [id]);
  return trashImportDocument(ctx, raw!, place.label);
}

/** Reads the status of an upload as the import engine needs it (no permission check: the engine checked it when the run started). */
export async function documentReadState(ctx: Ctx, scopeKind: string, id: string): Promise<{ id: string; name: string; language: string; status: DocStatus; pages: number; error: string | null } | null> {
  if (getDocScope(scopeKind).storage === 'source') {
    const rows = await sourceRows(ctx, eq(sourceDocument.id, id));
    const r = rows[0];
    return r ? { id, name: r.name, language: r.language, status: r.status, pages: r.pageCount ?? 0, error: r.readError } : null;
  }
  const rows = await importRows(ctx, eq(importDocument.id, id));
  const r = rows[0];
  return r ? { id, name: r.name, language: r.language, status: r.status, pages: r.pageCount ?? 0, error: r.readError } : null;
}

export type { ImportReadStatus };
