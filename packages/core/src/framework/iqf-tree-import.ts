// The institution's own framework from its documents (TASK-111, docs/ai-import.md). The import target `iqf_tree` of the standards'
// Docs tab, offered only on the institution's own framework (never on an accreditor's standard, which has its own analysis). The
// windows of pages yield an OUTLINE (the headings of each document, copied and quote-checked), ONE more call draws the framework
// from all of them (standards and sub-standards, each with a title and a short description in the institution's words, each naming
// the headings it comes from), and a person reviews, edits and accepts. Apply creates the accepted items in the draft through the
// ordinary requirement service as that person; an item whose code is already in the framework is left alone with the reason. One
// inverse takes the whole apply back (to the Trash) and Redo restores it.
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { ConflictError, ForbiddenError, ValidationError, type Ctx } from '../ctx.js';
import { restoreTrash } from '../trash/trash.js';
import { deleteMany } from '../trash/delete.js';
import { saveContentTranslation } from '../translation/content.js';
import { registerImportTarget, type ApplyItem, type ApplyOutcome, type ImportTarget, type OutlineEntry } from '../documents/targets.js';
import { getDraftVersion, isInternalVersion, require_ } from './common.js';
import { createRequirement, listRequirements } from './requirements.js';
import { normalizeQuoteText } from './quote-match.js';

const opt = <T extends z.ZodType>(t: T) => t.nullish().default(null);

/** One proposed item of the framework, as a person reviews and edits it. */
export const IqfNodeSchema = z.object({
  level: z.enum(['standard', 'sub_standard']),
  /** Suggested; a person may change it. */
  code: z.string().trim().min(1),
  title: z.string().trim().min(1),
  /** The Arabic title exactly as printed in the source, when the source heading is Arabic. Kept beside the English title when Arabic is on. */
  titleAr: opt(z.string().trim()),
  description: opt(z.string().trim()),
  /** For a sub-standard: the code of its standard (another item of this list, or one already in the framework). */
  parentCode: opt(z.string().trim()),
  /** The headings it comes from, in words (the review also shows the first one's page and quote). */
  basedOn: opt(z.string().trim()),
});
export type IqfNode = z.infer<typeof IqfNodeSchema>;

export const IQF_TREE_TARGET_KIND = 'iqf_tree';

/** One heading of a document, as a window reads it. */
const OutlineSchema = z.object({
  level: z.number().int().min(0).max(2),
  number: opt(z.string().trim()),
  title: z.string().trim().min(1),
  about: opt(z.string().trim()),
});
type Outline = z.infer<typeof OutlineSchema>;

const AnswerItemSchema = z.object({
  level: z.enum(['standard', 'sub_standard']),
  code: z.string(),
  title: z.string(),
  title_ar: z.string().nullish(),
  description: z.string().nullish(),
  parent_code: z.string().nullish(),
  from: z.array(z.number().int()).default([]),
  confidence: z.number().min(0).max(1).nullish(),
  flags: z.array(z.string()).default([]),
});
type AnswerItem = z.infer<typeof AnswerItemSchema>;
const AnswerSchema = z.object({ items: z.array(AnswerItemSchema) });

const fold = (s: string | null | undefined) => (s ? normalizeQuoteText(s) : '');
const nfc = (s: string | null | undefined) => (s ? s.normalize('NFC').trim() || null : null);

/** The framework as it is now, as an indented outline of codes and titles (what the organise call must fit; capped). */
async function outlineOfFramework(ctx: Ctx, versionId: string): Promise<string> {
  const rows = (await listRequirements(ctx, versionId)).slice(0, 300);
  if (!rows.length) return 'The framework is empty.';
  return ['Levels, top first: Standard, Sub-standard.', ...rows.map((r) => `${'  '.repeat(r.depth)}${r.code} ${r.title}`)].join('\n');
}

const headingLine = (h: Outline) => [h.number, h.title].filter(Boolean).join(' ');

