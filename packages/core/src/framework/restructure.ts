// Merge and split: the two review actions that change the shape of a draft's requirement list (PRD 15.1 step 6).
// Both are human actions on a draft; the database marks every row they touch as edited by a person (mark_person_edit,
// migration 0039), so a later analysis run leaves them alone, and the audit trigger records each row change under the
// caller's name (the merged-away requirement is kept in the trail with its whole wording).
import { and, asc, eq, sql } from 'drizzle-orm';
import { frameworkVersion, requirement, requirementMapping, requirementNote, sourcePage } from '@ams/db';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, ValidationError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
import { assertHuman, getDraftVersion, getRequirement, require_, unreviewed } from './common.js';
import { verifyQuote } from './quote-match.js';
import { relabelByDepth } from './requirements.js';
import { reportUndo } from '../trash/store.js';
import { deleteMany, trashMergedRequirement } from '../trash/delete.js';
import { readRows } from '../trash/rows.js';

/** Parses with the rule messages as validation issues the screen can show. */
function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown, what: string): z.output<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw new ValidationError(r.error.issues.length === 1 ? r.error.issues[0]!.message : what, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
}

export const MergeRequirementSchema = z.object({
  /** The requirement that stays; the one being merged is the one the call names. */
  intoId: z.uuid(),
  /** Take the merged requirement's title and wording (with its source) instead of the target's. Default: keep the target's. */
  useMergedWording: z.boolean().default(false),
}).strict();

export interface RequirementMergeResult {
  requirement: typeof requirement.$inferSelect;
  movedChildren: number;
  movedNotes: number;
  /** Mappings to the institution's standards that name the merged requirement's code: they are by code and stay as they are. */
  mappingsOnMergedCode: number;
}

/**
 * Merges requirement `id` into another of the same draft: its notes and its children move to the target, the target keeps its
 * own wording (unless asked to take the merged one's), and the merged requirement is removed. Nothing else is lost: the
 * removed row stays in the audit trail with its code, title, wording and source, and (it being the analysis's) the analysis
 * remembers that it was deleted, so a new run does not add it back.
 */
export async function mergeRequirement(ctx: Ctx, id: string, input: z.input<typeof MergeRequirementSchema>): Promise<RequirementMergeResult> {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const data = parseOrThrow(MergeRequirementSchema, input, 'cannot merge');
  const source = await getRequirement(ctx, id);
  await getDraftVersion(ctx, source.frameworkVersionId);
  if (data.intoId === id) throw new ValidationError('choose another requirement to merge into');
  const target = await getRequirement(ctx, data.intoId);
  if (target.frameworkVersionId !== source.frameworkVersionId) throw new ValidationError('the target belongs to another version');
  const inside = await ctx.tx.execute<{ id: string }>(sql`
    with recursive sub as (select id from requirement where id = ${id} union all select r.id from requirement r join sub on r.parent_id = sub.id)
    select id from sub where id = ${target.id}`);
  if (inside.rows.length > 0) throw new ConflictError('the target is inside the requirement being merged; move it out first, or merge the other way round');

  // Children keep their order after the target's own.
  const [last] = await ctx.tx.select({ n: sql<number>`coalesce(max(${requirement.displayOrder}), -1)::int` }).from(requirement).where(eq(requirement.parentId, target.id));
  const children = await ctx.tx.select({ id: requirement.id, displayOrder: requirement.displayOrder }).from(requirement).where(eq(requirement.parentId, id)).orderBy(asc(requirement.displayOrder), asc(requirement.code));
  const [targetBefore] = await readRows(ctx, 'requirement', [target.id]);
  let order = (last?.n ?? -1) + 1;
  for (const c of children) await ctx.tx.update(requirement).set({ parentId: target.id, displayOrder: order++ }).where(eq(requirement.id, c.id));
  const movedNotes = await ctx.tx.update(requirementNote).set({ requirementId: target.id }).where(eq(requirementNote.requirementId, id)).returning({ id: requirementNote.id });

  const [fw] = await ctx.tx.select({ frameworkId: frameworkVersion.frameworkId }).from(frameworkVersion).where(eq(frameworkVersion.id, source.frameworkVersionId));
  const [mapped] = fw ? await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(requirementMapping)
    .where(and(eq(requirementMapping.frameworkId, fw.frameworkId), eq(requirementMapping.externalCode, source.code))) : [];

  // The target is updated whatever the wording choice, so the database marks it as edited by a person.
  const wording = data.useMergedWording
    ? { title: source.title, officialText: source.officialText, language: source.language, sourceDocumentId: source.sourceDocumentId, sourcePage: source.sourcePage, sourceQuote: source.sourceQuote, quoteVerified: source.quoteVerified }
    : {};
  const [updated] = await guardIntegrity(() => ctx.tx.update(requirement).set({ ...wording, ...unreviewed }).where(eq(requirement.id, target.id)).returning());
  // The merged-away requirement goes to the Trash with what is needed to move its children and notes back (Undo restores it).
  await trashMergedRequirement(ctx, id, {
    intoId: target.id, useMergedWording: data.useMergedWording, children: children.map((c) => ({ id: c.id, displayOrder: c.displayOrder })), noteIds: movedNotes.map((n) => n.id), targetBefore: targetBefore ?? null,
  }, target.code);
  await relabelByDepth(ctx, source.frameworkVersionId);
  return { requirement: updated!, movedChildren: children.length, movedNotes: movedNotes.length, mappingsOnMergedCode: mapped?.n ?? 0 };
}

