// The IQF and external standards in the secondary language (TASK-071): status of a version's translation, the review table, a
// person's edits, "reviewed", and the map the library screens read to show the translation beside the English.
//
// Rules that hold here (DEC-028): the English is never changed or replaced (these functions write only content_translation);
// a translation of an external standard is UNOFFICIAL and says so wherever it is shown (the label is the client's, the map
// carries the kind); a person's text is theirs and a later machine run never replaces it; a changed English text marks its
// translation out of date (source hash).
import { and, eq, or } from 'drizzle-orm';
import { contentTranslation, translationRun } from '@ams/db';
import {
  nfc, translationProblem,
  type ContentTranslationField, type ContentTranslationKind, type ContentTranslationMap, type ContentTranslationPage, type ContentTranslationRow, type ContentTranslationStatus,
  type TranslationRun,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { aiReadiness } from '../ai/settings.js';
import { assertHuman } from '../framework/common.js';
import { languageStateOf } from '../org/preferences.js';
import { assertPermitted, isPermitted } from '../permissions.js';
import { cancelTranslation, latestTranslationRun, resumeTranslation, startTranslation } from './engine.js';
import { englishTexts, itemId, storedFor, versionKindOf } from './content-source.js';
import { sourceHash } from './source.js';

async function secondaryOf(ctx: Ctx): Promise<string | null> {
  return (await languageStateOf(ctx)).secondaryLanguage;
}
async function requireSecondary(ctx: Ctx): Promise<string> {
  const s = await secondaryOf(ctx);
  if (!s) throw new ConflictError('the institution has no secondary language: choose one in Settings -> Organization');
  return s;
}

/** How much of a version is translated, the latest run, and whether a run can start. */
export async function contentTranslationStatus(ctx: Ctx, versionId: string): Promise<ContentTranslationStatus> {
  await assertPermitted(ctx, 'framework:read', { type: 'any' });
  const { kind } = await versionKindOf(ctx, versionId);
  const language = await secondaryOf(ctx);
  const base = { versionId, kind, secondaryLanguage: language, total: 0, translated: 0, reviewed: 0, stale: 0, byAi: 0, byPerson: 0, run: null, readiness: null };
  if (!language) return base;
  const stored = await storedFor(ctx, versionId, language);
  const texts = await englishTexts(ctx, versionId, language);
  let translated = 0; let reviewed = 0; let stale = 0; let byAi = 0; let byPerson = 0;
  for (const e of texts) {
    const r = stored.get(itemId(e.entityId, e.field));
    if (!r) continue;
    translated++;
    if (r.reviewed) reviewed++;
    if (r.sourceHash !== sourceHash(e.text)) stale++;
    if (r.origin === 'ai') byAi++; else byPerson++;
  }
  const mayStart = await isPermitted(ctx.tx, 'framework:write', { type: 'any' });
  const ready = mayStart ? await aiReadiness(ctx) : null;
  return {
    ...base, total: texts.length, translated, reviewed, stale, byAi, byPerson,
    run: await latestTranslationRun(ctx, kind, language, versionId),
    readiness: ready ? { ok: ready.ok, reason: ready.ok ? null : ready.reason } : null,
  };
}

export interface ContentListQuery { filter?: 'all' | 'missing' | 'needs_review' | 'reviewed' | 'stale'; q?: string; offset?: number; limit?: number }

/** The review table: every translatable English text of the version beside its translation. */
export async function listContentTranslations(ctx: Ctx, versionId: string, query: ContentListQuery = {}): Promise<ContentTranslationPage> {
  await assertPermitted(ctx, 'framework:read', { type: 'any' });
  await versionKindOf(ctx, versionId);
  const language = await secondaryOf(ctx);
  if (!language) return { total: 0, rows: [] };
  const stored = await storedFor(ctx, versionId, language);
  const needle = query.q?.trim().toLowerCase();
  const all: ContentTranslationRow[] = (await englishTexts(ctx, versionId, language)).map((e) => {
    const r = stored.get(itemId(e.entityId, e.field));
    return {
      entityId: e.entityId, field: e.field, code: e.code, english: e.text, text: r?.text ?? null, origin: r?.origin ?? null, reviewed: r?.reviewed ?? false,
      stale: !!r && r.sourceHash !== sourceHash(e.text), updatedAt: r?.updatedAt.toISOString() ?? null,
    };
  });
  const filtered = all.filter((r) => {
    if (needle && !`${r.code} ${r.english} ${r.text ?? ''}`.toLowerCase().includes(needle)) return false;
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

/**
 * A person writes or corrects a translation. It becomes theirs (origin person, reviewed): a later machine run never replaces it.
 * Allowed in a published version too: it changes no English, only the translation beside it.
 */
export async function saveContentTranslation(ctx: Ctx, versionId: string, input: { entityId: string; field: ContentTranslationField; text: string }): Promise<ContentTranslationRow> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'framework:write', { type: 'any' });
  const { kind } = await versionKindOf(ctx, versionId);
  const language = await requireSecondary(ctx);
  const english = (await englishTexts(ctx, versionId, language)).find((e) => e.entityId === input.entityId && e.field === input.field);
  if (!english) throw new NotFoundError(`${input.field} of ${input.entityId} in this version`);
  const text = nfc(input.text.trim());
  const problem = translationProblem(english.text, text);
  if (problem) throw new ValidationError(problem, [{ path: 'text', message: problem }]);
  const hash = sourceHash(english.text);
  const [row] = await ctx.tx.insert(contentTranslation).values({
    institutionId: ctx.caller.institutionId, kind, frameworkVersionId: versionId, entityId: input.entityId, field: input.field, language,
    sourceHash: hash, text, origin: 'person', reviewed: true,
  }).onConflictDoUpdate({
    target: [contentTranslation.institutionId, contentTranslation.language, contentTranslation.entityId, contentTranslation.field],
    set: { text, sourceHash: hash, origin: 'person', reviewed: true, frameworkVersionId: versionId, kind },
  }).returning();
  return { entityId: input.entityId, field: input.field, code: english.code, english: english.text, text: row!.text, origin: 'person', reviewed: true, stale: false, updatedAt: row!.updatedAt.toISOString() };
}

/** Marks translations of the version reviewed (the listed ones, or every one not yet reviewed). Returns how many changed. */
export async function markContentReviewed(ctx: Ctx, versionId: string, items?: { entityId: string; field: ContentTranslationField }[]): Promise<{ marked: number }> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'framework:write', { type: 'any' });
  await versionKindOf(ctx, versionId);
  const language = await requireSecondary(ctx);
  if (items && items.length === 0) return { marked: 0 };
  const where = and(
    eq(contentTranslation.frameworkVersionId, versionId), eq(contentTranslation.language, language), eq(contentTranslation.reviewed, false),
    items ? or(...items.map((i) => and(eq(contentTranslation.entityId, i.entityId), eq(contentTranslation.field, i.field)))) : undefined,
  );
  const rows = await ctx.tx.update(contentTranslation).set({ reviewed: true }).where(where).returning({ id: contentTranslation.id });
  return { marked: rows.length };
}

