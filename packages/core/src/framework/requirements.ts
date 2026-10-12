import { and, asc, eq, sql } from 'drizzle-orm';
import { frameworkVersion, requirement, requirementNote } from '@ams/db';
import { AppliesWhenSchema } from '@ams/shared';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, ValidationError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
import { assertHuman, getDraftVersion, getRequirement, getVersion, isInternalVersion, require_, unreviewed } from './common.js';
import { reportUndo } from '../trash/store.js';

const Text = z.string().trim().min(1);

export const CreateRequirementSchema = z.object({
  versionId: z.uuid(),
  parentId: z.uuid().nullable().optional(),
  code: Text,
  levelLabel: Text,
  title: Text,
  officialText: z.string().optional(),
  language: z.string().min(2).default('en'),
  translationEn: z.string().optional(),
  isAssessable: z.boolean().default(true),
  appliesWhen: AppliesWhenSchema.optional(),
  displayOrder: z.number().int().default(0),
  weight: z.number().nonnegative().optional(),
});

async function assertParent(ctx: Ctx, versionId: string, parentId: string | null | undefined) {
  if (!parentId) return;
  const parent = await getRequirement(ctx, parentId);
  if (parent.frameworkVersionId !== versionId) throw new ValidationError('the parent belongs to another version');
}

export async function createRequirement(ctx: Ctx, input: z.input<typeof CreateRequirementSchema>) {
  await require_(ctx, 'framework:write');
  const data = CreateRequirementSchema.parse(input);
  await getDraftVersion(ctx, data.versionId);
  await assertParent(ctx, data.versionId, data.parentId);
  const [row] = await guardIntegrity(() => ctx.tx.insert(requirement).values({
    institutionId: ctx.caller.institutionId,
    frameworkVersionId: data.versionId,
    parentId: data.parentId ?? null,
    code: data.code,
    levelLabel: data.levelLabel,
    title: data.title,
    officialText: data.officialText ?? null,
    language: data.language,
    translationEn: data.translationEn ?? null,
    isAssessable: data.isAssessable,
    appliesWhen: data.appliesWhen ?? null,
    displayOrder: data.displayOrder,
    weight: data.weight === undefined ? null : String(data.weight),
    origin: 'manual',
  }).returning());
  await relabelByDepth(ctx, data.versionId);
  // Undo = delete it (which lands in the Trash like any delete).
  reportUndo(ctx, { label: `Added ${data.code}`, method: 'DELETE', path: `/api/requirements/${row!.id}` });
  return getRequirement(ctx, row!.id);
}

/**
 * What an edit may change. Written out (not derived from the create schema with `.partial()`): in Zod 4 a default inside an
 * optional is still applied, which made every edit reset the language, assessability and position to their defaults.
 * Text fields may be cleared (null), which is also how an edit is undone.
 */
export const UpdateRequirementSchema = z.object({
  code: Text.optional(), levelLabel: Text.optional(), title: Text.optional(),
  officialText: z.string().nullable().optional(), language: z.string().min(2).optional(), translationEn: z.string().nullable().optional(),
  isAssessable: z.boolean().optional(), appliesWhen: AppliesWhenSchema.nullable().optional(), displayOrder: z.number().int().optional(),
  weight: z.number().nonnegative().nullable().optional(),
}).strict();

/** Any change sends the requirement back to review: an approval always refers to exactly the text that was approved. */
export async function updateRequirement(ctx: Ctx, id: string, patch: z.input<typeof UpdateRequirementSchema>) {
  await require_(ctx, 'framework:write');
  const current = await getRequirement(ctx, id);
  await getDraftVersion(ctx, current.frameworkVersionId);
  const data = UpdateRequirementSchema.parse(patch);
  const set: Partial<typeof requirement.$inferInsert> = { ...unreviewed };
  const before: Record<string, unknown> = {};
  if (data.code !== undefined) { set.code = data.code; before.code = current.code; }
  if (data.levelLabel !== undefined) { set.levelLabel = data.levelLabel; before.levelLabel = current.levelLabel; }
  if (data.title !== undefined) { set.title = data.title; before.title = current.title; }
  if (data.officialText !== undefined) { set.officialText = data.officialText; before.officialText = current.officialText; }
  if (data.language !== undefined) { set.language = data.language; before.language = current.language; }
  if (data.translationEn !== undefined) { set.translationEn = data.translationEn; before.translationEn = current.translationEn; }
  if (data.isAssessable !== undefined) { set.isAssessable = data.isAssessable; before.isAssessable = current.isAssessable; }
  if (data.appliesWhen !== undefined) { set.appliesWhen = data.appliesWhen; before.appliesWhen = current.appliesWhen; }
  if (data.displayOrder !== undefined) { set.displayOrder = data.displayOrder; before.displayOrder = current.displayOrder; }
  if (data.weight !== undefined) { set.weight = data.weight === null ? null : String(data.weight); before.weight = current.weight === null ? null : Number(current.weight); }
  const [row] = await guardIntegrity(() => ctx.tx.update(requirement).set(set).where(eq(requirement.id, id)).returning());
  // Undo = write the earlier values back (the requirement returns to review either way, as any edit does).
  reportUndo(ctx, { label: `Edited ${current.code}`, method: 'PATCH', path: `/api/requirements/${id}`, body: before });
  return row!;
}

