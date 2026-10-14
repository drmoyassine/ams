// The interface catalogue of the secondary language (TASK-070): status, the review table, a person's edits, and what is served
// to the app. The English is packages/shared/src/locales/en.ts; the translations are ui_translation rows.
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { institution, uiTranslation } from '@ams/db';
import {
  EN_CATALOGUE, PUBLIC_UI_KEYS, nfc, translationProblem,
  type I18nBundle, type LanguagesSettings, type UiCatalogueStatus, type UiTranslationPage, type UiTranslationRow,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { aiReadiness } from '../ai/settings.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted, isPermitted } from '../permissions.js';
import { sourceHash } from './source.js';
import { latestTranslationRun } from './engine.js';
import { translatableEntries } from './ui-source.js';

async function secondaryLanguageOf(ctx: Ctx): Promise<string | null> {
  const [row] = await ctx.tx.select({ s: institution.secondaryLanguage }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  if (!row) throw new NotFoundError('institution');
  return row.s;
}
async function requireSecondary(ctx: Ctx): Promise<string> {
  const s = await secondaryLanguageOf(ctx);
  if (!s) throw new ConflictError('the institution has no secondary language: choose one in Settings -> Organization');
  return s;
}

async function rowsOf(ctx: Ctx, language: string) {
  const rows = await ctx.tx.select().from(uiTranslation).where(eq(uiTranslation.language, language));
  return new Map(rows.map((r) => [r.key, r]));
}

export async function uiCatalogueStatus(ctx: Ctx, language: string): Promise<UiCatalogueStatus> {
  const rows = await rowsOf(ctx, language);
  const entries = translatableEntries();
  let translated = 0; let reviewed = 0; let stale = 0; let byAi = 0; let byPerson = 0;
  for (const [key, english] of entries) {
    const r = rows.get(key);
    if (!r) continue;
    translated++;
    if (r.reviewed) reviewed++;
    if (r.sourceHash !== sourceHash(english)) stale++;
    if (r.origin === 'ai') byAi++; else byPerson++;
  }
  return { language, total: entries.length, translated, reviewed, stale, byAi, byPerson };
}

/** The Languages section's data: the setting, the catalogue's status, the latest run, and whether a run can start. */
export async function languagesSettings(ctx: Ctx): Promise<LanguagesSettings> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const [inst] = await ctx.tx.select({ s: institution.secondaryLanguage, d: institution.defaultLocale }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  if (!inst) throw new NotFoundError('institution');
  if (!inst.s) return { secondaryLanguage: null, defaultLocale: inst.d, catalogue: null, run: null, readiness: null };
  const mayStart = await isPermitted(ctx.tx, 'institution:write', { type: 'institution' });
  const ready = mayStart ? await aiReadiness(ctx) : null;
  return {
    secondaryLanguage: inst.s, defaultLocale: inst.d,
    catalogue: await uiCatalogueStatus(ctx, inst.s),
    run: await latestTranslationRun(ctx, 'ui', inst.s),
    readiness: ready ? { ok: ready.ok, reason: ready.ok ? null : ready.reason } : null,
  };
}

export interface UiListQuery { filter?: 'all' | 'missing' | 'needs_review' | 'reviewed' | 'stale'; q?: string; offset?: number; limit?: number }

export async function listUiTranslations(ctx: Ctx, query: UiListQuery = {}): Promise<UiTranslationPage> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const language = await secondaryLanguageOf(ctx);
  if (!language) return { total: 0, rows: [] };
  const rows = await rowsOf(ctx, language);
  const needle = query.q?.trim().toLowerCase();
  const all: UiTranslationRow[] = translatableEntries().map(([key, english]) => {
    const r = rows.get(key);
    return {
      key, english, text: r?.text ?? null, origin: r?.origin ?? null, reviewed: r?.reviewed ?? false,
      stale: !!r && r.sourceHash !== sourceHash(english), updatedAt: r?.updatedAt.toISOString() ?? null,
    };
  });
  const filtered = all.filter((r) => {
    if (needle && !`${r.key} ${r.english} ${r.text ?? ''}`.toLowerCase().includes(needle)) return false;
    switch (query.filter) {
      case 'missing': return r.text === null;
      case 'needs_review': return r.text !== null && !r.reviewed;
      case 'reviewed': return r.reviewed;
      case 'stale': return r.stale;
      default: return true;
    }
  });
  const offset = query.offset ?? 0;
  return { total: filtered.length, rows: filtered.slice(offset, offset + (query.limit ?? 50)) };
}

/** A person writes or corrects a translation. It becomes theirs (origin person, reviewed): a later machine run never replaces it. */
export async function saveUiTranslation(ctx: Ctx, input: { key: string; text: string }): Promise<UiTranslationRow> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'institution:write', { type: 'institution' });
  const language = await requireSecondary(ctx);
  const english = EN_CATALOGUE[input.key];
  if (english === undefined || !translatableEntries().some(([k]) => k === input.key)) throw new NotFoundError(`interface text ${input.key}`);
  const text = nfc(input.text.trim());
  const problem = translationProblem(english, text);
  if (problem) throw new ValidationError(problem, [{ path: 'text', message: problem }]);
  const hash = sourceHash(english);
  const [row] = await ctx.tx.insert(uiTranslation).values({
    institutionId: ctx.caller.institutionId, language, key: input.key, sourceHash: hash, text, origin: 'person', reviewed: true,
  }).onConflictDoUpdate({
    target: [uiTranslation.institutionId, uiTranslation.language, uiTranslation.key],
    set: { text, sourceHash: hash, origin: 'person', reviewed: true },
  }).returning();
  return { key: input.key, english, text: row!.text, origin: 'person', reviewed: true, stale: false, updatedAt: row!.updatedAt.toISOString() };
}

/** Marks translations reviewed (the listed keys, or every one not yet reviewed). Returns how many changed. */
export async function markUiReviewed(ctx: Ctx, keys?: string[]): Promise<{ marked: number }> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'institution:write', { type: 'institution' });
  const language = await requireSecondary(ctx);
  const where = and(eq(uiTranslation.language, language), eq(uiTranslation.reviewed, false), keys ? inArray(uiTranslation.key, keys) : undefined);
  const rows = await ctx.tx.update(uiTranslation).set({ reviewed: true }).where(where).returning({ id: uiTranslation.id });
  return { marked: rows.length };
}

/**
 * The catalogue served to the app for the institution's secondary language: key -> text, only for keys that exist in the English
 * (a key removed from the code is not served), with an ETag that changes whenever a translation does. Any signed-in person.
 */
export async function uiBundle(ctx: Ctx, language: string): Promise<I18nBundle | null> {
  const secondary = await secondaryLanguageOf(ctx);
  if (!secondary || secondary !== language) return null;
  const rows = await ctx.tx.select({ key: uiTranslation.key, text: uiTranslation.text, at: uiTranslation.updatedAt }).from(uiTranslation).where(eq(uiTranslation.language, language));
  const strings: Record<string, string> = {};
  let latest = 0;
  for (const r of rows) {
    if (r.key in EN_CATALOGUE) { strings[r.key] = r.text; latest = Math.max(latest, r.at.getTime()); }
  }
  const etag = createHash('sha1').update(`${language}:${Object.keys(strings).length}:${latest}`).digest('hex').slice(0, 20);
  return { language, etag, strings };
}

/** Which of the catalogue's keys may be served before sign-in (the sign-in page's own text). */
export const publicUiKeys = (): string[] => PUBLIC_UI_KEYS.filter((k) => k in EN_CATALOGUE);
