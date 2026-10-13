// The institution's logo, kept in the object store and shown in the app header and on the sign-in page. The rules are
// the accreditor logo's (framework/logo-image.ts): PNG, JPEG or WebP by the bytes, at most 512 KB, no SVG.
import { eq } from 'drizzle-orm';
import { institution } from '@ams/db';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { checkLogoBytes } from '../framework/logo-image.js';
import { assertPermitted } from '../permissions.js';

async function currentRow(ctx: Ctx) {
  const [row] = await ctx.tx.select().from(institution).where(eq(institution.id, ctx.caller.institutionId));
  if (!row) throw new NotFoundError('institution');
  return row;
}

/** Drops a replaced or removed object once the change has committed; a missing object is not an error. */
function dropAfterCommit(ctx: Ctx, key: string | null) {
  if (!key || !ctx.store) return;
  const store = ctx.store;
  ctx.afterCommit(async () => { await store.delete(key); });
}

/** Replaces the institution's logo (administrators); the previous file is deleted from the store. */
export async function setInstitutionLogo(ctx: Ctx, bytes: Uint8Array): Promise<void> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'institution:write', { type: 'institution' });
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  const mime = checkLogoBytes(bytes);
  const row = await currentRow(ctx);
  const key = `${ctx.caller.institutionId}/institution/logo-${crypto.randomUUID()}`;
  try {
    await ctx.store.put(key, bytes, mime);
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'institution logo: storage refused the file', detail: (e as Error).message }));
    throw new ConflictError(`the logo could not be stored (${(e as Error).message})`);
  }
  await ctx.tx.update(institution).set({ logoPath: key, logoMime: mime, logoUpdatedAt: new Date() }).where(eq(institution.id, ctx.caller.institutionId));
  dropAfterCommit(ctx, row.logoPath);
}

export async function removeInstitutionLogo(ctx: Ctx): Promise<void> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'institution:write', { type: 'institution' });
  const row = await currentRow(ctx);
  if (!row.logoPath) return;
  await ctx.tx.update(institution).set({ logoPath: null, logoMime: null, logoUpdatedAt: null }).where(eq(institution.id, ctx.caller.institutionId));
  dropAfterCommit(ctx, row.logoPath);
}

/** The logo's bytes and type, for the signed-in app to show. */
export async function readInstitutionLogo(ctx: Ctx): Promise<{ bytes: Uint8Array; mime: string }> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const row = await currentRow(ctx);
  if (!row.logoPath) throw new NotFoundError('the institution has no logo');
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  const obj = await ctx.store.get(row.logoPath);
  if (!obj) throw new NotFoundError('the logo file is missing');
  return { bytes: obj.body, mime: row.logoMime ?? obj.mime };
}
