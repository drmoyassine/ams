// The IQF and the external standards as translation sources (TASK-071; kinds 'iqf' and 'standard'). The English is the text of
// requirement (title, statement = official text) and requirement_note (text) of one framework version; the translations are
// content_translation rows of one language. Nothing here writes to those English tables: a translation lives beside the English,
// so it can be added to a published (frozen) version too.
//
// Translations of an external standard are UNOFFICIAL (DEC-028). The English (or the accreditor's original) stays the only text
// used for quote matching and exports; this module is never imported by them.
import { and, asc, eq } from 'drizzle-orm';
import { contentTranslation, framework, frameworkVersion, requirement, requirementNote } from '@ams/db';
import { CONTENT_TRANSLATION_FIELDS, nfc, type ContentTranslationField, type ContentTranslationKind } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { NotFoundError, ValidationError } from '../ctx.js';
import { sourceHash, type TranslationItem, type TranslationSource } from './source.js';

/** One translatable English text of a version, as it is now. */
export interface EnglishText {
  entityId: string;
  field: ContentTranslationField;
  /** The requirement's code (a note carries its requirement's). */
  code: string;
  text: string;
  /** Where the text is used, for the model (never translated). */
  context: string;
}

export const itemId = (entityId: string, field: ContentTranslationField) => `${entityId}:${field}`;
export function parseItemId(id: string): { entityId: string; field: ContentTranslationField } {
  const i = id.lastIndexOf(':');
  const field = id.slice(i + 1);
  if (i < 0 || !(CONTENT_TRANSLATION_FIELDS as readonly string[]).includes(field)) throw new Error(`not a content translation item id: ${id}`);
  return { entityId: id.slice(0, i), field: field as ContentTranslationField };
}

/** Which kind a framework version is translated as: the institution's own quality framework, or an external standard. */
export async function versionKindOf(ctx: Ctx, versionId: string): Promise<{ kind: ContentTranslationKind; status: string }> {
  const [row] = await ctx.tx.select({ internal: framework.internal, status: frameworkVersion.status }).from(frameworkVersion)
    .innerJoin(framework, eq(framework.id, frameworkVersion.frameworkId)).where(eq(frameworkVersion.id, versionId));
  if (!row) throw new NotFoundError(`framework version ${versionId}`);
  return { kind: row.internal ? 'iqf' : 'standard', status: row.status };
}

/**
 * The English texts of a version that can be translated into `language`, in reading order. A requirement written in another
 * language than English contributes its English translation of the statement (`translation_en`) when it has one; text already in
 * `language` is not translated; a title that is not English is left alone.
 */
export async function englishTexts(ctx: Ctx, versionId: string, language: string | null): Promise<EnglishText[]> {
  const reqs = await ctx.tx.select({
    id: requirement.id, code: requirement.code, title: requirement.title, officialText: requirement.officialText,
    language: requirement.language, translationEn: requirement.translationEn,
  }).from(requirement).where(eq(requirement.frameworkVersionId, versionId)).orderBy(asc(requirement.displayOrder), asc(requirement.code));
  const notes = await ctx.tx.select({ id: requirementNote.id, requirementId: requirementNote.requirementId, text: requirementNote.text, type: requirementNote.type })
    .from(requirementNote).innerJoin(requirement, eq(requirement.id, requirementNote.requirementId)).where(eq(requirement.frameworkVersionId, versionId))
    .orderBy(asc(requirementNote.createdAt), asc(requirementNote.id));
  const notesOf = new Map<string, typeof notes>();
  for (const n of notes) notesOf.set(n.requirementId, [...(notesOf.get(n.requirementId) ?? []), n]);
  const out: EnglishText[] = [];
  const has = (s: string | null | undefined): s is string => !!s && s.trim() !== '';
  for (const r of reqs) {
    const english = r.language === 'en';
    const alreadyInTarget = !!language && r.language === language;
    if (!alreadyInTarget) {
      if (english && has(r.title)) out.push({ entityId: r.id, field: 'title', code: r.code, text: r.title, context: `title of requirement ${r.code}` });
      const statement = english ? r.officialText : r.translationEn;
      if (has(statement)) out.push({ entityId: r.id, field: 'statement', code: r.code, text: statement, context: `statement of requirement ${r.code}: ${r.title}` });
    }
    for (const n of notesOf.get(r.id) ?? []) {
      if (has(n.text)) out.push({ entityId: n.id, field: 'note', code: r.code, text: n.text, context: `${n.type.replace('_', ' ')} note of requirement ${r.code}: ${r.title}` });
    }
  }
  return out;
}

/** The stored translations of a version in one language, by `${entityId}:${field}`. */
export async function storedFor(ctx: Ctx, versionId: string, language: string) {
  const rows = await ctx.tx.select().from(contentTranslation)
    .where(and(eq(contentTranslation.frameworkVersionId, versionId), eq(contentTranslation.language, language)));
  return new Map(rows.map((r) => [itemId(r.entityId, r.field), r]));
}

function contentSource(kind: ContentTranslationKind): TranslationSource {
  return {
    kind,

    async listPending(ctx, language, { includeStale, scopeId }) {
      if (!scopeId) throw new ValidationError(`translating ${kind === 'iqf' ? 'the IQF' : 'a standard'} needs a framework version`);
      const actual = await versionKindOf(ctx, scopeId);
      if (actual.kind !== kind) throw new ValidationError(kind === 'iqf' ? 'this version belongs to an external standard, not the institution\'s quality framework' : 'this version is the institution\'s own quality framework, not an external standard');
      const stored = await storedFor(ctx, scopeId, language);
      const out: TranslationItem[] = [];
      for (const e of await englishTexts(ctx, scopeId, language)) {
        const id = itemId(e.entityId, e.field);
        const hash = sourceHash(e.text);
        const row = stored.get(id);
        const missing = !row;
        // A stale row is re-translated only on request, and only when it is an unreviewed machine translation.
        const stale = !!row && includeStale && row.sourceHash !== hash && row.origin === 'ai' && !row.reviewed;
        if (missing || stale) out.push({ id, text: e.text, hash, context: e.context });
      }
      return out;
    },

    async saveTranslations(ctx, { language, scopeId, runId, results }) {
      if (!scopeId) throw new ValidationError('a framework version is needed');
      let n = 0;
      for (const { item, text } of results) {
        const { entityId, field } = parseItemId(item.id);
        const rows = await ctx.tx.insert(contentTranslation).values({
          institutionId: ctx.caller.institutionId, kind, frameworkVersionId: scopeId, entityId, field, language,
          sourceHash: item.hash, text: nfc(text), origin: 'ai', reviewed: false, runId,
        }).onConflictDoUpdate({
          target: [contentTranslation.institutionId, contentTranslation.language, contentTranslation.entityId, contentTranslation.field],
          set: { text: nfc(text), sourceHash: item.hash, runId },
          // Never over a person's text or a reviewed one.
          setWhere: and(eq(contentTranslation.origin, 'ai'), eq(contentTranslation.reviewed, false)),
        }).returning({ id: contentTranslation.id });
        n += rows.length;
      }
      return n;
    },
  };
}

export const iqfSource = contentSource('iqf');
export const standardSource = contentSource('standard');
