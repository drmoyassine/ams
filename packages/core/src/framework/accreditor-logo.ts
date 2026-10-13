// An accreditor's logo, kept in the object store and shown on its standards. Only small raster images are accepted:
// SVG can carry script, so it is refused.
import { eq } from 'drizzle-orm';
import { accreditor } from '@ams/db';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError } from '../ctx.js';
import { require_ } from './common.js';
import { checkLogoBytes } from './logo-image.js';

export { MAX_LOGO_BYTES } from './logo-image.js';

async function getAccreditor(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(accreditor).where(eq(accreditor.id, id));
  if (!row) throw new NotFoundError(`accreditor ${id}`);
  return row;
}

/** Replaces the accreditor's logo. */
export async function setAccreditorLogo(ctx: Ctx, accreditorId: string, bytes: Uint8Array): Promise<void> {
  await require_(ctx, 'framework:write');
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  await getAccreditor(ctx, accreditorId);
  const mime = checkLogoBytes(bytes);
  const key = `${ctx.caller.institutionId}/accreditors/${accreditorId}/logo-${crypto.randomUUID()}`;
  try {
    await ctx.store.put(key, bytes, mime);
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'accreditor logo: storage refused the file', detail: (e as Error).message }));
    throw new ConflictError(`the logo could not be stored (${(e as Error).message})`);
  }
  await ctx.tx.update(accreditor).set({ logoPath: key, logoMime: mime, logoUpdatedAt: new Date() }).where(eq(accreditor.id, accreditorId));
}

export async function removeAccreditorLogo(ctx: Ctx, accreditorId: string): Promise<void> {
  await require_(ctx, 'framework:write');
  await getAccreditor(ctx, accreditorId);
  await ctx.tx.update(accreditor).set({ logoPath: null, logoMime: null, logoUpdatedAt: null }).where(eq(accreditor.id, accreditorId));
}

/** The logo's bytes and type, for the page to show. */
export async function readAccreditorLogo(ctx: Ctx, accreditorId: string): Promise<{ bytes: Uint8Array; mime: string }> {
  await require_(ctx, 'framework:read');
  const a = await getAccreditor(ctx, accreditorId);
  if (!a.logoPath) throw new NotFoundError('this accreditor has no logo');
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  const obj = await ctx.store.get(a.logoPath);
  if (!obj) throw new NotFoundError('the logo file is missing');
  return { bytes: obj.body, mime: a.logoMime ?? obj.mime };
}