/** Runs `fn`; when it throws, its work is rolled back and the error returned (the apply goes on without that item). */
async function attempt<T>(ctx: Ctx, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  await ctx.tx.execute(sql`savepoint iqf_tree_item`);
  try {
    const value = await fn();
    await ctx.tx.execute(sql`release savepoint iqf_tree_item`);
    return { ok: true, value };
  } catch (e) {
    await ctx.tx.execute(sql`rollback to savepoint iqf_tree_item`);
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

interface CreatedItem { id: string; code: string; title: string; parentId: string | null }
interface Inverse { created: CreatedItem[]; state: 'applied' | 'undone'; groupId?: string }

export const iqfTreeTarget: ImportTarget<IqfNode> = {
  kind: IQF_TREE_TARGET_KIND, label: 'Draft the framework', itemsLabel: 'standards and sub-standards', scopeKinds: ['framework_version'], aiRole: 'analysis',
  description: 'Reads all the documents together and proposes the framework: standards and sub-standards with titles, each traced to the headings it comes from. Nothing is added until you accept it.',
  async available(ctx, scope) { return !!scope.id && (await isInternalVersion(ctx, scope.id)); },
  schema: IqfNodeSchema,
  promptTask: 'iqf_organise', promptVersion: 'v1',
  buildPrompt: () => '',
  organise: {
    outline: {
      schema: OutlineSchema, promptTask: 'iqf_outline', promptVersion: 'v1',
      buildPrompt: (w) => [
        'Find the headings of this document that organise it.',
        `Document: ${w.documentName}. Language: ${w.language}. This window: pages ${w.firstPage} to ${w.lastPage}.`,
        '', w.pages,
      ].join('\n'),
    },
    promptTask: 'iqf_organise', promptVersion: 'v1',
    context: (ctx, scope) => (scope.id ? outlineOfFramework(ctx, scope.id) : Promise.resolve('The framework is empty.')),
    buildPrompt: ({ documents, entries, context }) => [
      'Documents:',
      ...documents.map((d) => `- ${d.name} (language: ${d.language}${d.role ? `, described as: ${d.role.replace(/_/g, ' ')}` : ''})`),
      '', 'Headings found in them:',
      ...(entries as OutlineEntry<Outline>[]).map((e) => `[${e.n}] ${e.documentName} · p.${e.page} · level ${e.item.level} · ${headingLine(e.item)}${e.item.about ? ` — ${e.item.about}` : ''}`),
      '', 'The framework as it is now:', context,
    ].join('\n'),
    answer: AnswerSchema,
    from: (a: AnswerItem) => a.from,
    build: (a: AnswerItem, sources: OutlineEntry<Outline>[]) => ({
      item: {
        level: a.level, code: a.code.trim(), title: a.title.trim(), titleAr: nfc(a.title_ar), description: nfc(a.description), parentCode: a.level === 'sub_standard' ? nfc(a.parent_code) : null,
        basedOn: sources.slice(0, 6).map((s) => `${s.documentName}, page ${s.page}: ${headingLine(s.item)}`).join('; ') || null,
      },
      confidence: a.confidence ?? null, flags: a.flags,
    }),
  },
  async validate(item, scope, ctx) {
    const why: string[] = [];
    if (item.level === 'sub_standard' && !item.parentCode) why.push('A sub-standard needs the standard it belongs to.');
    if (item.level === 'standard' && item.parentCode) why.push('A standard has no parent; the parent code is ignored.');
    if (scope.id) {
      const existing = await listRequirements(ctx, scope.id);
      const code = existing.find((r) => fold(r.code) === fold(item.code));
      if (code) why.push(`The framework already has an item with the code ${item.code} ("${code.title}"); this one would be skipped.`);
      else if (existing.some((r) => fold(r.title) === fold(item.title))) why.push('The framework already has an item with this title; check that it is not a duplicate.');
    }
    return why;
  },
  proposalLabel: (item) => `${item.code} ${item.title}`,
  dedupeKey: (item) => `${item.level}|${fold(item.code)}|${fold(item.title)}`,

  async apply(ctx, items: ApplyItem<IqfNode>[], scope) {
    const versionId = scope.id;
    if (!versionId) throw new ConflictError('this import needs a framework version');
    await getDraftVersion(ctx, versionId);
    if (!(await isInternalVersion(ctx, versionId))) throw new ConflictError('this import is for the institution\'s own framework');
    const existing = await listRequirements(ctx, versionId);
    const idByCode = new Map(existing.map((r) => [fold(r.code), r.id]));
    const orderOf = new Map<string | null, number>();
    for (const r of existing) orderOf.set(r.parentId ?? null, Math.max(orderOf.get(r.parentId ?? null) ?? 0, r.displayOrder + 1));
    const outcomes = new Map<string, ApplyOutcome>();
    const created: CreatedItem[] = [];
    const skip = (it: ApplyItem<IqfNode>, reason: string) => { outcomes.set(it.proposalId, { proposalId: it.proposalId, status: 'skipped', reason }); };
    const hasChildren = new Set(items.filter((i) => i.item.level === 'sub_standard' && i.item.parentCode).map((i) => fold(i.item.parentCode)));
    // Standards first, then the sub-standards under them: a sub-standard's parent may be one of this very apply.
    const ordered = [...items.filter((i) => i.item.level === 'standard'), ...items.filter((i) => i.item.level === 'sub_standard')];
    for (const it of ordered) {
      const p = it.item;
      const code = p.code.normalize('NFC').trim();
      if (idByCode.has(fold(code))) { skip(it, `an item with the code ${code} is already in the framework; left alone`); continue; }
      let parentId: string | null = null;
      if (p.level === 'sub_standard') {
        const parent = p.parentCode ? idByCode.get(fold(p.parentCode)) : undefined;
        if (!parent) { skip(it, p.parentCode ? `its standard ${p.parentCode} is not in the framework and is not among the accepted items` : 'it has no standard to sit under'); continue; }
        parentId = parent;
      }
      const made = await attempt(ctx, async () => {
        const row = await createRequirement(ctx, {
          versionId, parentId, code, levelLabel: p.level === 'standard' ? 'Standard' : 'Sub-standard', title: p.title.normalize('NFC').trim(),
          ...(p.description ? { officialText: p.description.normalize('NFC').trim() } : {}), language: 'en',
          // A heading that only groups sub-standards is not assessed itself.
          isAssessable: !(p.level === 'standard' && hasChildren.has(fold(code))), displayOrder: orderOf.get(parentId) ?? 0,
        });
        // The Arabic title beside it, when the institution has Arabic switched on (never a reason to refuse the item).
        let arabic = false;
        if (p.titleAr) {
          const t = await attempt(ctx, () => saveContentTranslation(ctx, versionId, { entityId: row.id, field: 'title', text: p.titleAr! }));
          arabic = t.ok;
        }
        return { row, arabic };
      });
      if (!made.ok) {
        if (made.error instanceof ForbiddenError || made.error instanceof ConflictError || made.error instanceof ValidationError) { skip(it, made.error.message); continue; }
        throw made.error;
      }
      const { row, arabic } = made.value;
      orderOf.set(parentId, (orderOf.get(parentId) ?? 0) + 1);
      idByCode.set(fold(code), row.id);
      created.push({ id: row.id, code, title: row.title, parentId });
      outcomes.set(it.proposalId, { proposalId: it.proposalId, status: 'applied', ref: { requirementId: row.id, code, level: p.level, arabicTitle: arabic } });
    }
    const inverse: Inverse = { created, state: 'applied' };
    return { outcomes: items.map((i) => outcomes.get(i.proposalId)!), inverse };
  },

  /** Undo puts what was added in the Trash; Redo restores it. A change by a person since refuses. */
  async reverse(ctx, raw) {
    const inv = raw as Inverse;
    if (inv.state === 'applied') {
      const ids = inv.created.map((c) => c.id);
      if (!ids.length) return { ...inv, state: 'undone' } satisfies Inverse;
      const versionId = (await ctx.tx.execute(sql`select framework_version_id as v from requirement where id = ${ids[0]}::uuid`)).rows[0]?.v as string | undefined;
      if (!versionId) throw new ConflictError('the items this import added were removed since.');
      const now = new Map((await listRequirements(ctx, versionId)).map((r) => [r.id, r]));
      for (const c of inv.created) {
        const r = now.get(c.id);
        if (!r || (r.parentId ?? null) !== c.parentId || r.title !== c.title || r.code !== c.code || r.editedByPerson) throw new ConflictError(`"${c.code} ${c.title}" was changed or removed since.`);
      }
      const foreign = [...now.values()].find((r) => r.parentId && ids.includes(r.parentId) && !ids.includes(r.id));
      if (foreign) throw new ConflictError(`"${foreign.code} ${foreign.title}" was added under an item this import made.`);
      const res = await deleteMany(ctx, { ids });
      return { ...inv, state: 'undone', groupId: res.groupId } satisfies Inverse;
    }
    if (inv.groupId) await restoreTrash(ctx, { groupId: inv.groupId });
    return { created: inv.created, state: 'applied' } satisfies Inverse;
  },
};

/**
 * Which items the imports of this version created, by the document their run read (TASK-111): the applied proposals of the
 * version's `iqf_tree` runs. A run reads its documents together and draws one framework from all of them, so its items
 * belong to each of them. Items removed since (Undo, delete) keep their entry here; the reader filters by what exists.
 */
export async function importedItemsByDocument(ctx: Ctx, versionId: string): Promise<Record<string, string[]>> {
  await require_(ctx, 'framework:read');
  const rows = await ctx.tx.execute(sql`
    select d.doc as document_id, p.applied_ref ->> 'requirementId' as requirement_id
    from import_run r
    join lateral unnest(r.document_ids) as d(doc) on true
    join import_proposal p on p.run_id = r.id
    where r.scope_kind = 'framework_version' and r.scope_id = ${versionId}::uuid
      and r.target_kind = ${IQF_TREE_TARGET_KIND} and p.applied_ref ->> 'requirementId' is not null`);
  const out: Record<string, string[]> = {};
  for (const row of rows.rows as { document_id: string; requirement_id: string }[]) (out[row.document_id] ??= []).push(row.requirement_id);
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])];
  return out;
}

registerImportTarget(iqfTreeTarget);