/** Re-parent a requirement within its version; refuses to place it under itself or one of its descendants. */
export async function moveRequirement(ctx: Ctx, id: string, newParentId: string | null, displayOrder?: number, opts: { label?: string } = {}) {
  await require_(ctx, 'framework:write');
  const current = await getRequirement(ctx, id);
  await getDraftVersion(ctx, current.frameworkVersionId);
  await assertParent(ctx, current.frameworkVersionId, newParentId);
  if (newParentId) {
    const res = await ctx.tx.execute<{ id: string }>(sql`
      with recursive sub as (
        select id from requirement where id = ${id}
        union all
        select r.id from requirement r join sub on r.parent_id = sub.id)
      select id from sub where id = ${newParentId}`);
    if (res.rows.length > 0) throw new ConflictError('a requirement cannot be moved under itself or its own descendant');
  }
  await ctx.tx.update(requirement)
    .set({ parentId: newParentId, ...(displayOrder === undefined ? {} : { displayOrder }) })
    .where(eq(requirement.id, id));
  await relabelByDepth(ctx, current.frameworkVersionId);
  // Undo = move it back to where it was (parent and position); its level follows its depth again.
  reportUndo(ctx, { label: opts.label ?? `Moved ${current.code}`, method: 'POST', path: `/api/requirements/${id}/move`, body: { parentId: current.parentId ?? null, displayOrder: current.displayOrder } });
  return getRequirement(ctx, id);
}

// Deleting (one, a subtree, many, all of a version) is in ../trash/delete.ts: it snapshots into the Trash first.

export async function reviewRequirement(ctx: Ctx, id: string, decision: 'approved' | 'rejected') {
  await require_(ctx, 'framework:review');
  assertHuman(ctx);
  const current = await getRequirement(ctx, id);
  await getDraftVersion(ctx, current.frameworkVersionId);
  const [row] = await ctx.tx.update(requirement)
    .set({ reviewStatus: decision, reviewedBy: ctx.caller.userId, reviewedAt: new Date() })
    .where(eq(requirement.id, id)).returning();
  return row!;
}

/** Flat list in tree order (parents before children, siblings by display order then code); the client builds the tree. */
export async function listRequirements(ctx: Ctx, versionId: string) {
  await require_(ctx, 'framework:read');
  await getVersion(ctx, versionId);
  const rows = await ctx.tx.select().from(requirement).where(eq(requirement.frameworkVersionId, versionId))
    .orderBy(asc(requirement.displayOrder), asc(requirement.code));
  const children = new Map<string | null, typeof rows>();
  for (const r of rows) children.set(r.parentId ?? null, [...(children.get(r.parentId ?? null) ?? []), r]);
  const out: ((typeof rows)[number] & { depth: number })[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const r of children.get(parent) ?? []) { out.push({ ...r, depth }); walk(r.id, depth + 1); }
  };
  walk(null, 0);
  return out;
}

export async function getRequirementWithNotes(ctx: Ctx, id: string) {
  await require_(ctx, 'framework:read');
  const r = await getRequirement(ctx, id);
  const notes = await ctx.tx.select().from(requirementNote).where(and(eq(requirementNote.requirementId, id))).orderBy(asc(requirementNote.createdAt));
  return { requirement: r, notes };
}

/** The name of the level at a depth (0 = top): the institution's name for it, or "Level n" past the named ones. */
export const levelNameAt = (labels: string[], depth: number) => labels[depth] ?? `Level ${depth + 1}`;

/**
 * In the institution's own framework a requirement's level is its depth in the tree: indenting or outdenting it changes
 * its level. Sets every requirement's level label from its depth and the version's level names. A naming change, not a
 * change of content, so review states are left alone. External standards keep the levels their source gives them.
 */
export async function relabelByDepth(ctx: Ctx, versionId: string) {
  if (!(await isInternalVersion(ctx, versionId))) return;
  const [v] = await ctx.tx.select({ levelLabels: frameworkVersion.levelLabels }).from(frameworkVersion).where(eq(frameworkVersion.id, versionId));
  const labels = (v?.levelLabels as string[] | undefined) ?? [];
  for (const r of await listRequirements(ctx, versionId)) {
    const want = levelNameAt(labels, r.depth);
    if (r.levelLabel !== want) await ctx.tx.update(requirement).set({ levelLabel: want }).where(eq(requirement.id, r.id));
  }
}
