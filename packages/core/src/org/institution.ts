import { eq } from 'drizzle-orm';
import { institution } from '@ams/db';
import { isReadableAccent, type Institution, type UpdateInstitution } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';

const toDto = (r: typeof institution.$inferSelect): Institution => ({
  id: r.id, nameEn: r.nameEn, nameAr: r.nameAr, country: r.country, defaultLocale: r.defaultLocale, accentColor: r.accentColor,
  logoVersion: r.logoPath && r.logoUpdatedAt ? String(r.logoUpdatedAt.getTime()) : null,
});

/** The caller's institution: its names and branding, shown in the app shell for everyone. */
export async function getInstitution(ctx: Ctx): Promise<Institution> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const [row] = await ctx.tx.select().from(institution).where(eq(institution.id, ctx.caller.institutionId));
  if (!row) throw new NotFoundError('institution');
  return toDto(row);
}

/** Names, country, default language and accent colour. Only an admin changes the institution's identity. */
export async function updateInstitution(ctx: Ctx, patch: UpdateInstitution): Promise<Institution> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'institution:write', { type: 'institution' });
  if (patch.accentColor && !isReadableAccent(patch.accentColor)) throw new ValidationError('choose a darker colour: white text on it must reach a contrast of 4.5 (#rrggbb)');
  const set: Partial<typeof institution.$inferInsert> = {};
  if (patch.nameEn !== undefined) set.nameEn = patch.nameEn;
  if (patch.nameAr !== undefined) set.nameAr = patch.nameAr || null;
  if (patch.country !== undefined) set.country = patch.country || null;
  if (patch.defaultLocale !== undefined) set.defaultLocale = patch.defaultLocale;
  if (patch.accentColor !== undefined) set.accentColor = patch.accentColor?.toLowerCase() ?? null;
  if (Object.keys(set).length === 0) return getInstitution(ctx);
  const [row] = await ctx.tx.update(institution).set(set).where(eq(institution.id, ctx.caller.institutionId)).returning();
  return toDto(row!);
}
