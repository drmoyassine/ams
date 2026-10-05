import { and, asc, eq, sql } from 'drizzle-orm';
import { requirement, requirementNote } from '@ams/db';
import { AppliesWhenSchema } from '@ams/shared';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, ValidationError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
import { assertHuman, getDraftVersion, getRequirement, getVersion, require_, unreviewed } from './common.js';

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
  return row!;
}

const UpdateRequirementSchema = CreateRequirementSchema.omit({ versionId: true, parentId: true }).partial().strict();

/** Any change sends the requirement back to review: an approval always refers to exactly the text that was approved. */
export async function updateRequirement(ctx: Ctx, id: string, patch: z.input<typeof UpdateRequirementSchema>) {
  await require_(ctx, 'framework:write');
  const current = await getRequirement(ctx, id);
  await getDraftVersion(ctx, current.frameworkVersionId);
  const data = UpdateRequirementSchema.parse(patch);
  const set: Partial<typeof requirement.$inferInsert> = { ...unreviewed };
  if (data.code !== undefined) set.code = data.code;
  if (data.levelLabel !== undefined) set.levelLabel = data.levelLabel;
  if (data.title !== undefined) set.title = data.title;
  if (data.officialText !== undefined) set.officialText = data.officialText;
  if (data.language !== undefined) set.language = data.language;
  if (data.translationEn !== undefined) set.translationEn = data.translationEn;
  if (data.isAssessable !== undefined) set.isAssessable = data.isAssessable;
  if (data.appliesWhen !== undefined) set.appliesWhen = data.appliesWhen;
  if (data.displayOrder !== undefined) set.displayOrder = data.displayOrder;
  if (data.weight !== undefined) set.weight = String(data.weight);
  const [row] = await guardIntegrity(() => ctx.tx.update(requirement).set(set).where(eq(requirement.id, id)).returning());
  return row!;
}

/** Re-parent a requirement within its version; refuses to place it under itself or one of its descendants. */
export async function moveRequirement(ctx: Ctx, id: string, newParentId: string | null, displayOrder?: number) {
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
  const [row] = await ctx.tx.update(requirement)
    .set({ parentId: newParentId, ...(displayOrder === undefined ? {} : { displayOrder }) })
    .where(eq(requirement.id, id)).returning();
  return row!;
}

/** Deletes a leaf requirement together with its notes; a requirement with children must be emptied first. */
export async function deleteRequirement(ctx: Ctx, id: string) {
  await require_(ctx, 'framework:write');
  const current = await getRequirement(ctx, id);
  await getDraftVersion(ctx, current.frameworkVersionId);
  const [child] = await ctx.tx.select({ id: requirement.id }).from(requirement).where(eq(requirement.parentId, id)).limit(1);
  if (child) throw new ConflictError('delete or move the child requirements first');
  await ctx.tx.delete(requirementNote).where(eq(requirementNote.requirementId, id));
  await guardIntegrity(() => ctx.tx.delete(requirement).where(eq(requirement.id, id)));
}

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
