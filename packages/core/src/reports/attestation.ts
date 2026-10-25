// The signed letter of an attestation section (TASK-092, PRD 10.3). The file goes up as the request body and lands in
// storage under the report; the section's content carries it whole (key, name, mime, size — the schema's all-or-nothing
// rule), keeping whatever signatory and statement were already written. The database refuses the content write once the
// report left the draft; the upload is refused too, so no letter is stored that no section can point at.
import { eq } from 'drizzle-orm';
import { report, reportSection } from '@ams/db';
import { parseContent, type ReportDetail } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { MAX_UPLOAD_BYTES } from '../evidence/evidence.js';
import { safeName } from '../framework/sources.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';
import { loadSection, scopeOf } from './common.js';
import { getReport } from './read.js';

export interface AttestationFile { fileName: string; mime: string; bytes: Uint8Array }

export async function saveAttestationLetter(ctx: Ctx, sectionId: string, file: AttestationFile): Promise<ReportDetail> {
  assertHuman(ctx);
  const section = await loadSection(ctx, sectionId);
  if (section.blockType !== 'attestation') {
    throw new ValidationError(`Section "${section.title}" is a ${section.blockType}; a signed letter belongs to an attestation.`);
  }
  const [row] = await ctx.tx.select().from(report).where(eq(report.id, section.reportId));
  if (!row || row.institutionId !== ctx.caller.institutionId) throw new NotFoundError(`report ${section.reportId}`);
  await assertPermitted(ctx, 'report:write', scopeOf(row));
  if (row.status !== 'draft') throw new ConflictError('The signed letter is uploaded while the report is a draft.');
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  if (file.bytes.byteLength === 0) throw new ValidationError('the file is empty');
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) throw new ValidationError(`the file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB`);

  const fileName = safeName(file.fileName);
  const mime = file.mime || 'application/octet-stream';
  const key = `${ctx.caller.institutionId}/reports/${row.id}/${crypto.randomUUID()}/${fileName}`;
  let stored: { size: number };
  try {
    stored = await ctx.store.put(key, file.bytes, mime);
  } catch (e) {
    // Say what the storage service answered, so a misconfiguration can be seen and fixed rather than guessed at.
    const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    throw new ConflictError(`the file could not be stored (${[err.name, err.$metadata?.httpStatusCode, err.message].filter(Boolean).join(' ')})`);
  }

  // Keep the signatory and statement already written; replace the letter whole.
  const current = parseContent('attestation', section.content) as Record<string, unknown>;
  await ctx.tx.update(reportSection).set({
    content: { ...current, fileKey: key, fileName, fileMime: mime, fileSize: stored.size },
  }).where(eq(reportSection.id, sectionId));
  return getReport(ctx, row.id);
}

/** The stored letter of an attestation section, for viewing and for the export. The whole section travels to the reader. */
export async function readAttestationLetter(ctx: Ctx, sectionId: string): Promise<{ bytes: Uint8Array; mime: string; fileName: string }> {
  const section = await loadSection(ctx, sectionId);
  const [row] = await ctx.tx.select().from(report).where(eq(report.id, section.reportId));
  if (!row || row.institutionId !== ctx.caller.institutionId) throw new NotFoundError(`report ${section.reportId}`);
  await assertPermitted(ctx, 'report:read', scopeOf(row));
  const content = parseContent('attestation', section.content) as { fileKey?: string | null; fileName?: string | null };
  if (!content.fileKey || !content.fileName) throw new NotFoundError('the section has no signed letter yet');
  const stored = await ctx.store?.get(content.fileKey);
  if (!stored) throw new ConflictError('the signed letter is not in storage any more');
  return { bytes: stored.body, mime: stored.mime, fileName: content.fileName };
}