export const SplitRequirementSchema = z.object({
  /** The part of the requirement's text that moves to the new requirement; it must occur in that text. */
  part: z.string().trim().min(1, 'choose the part of the text to move out'),
  code: z.string().trim().min(1, 'give the new requirement a code'),
  /** Defaults to the code (the wording is in the description), like an item imported without a title. */
  title: z.string().trim().min(1).optional(),
}).strict();

export interface RequirementSplitResult {
  original: typeof requirement.$inferSelect;
  created: typeof requirement.$inferSelect;
}

/** Collapses the seam left where a part was cut out of a text. */
function tidy(s: string): string {
  return s.replace(/[ \t]{2,}/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Splits the part `part` of a requirement's text out into a new sibling requirement with the code given. The original keeps
 * the rest of its text, its notes and its children; both keep the source (document, page). The new one cites the moved text as
 * its quote and is checked against the stored page with the same verifier as the analysis; if it is not found there it says so
 * (quote not found) and is not trusted. A person's action: the original is marked as edited by a person by the database, and
 * the new requirement is a person's own (origin manual).
 */
export async function splitRequirement(ctx: Ctx, id: string, input: z.input<typeof SplitRequirementSchema>): Promise<RequirementSplitResult> {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const data = parseOrThrow(SplitRequirementSchema, input, 'cannot split');
  const original = await getRequirement(ctx, id);
  await getDraftVersion(ctx, original.frameworkVersionId);
  const text = original.officialText ?? '';
  const at = text.indexOf(data.part);
  if (at < 0) throw new ValidationError('the part to move out is not in the requirement\'s text', [{ path: 'part', message: 'it must be copied from the description' }]);
  const rest = tidy(`${text.slice(0, at)} ${text.slice(at + data.part.length)}`);
  if (!rest) throw new ValidationError('choose only part of the text: the requirement would be left empty', [{ path: 'part', message: 'leave some of the text in place' }]);
  const [clash] = await ctx.tx.select({ id: requirement.id }).from(requirement)
    .where(and(eq(requirement.frameworkVersionId, original.frameworkVersionId), eq(requirement.code, data.code)));
  if (clash) throw new ConflictError(`the code ${data.code} is already used in this version`);

  // Provenance: the same source; the moved text is the new quote, verified against the stored pages like any other.
  let page = original.sourcePage;
  let verified = false;
  if (original.sourceDocumentId && original.sourcePage) {
    const rows = await ctx.tx.select({ n: sourcePage.pageNo, t: sourcePage.text }).from(sourcePage).where(eq(sourcePage.sourceDocumentId, original.sourceDocumentId));
    const check = verifyQuote(data.part, new Map(rows.map((r) => [r.n, r.t])), original.sourcePage);
    verified = check.verified;
    if (check.verified && check.page) page = check.page;
  }
  const hasSource = !!original.sourceDocumentId;
  const [created] = await guardIntegrity(() => ctx.tx.insert(requirement).values({
    institutionId: ctx.caller.institutionId, frameworkVersionId: original.frameworkVersionId, parentId: original.parentId,
    code: data.code, levelLabel: original.levelLabel, title: data.title ?? data.code, officialText: data.part, language: original.language,
    translationEn: null, isAssessable: original.isAssessable, appliesWhen: original.appliesWhen, displayOrder: original.displayOrder + 1, weight: original.weight,
    origin: 'manual',
    ...(hasSource ? { sourceDocumentId: original.sourceDocumentId, sourcePage: page, sourceQuote: data.part, quoteVerified: verified } : {}),
  }).returning());
  const [updated] = await guardIntegrity(() => ctx.tx.update(requirement).set({ officialText: rest, ...unreviewed }).where(eq(requirement.id, id)).returning());
  await relabelByDepth(ctx, original.frameworkVersionId);
  reportUndo(ctx, { label: `Split ${original.code}`, method: 'POST', path: `/api/requirements/${id}/unsplit`, body: { createdId: created!.id, officialText: original.officialText ?? '' } });
  return { original: updated!, created: created! };
}

export const UnsplitSchema = z.object({ createdId: z.uuid(), officialText: z.string() }).strict();

/**
 * Takes a split back: the requirement that was split out goes to the Trash (with its notes, if any were added) and the
 * original gets its earlier text again. Refused when the split-out requirement now has sub-items of its own.
 */
export async function unsplitRequirement(ctx: Ctx, id: string, input: z.input<typeof UnsplitSchema>): Promise<typeof requirement.$inferSelect> {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const data = parseOrThrow(UnsplitSchema, input, 'cannot take the split back');
  const original = await getRequirement(ctx, id);
  const created = await getRequirement(ctx, data.createdId);
  await getDraftVersion(ctx, original.frameworkVersionId);
  if (created.frameworkVersionId !== original.frameworkVersionId) throw new ValidationError('it belongs to another version');
  const [kid] = await ctx.tx.select({ id: requirement.id }).from(requirement).where(eq(requirement.parentId, created.id)).limit(1);
  if (kid) throw new ConflictError(`Cannot take the split back: ${created.code} has sub-items of its own now. Move or delete them first.`);
  const [row] = await guardIntegrity(() => ctx.tx.update(requirement).set({ officialText: data.officialText || null, ...unreviewed }).where(eq(requirement.id, id)).returning());
  const createdText = created.officialText ?? '';
  await deleteMany(ctx, { ids: [created.id] });
  // Redo = split it again (a new requirement with the same code, title and part). Reported last: the outermost action wins
  // over the restore descriptor that deleting the split-out requirement reported.
  reportUndo(ctx, { label: `Split ${original.code}`, method: 'POST', path: `/api/requirements/${id}/split`, body: { part: createdText, code: created.code, title: created.title } });
  return row!;
}