/** Every translation of the version, with stale flags, for the content switcher on the library screens. Any reader. */
export async function contentTranslationMap(ctx: Ctx, versionId: string): Promise<ContentTranslationMap> {
  await assertPermitted(ctx, 'framework:read', { type: 'any' });
  const { kind } = await versionKindOf(ctx, versionId);
  const language = await secondaryOf(ctx);
  if (!language) return { versionId, kind, language: null, entries: [] };
  const stored = await storedFor(ctx, versionId, language);
  const entries: ContentTranslationMap['entries'] = [];
  for (const e of await englishTexts(ctx, versionId, language)) {
    const r = stored.get(itemId(e.entityId, e.field));
    if (r) entries.push({ entityId: e.entityId, field: e.field, text: r.text, origin: r.origin, reviewed: r.reviewed, stale: r.sourceHash !== sourceHash(e.text) });
  }
  return { versionId, kind, language, entries };
}

// ---- Starting, cancelling, resuming a version's run (framework:write; the engine does the work) --------------------------------

export async function startContentTranslation(ctx: Ctx, versionId: string, options: { retranslateStale?: boolean; batchItems?: number } = {}): Promise<TranslationRun> {
  const { kind } = await versionKindOf(ctx, versionId);
  const language = await requireSecondary(ctx);
  return startTranslation(ctx, { kind, language, scopeId: versionId, retranslateStale: !!options.retranslateStale, ...(options.batchItems ? { batchItems: options.batchItems } : {}) });
}

async function runOfVersion(ctx: Ctx, versionId: string, runId: string): Promise<void> {
  const { kind } = await versionKindOf(ctx, versionId);
  const [run] = await ctx.tx.select({ scopeId: translationRun.scopeId, kind: translationRun.kind }).from(translationRun).where(eq(translationRun.id, runId));
  if (!run || run.scopeId !== versionId || run.kind !== kind) throw new NotFoundError(`translation run ${runId} of this version`);
}
export async function cancelContentTranslation(ctx: Ctx, versionId: string, runId: string): Promise<TranslationRun> {
  await runOfVersion(ctx, versionId, runId);
  return cancelTranslation(ctx, runId);
}
export async function resumeContentTranslation(ctx: Ctx, versionId: string, runId: string): Promise<TranslationRun> {
  await runOfVersion(ctx, versionId, runId);
  return resumeTranslation(ctx, runId);
}

export type { ContentTranslationKind };
