// What the sign-in page may read of the language setting before anyone is authenticated (docs/organization-plan.md, "Public
// exposure"): the institution's default and secondary language codes, and the text of exactly the sign-in keys. Nothing else.
import type pg from 'pg';
import { resolvePublicLanguages } from '@ams/db';
import type { PublicI18n } from '@ams/shared';
import { publicUiKeys } from './catalogue.js';

export async function getPublicI18n(pool: pg.Pool): Promise<PublicI18n> {
  const r = await resolvePublicLanguages(pool, publicUiKeys());
  if (!r) return { defaultLocale: 'en', secondaryLanguage: null, strings: {} };
  return { defaultLocale: r.defaultLocale, secondaryLanguage: r.secondaryLanguage, strings: r.strings };
}
