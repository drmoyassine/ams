// The icon a standard shows in Quality Management and its side panel (the owner, 2026-11-24): a lucide icon name, chosen in the IQF
// for a top-level standard. Kept by framework and code like the other things attached to a standard (requirement_icon), so it can
// be chosen on a published version too and follows the standard when it is renumbered (see renumber.ts).
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { requirement, requirementIcon } from '@ams/db';
import { SetStandardIconSchema } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ValidationError } from '../ctx.js';
import { require_ } from './common.js';
import { attachmentCode } from './renumber.js';

/** Sets or clears (null) the icon of a top-level standard. */
export async function setStandardIcon(ctx: Ctx, requirementId: string, input: unknown): Promise<{ requirementId: string; icon: string | null }> {
  await require_(ctx, 'framework:write');
  const d = SetStandardIconSchema.parse(input);
  const [r] = await ctx.tx.select({ parentId: requirement.parentId }).from(requirement).where(eq(requirement.id, requirementId));
  if (!r) throw new ValidationError('no such standard');
  if (r.parentId) throw new ValidationError('an icon is chosen for a top-level standard', [{ path: 'icon', message: 'only a top-level standard has an icon' }]);
  const at = await attachmentCode(ctx, requirementId);
  const where = and(eq(requirementIcon.frameworkId, at.frameworkId), eq(requirementIcon.code, at.code));
  if (d.icon === null) await ctx.tx.delete(requirementIcon).where(where);
  else {
    await ctx.tx.insert(requirementIcon).values({ institutionId: ctx.caller.institutionId, frameworkId: at.frameworkId, code: at.code, icon: d.icon })
      .onConflictDoUpdate({ target: [requirementIcon.institutionId, requirementIcon.frameworkId, requirementIcon.code], set: { icon: d.icon } });
  }
  return { requirementId, icon: d.icon };
}

/** The icons of a version's top-level standards, by requirement id. */
export async function versionIcons(ctx: Ctx, versionId: string): Promise<Record<string, string>> {
  await require_(ctx, 'framework:read');
  const roots = await ctx.tx.select({ id: requirement.id }).from(requirement).where(and(eq(requirement.frameworkVersionId, versionId), isNull(requirement.parentId)));
  if (!roots.length) return {};
  const keys = await Promise.all(roots.map(async (r) => ({ id: r.id, ...(await attachmentCode(ctx, r.id)) })));
  const rows = await ctx.tx.select({ code: requirementIcon.code, icon: requirementIcon.icon }).from(requirementIcon)
    .where(and(eq(requirementIcon.frameworkId, keys[0]!.frameworkId), inArray(requirementIcon.code, keys.map((k) => k.code))));
  const byCode = new Map(rows.map((r) => [r.code, r.icon]));
  return Object.fromEntries(keys.flatMap((k) => (byCode.has(k.code) ? [[k.id, byCode.get(k.code)!]] : [])));
}
