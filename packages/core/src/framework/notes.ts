import { and, eq } from 'drizzle-orm';
import { requirementNote, sourcePage } from '@ams/db';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
import { assertHuman, getDraftVersion, getRequirement, getSourceDocument, require_, unreviewed } from './common.js';
import { quoteInText } from './quote.js';

const Source = z.object({ documentId: z.uuid(), page: z.number().int().min(1), quote: z.string().trim().min(1) });

/** `ai_suggested` is the AI's own label; a person never creates one (PRD 6.3). */
const HUMAN_AUTHORITIES = ['required', 'example', 'suggested', 'institution_defined'] as const;

export const AddNoteSchema = z.object({
  requirementId: z.uuid(),
  type: z.enum(['guidance', 'evidence_expectation', 'data_request', 'quantitative_norm']),
  text: z.string().trim().min(1),
  authority: z.enum(HUMAN_AUTHORITIES),
  norm: z.record(z.string(), z.unknown()).optional(),
  source: Source.optional(),
});

/** Looks the quote up in the stored page text. Never trusts a client-supplied flag. */
async function checkSource(ctx: Ctx, versionId: string, source: z.infer<typeof Source> | undefined) {
  if (!source) return { documentId: null, page: null, quote: null, verified: false };
  const doc = await getSourceDocument(ctx, source.documentId);
  if (doc.frameworkVersionId !== versionId) throw new ValidationError('the source document belongs to another version');
  const [page] = await ctx.tx.select({ text: sourcePage.text }).from(sourcePage)
    .where(and(eq(sourcePage.sourceDocumentId, doc.id), eq(sourcePage.pageNo, source.page)));
  return { documentId: doc.id, page: source.page, quote: source.quote, verified: page ? quoteInText(source.quote, page.text) : false };
}

async function getNote(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(requirementNote).where(eq(requirementNote.id, id));
  if (!row) throw new NotFoundError(`note ${id}`);
  return row;
}

function assertAuthorityNeeds(authority: string, source: { documentId: string | null }) {
  if (authority === 'required' && !source.documentId) {
    throw new ValidationError('a required note must cite its source (document, page and quote)', [{ path: 'source', message: 'required for authority required' }]);
  }
}

export async function addNote(ctx: Ctx, input: z.input<typeof AddNoteSchema>) {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const data = AddNoteSchema.parse(input);
  const req = await getRequirement(ctx, data.requirementId);
  await getDraftVersion(ctx, req.frameworkVersionId);
  const src = await checkSource(ctx, req.frameworkVersionId, data.source);
  assertAuthorityNeeds(data.authority, src);
  const [row] = await guardIntegrity(() => ctx.tx.insert(requirementNote).values({
    institutionId: ctx.caller.institutionId,
    requirementId: data.requirementId,
    type: data.type,
    text: data.text,
    authority: data.authority,
    norm: data.norm ?? null,
    origin: 'manual',
    sourceDocumentId: src.documentId,
    sourcePage: src.page,
    sourceQuote: src.quote,
    quoteVerified: src.verified,
  }).returning());
  return row!;
}

const UpdateNoteSchema = z.object({
  text: z.string().trim().min(1).optional(),
  type: z.enum(['guidance', 'evidence_expectation', 'data_request', 'quantitative_norm']).optional(),
  norm: z.record(z.string(), z.unknown()).nullable().optional(),
  source: Source.nullable().optional(),
}).strict();

export async function updateNote(ctx: Ctx, id: string, patch: z.input<typeof UpdateNoteSchema>) {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const note = await getNote(ctx, id);
  const req = await getRequirement(ctx, note.requirementId);
  await getDraftVersion(ctx, req.frameworkVersionId);
  const data = UpdateNoteSchema.parse(patch);
  const set: Partial<typeof requirementNote.$inferInsert> = { ...unreviewed };
  if (data.text !== undefined) set.text = data.text;
  if (data.type !== undefined) set.type = data.type;
  if (data.norm !== undefined) set.norm = data.norm;
  if (data.source !== undefined) {
    const src = await checkSource(ctx, req.frameworkVersionId, data.source ?? undefined);
    assertAuthorityNeeds(note.authority, src);
    Object.assign(set, { sourceDocumentId: src.documentId, sourcePage: src.page, sourceQuote: src.quote, quoteVerified: src.verified });
  }
  const [row] = await guardIntegrity(() => ctx.tx.update(requirementNote).set(set).where(eq(requirementNote.id, id)).returning());
  return row!;
}

/**
 * Only a person can change what the AI proposed: promote an `ai_suggested` note to a real authority (or reclassify any
 * note). `required` needs a quote found in the stored page text.
 */
export async function setNoteAuthority(ctx: Ctx, id: string, authority: (typeof HUMAN_AUTHORITIES)[number]) {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const note = await getNote(ctx, id);
  const req = await getRequirement(ctx, note.requirementId);
  await getDraftVersion(ctx, req.frameworkVersionId);
  if (authority === 'required') {
    const src = note.sourceDocumentId && note.sourcePage && note.sourceQuote
      ? await checkSource(ctx, req.frameworkVersionId, { documentId: note.sourceDocumentId, page: note.sourcePage, quote: note.sourceQuote })
      : null;
    if (!src?.verified) throw new ConflictError('a required note needs a quote that is found on its cited source page');
  }
  const [row] = await guardIntegrity(() => ctx.tx.update(requirementNote).set({ authority, ...unreviewed }).where(eq(requirementNote.id, id)).returning());
  return row!;
}

export async function reviewNote(ctx: Ctx, id: string, decision: 'approved' | 'rejected') {
  await require_(ctx, 'framework:review');
  assertHuman(ctx);
  const note = await getNote(ctx, id);
  const req = await getRequirement(ctx, note.requirementId);
  await getDraftVersion(ctx, req.frameworkVersionId);
  if (decision === 'approved' && note.authority === 'required' && !note.quoteVerified) {
    throw new ConflictError('a required note cannot be approved without a verified quote');
  }
  const [row] = await ctx.tx.update(requirementNote)
    .set({ reviewStatus: decision, reviewedBy: ctx.caller.userId, reviewedAt: new Date() })
    .where(eq(requirementNote.id, id)).returning();
  return row!;
}

export async function deleteNote(ctx: Ctx, id: string) {
  await require_(ctx, 'framework:write');
  const note = await getNote(ctx, id);
  const req = await getRequirement(ctx, note.requirementId);
  await getDraftVersion(ctx, req.frameworkVersionId);
  await guardIntegrity(() => ctx.tx.delete(requirementNote).where(eq(requirementNote.id, id)));
}
