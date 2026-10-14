// The interface catalogue as a translation source (kind 'ui'): the English is packages/shared/src/locales/en.ts, the
// translations are the ui_translation rows of one language.
import { and, eq, sql } from 'drizzle-orm';
import { uiTranslation } from '@ams/db';
import { EN_CATALOGUE, UNTRANSLATED_KEYS } from '@ams/shared';
import { sourceHash, type TranslationItem, type TranslationSource } from './source.js';

/** The English strings that get translated, in catalogue order. */
export const translatableEntries = (): [string, string][] => Object.entries(EN_CATALOGUE).filter(([k]) => !UNTRANSLATED_KEYS.includes(k));

export const uiSource: TranslationSource = {
  kind: 'ui',

  async listPending(ctx, language, { includeStale }) {
    const rows = await ctx.tx.select({ key: uiTranslation.key, hash: uiTranslation.sourceHash, origin: uiTranslation.origin, reviewed: uiTranslation.reviewed })
      .from(uiTranslation).where(eq(uiTranslation.language, language));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const out: TranslationItem[] = [];
    for (const [key, text] of translatableEntries()) {
      const hash = sourceHash(text);
      const row = byKey.get(key);
      const missing = !row;
      // A stale row is re-translated only on request, and only when it is an unreviewed machine translation.
      const stale = !!row && includeStale && row.hash !== hash && row.origin === 'ai' && !row.reviewed;
      if (missing || stale) out.push({ id: key, text, hash, context: `interface text "${key}"` });
    }
    return out;
  },

  async saveTranslations(ctx, { language, runId, results }) {
    let n = 0;
    for (const { item, text } of results) {
      const rows = await ctx.tx.insert(uiTranslation).values({
        institutionId: ctx.caller.institutionId, language, key: item.id, sourceHash: item.hash, text, origin: 'ai', reviewed: false, runId,
      }).onConflictDoUpdate({
        target: [uiTranslation.institutionId, uiTranslation.language, uiTranslation.key],
        set: { text, sourceHash: item.hash, runId },
        // Never over a person's text or a reviewed one.
        setWhere: and(eq(uiTranslation.origin, 'ai'), eq(uiTranslation.reviewed, false)) ?? sql`false`,
      }).returning({ id: uiTranslation.id });
      n += rows.length;
    }
    return n;
  },
};
