// The one thing the application serves before sign-in (the sign-in page): the institution's display name, accent colour
// and logo. A deployment serves one institution; with none or several, nothing is shown (never a guess). Nothing else
// about the institution is exposed here: no id, country, language, units or people (docs/organization-plan.md).
import type pg from 'pg';
import { resolvePublicBranding } from '@ams/db';
import { isReadableAccent, type PublicBranding } from '@ams/shared';
import type { ObjectStore } from '../ctx.js';

export const PUBLIC_LOGO_PATH = '/api/public/branding/logo';

export async function getPublicBranding(pool: pg.Pool): Promise<PublicBranding> {
  const r = await resolvePublicBranding(pool);
  if (!r) return { name: null, accentColor: null, logoUrl: null };
  return {
    name: r.nameAr && r.defaultLocale === 'ar' ? r.nameAr : r.nameEn,
    accentColor: r.accentColor && isReadableAccent(r.accentColor) ? r.accentColor : null,
    logoUrl: r.logoPath && r.logoUpdatedAt ? `${PUBLIC_LOGO_PATH}?v=${r.logoUpdatedAt.getTime()}` : null,
  };
}

/** The logo's bytes, only for the institution the sign-in page shows; null when there is none. */
export async function readPublicLogo(pool: pg.Pool, store: ObjectStore | undefined): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const r = await resolvePublicBranding(pool);
  if (!r?.logoPath || !store) return null;
  const obj = await store.get(r.logoPath);
  return obj ? { bytes: obj.body, mime: r.logoMime ?? obj.mime } : null;
}
