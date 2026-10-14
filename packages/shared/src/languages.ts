// Languages (TASK-070, docs/organization-plan.md section D). English is the primary language and never changes; an
// institution has ONE secondary language chosen from this registry. Each person picks their interface language: English or
// the institution's secondary one. The registry says how a language is written (direction, script) so the shell can set
// <html lang>, <html dir> and the font stack.
import { z } from 'zod';

export const PRIMARY_LANGUAGE = 'en';

/** The writing systems the font stacks (apps/web/src/index.css, `html[data-script=...]`) are defined for. */
export const SCRIPTS = ['latin', 'arabic', 'hebrew', 'cjk-sc', 'cjk-tc', 'cjk-jp', 'cjk-kr', 'devanagari', 'bengali', 'cyrillic', 'greek', 'thai'] as const;
export type ScriptKey = (typeof SCRIPTS)[number];

export interface LanguageInfo {
  /** BCP-47 code. The only identifier stored anywhere. */
  code: string;
  nameEn: string;
  /** The language's name in itself, shown in menus so a speaker can find it. */
  nativeName: string;
  dir: 'ltr' | 'rtl';
  script: ScriptKey;
}

const L = (code: string, nameEn: string, nativeName: string, script: ScriptKey, dir: 'ltr' | 'rtl' = 'ltr'): LanguageInfo => ({ code, nameEn, nativeName, dir, script });

/** About thirty languages; English first, then right-to-left ones, then the rest by region. */
export const LANGUAGES: readonly LanguageInfo[] = [
  L('en', 'English', 'English', 'latin'),
  L('ar', 'Arabic', 'العربية', 'arabic', 'rtl'),
  L('he', 'Hebrew', 'עברית', 'hebrew', 'rtl'),
  L('fa', 'Persian', 'فارسی', 'arabic', 'rtl'),
  L('ur', 'Urdu', 'اردو', 'arabic', 'rtl'),
  L('ps', 'Pashto', 'پښتو', 'arabic', 'rtl'),
  L('sd', 'Sindhi', 'سنڌي', 'arabic', 'rtl'),
  L('ku-Arab', 'Kurdish (Sorani)', 'کوردی', 'arabic', 'rtl'),
  L('fr', 'French', 'Français', 'latin'),
  L('es', 'Spanish', 'Español', 'latin'),
  L('pt', 'Portuguese', 'Português', 'latin'),
  L('de', 'German', 'Deutsch', 'latin'),
  L('it', 'Italian', 'Italiano', 'latin'),
  L('nl', 'Dutch', 'Nederlands', 'latin'),
  L('sv', 'Swedish', 'Svenska', 'latin'),
  L('pl', 'Polish', 'Polski', 'latin'),
  L('tr', 'Turkish', 'Türkçe', 'latin'),
  L('ru', 'Russian', 'Русский', 'cyrillic'),
  L('uk', 'Ukrainian', 'Українська', 'cyrillic'),
  L('el', 'Greek', 'Ελληνικά', 'greek'),
  L('zh-Hans', 'Chinese (Simplified)', '简体中文', 'cjk-sc'),
  L('zh-Hant', 'Chinese (Traditional)', '繁體中文', 'cjk-tc'),
  L('ja', 'Japanese', '日本語', 'cjk-jp'),
  L('ko', 'Korean', '한국어', 'cjk-kr'),
  L('hi', 'Hindi', 'हिन्दी', 'devanagari'),
  L('bn', 'Bengali', 'বাংলা', 'bengali'),
  L('th', 'Thai', 'ไทย', 'thai'),
  L('vi', 'Vietnamese', 'Tiếng Việt', 'latin'),
  L('id', 'Indonesian', 'Bahasa Indonesia', 'latin'),
  L('ms', 'Malay', 'Bahasa Melayu', 'latin'),
  L('sw', 'Swahili', 'Kiswahili', 'latin'),
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export const isLanguageCode = (code: unknown): code is string => typeof code === 'string' && BY_CODE.has(code);
export const languageInfo = (code: string | null | undefined): LanguageInfo | null => (code ? BY_CODE.get(code) ?? null : null);
/** A language an institution may choose as its secondary one: in the registry, and not English. */
export const isSecondaryLanguageCode = (code: unknown): code is string => isLanguageCode(code) && code !== PRIMARY_LANGUAGE;
export const directionOf = (code: string | null | undefined): 'ltr' | 'rtl' => languageInfo(code)?.dir ?? 'ltr';
export const scriptOf = (code: string | null | undefined): ScriptKey => languageInfo(code)?.script ?? 'latin';
/** The registry entries an institution may pick from (everything but English), in menu order. */
export const SECONDARY_CHOICES: readonly LanguageInfo[] = LANGUAGES.filter((l) => l.code !== PRIMARY_LANGUAGE);

/** Why `code` cannot be the institution's secondary language, or null when it can (null itself means "none"). */
export function secondaryLanguageProblem(code: string | null): string | null {
  if (code === null) return null;
  if (code === PRIMARY_LANGUAGE) return 'English is always the primary language; choose a different secondary language or none';
  if (!isLanguageCode(code)) return `"${code}" is not a language this application knows`;
  return null;
}

/**
 * Why `locale` cannot be an interface language given the institution's secondary language, or null when it can: a person
 * (or the institution's default) uses English or the secondary language, nothing else.
 */
export function uiLocaleProblem(locale: string | null, secondary: string | null): string | null {
  if (locale === null || locale === PRIMARY_LANGUAGE) return null;
  if (secondary && locale === secondary) return null;
  return secondary
    ? `the interface language must be English or ${languageInfo(secondary)?.nameEn ?? secondary}`
    : 'the interface language must be English: the institution has no secondary language';
}

/** The interface language in force: the person's own choice if still valid, else the institution's default if valid, else English. */
export function effectiveLocale(own: string | null | undefined, institutionDefault: string | null | undefined, secondary: string | null): string {
  if (own && uiLocaleProblem(own, secondary) === null) return own;
  if (institutionDefault && uiLocaleProblem(institutionDefault, secondary) === null) return institutionDefault;
  return PRIMARY_LANGUAGE;
}

/** NFC, as every stored text is (Arabic letters can be written with composed or decomposed forms). */
export const nfc = (s: string) => s.normalize('NFC');

// ---- DTOs ----------------------------------------------------------------------------------------------------------

export const LanguageStateSchema = z.object({
  /** The institution's secondary language, or null. */
  secondaryLanguage: z.string().nullable(),
  /** The interface language for people who have not chosen one: `en` or the secondary language. */
  defaultLocale: z.string(),
  /** This person's own choice, or null. */
  uiLocale: z.string().nullable(),
  /** What applies to this person now. */
  effectiveLocale: z.string(),
});
export type LanguageState = z.infer<typeof LanguageStateSchema>;

export const UpdateMyPreferencesSchema = z.object({ uiLocale: z.string().nullable() }).strict();
export type UpdateMyPreferences = z.infer<typeof UpdateMyPreferencesSchema>;

// ---- Translation runs and the interface catalogue -------------------------------------------------------------------

/** What can be translated. The engine is generic; TASK-071 adds the content kinds (requirements, notes, glossary...). */
export const TRANSLATION_KINDS = ['ui'] as const;
export type TranslationKind = (typeof TRANSLATION_KINDS)[number];

export const TRANSLATION_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'stopped'] as const;
export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number];
export const ACTIVE_TRANSLATION_STATUSES = ['queued', 'running'] as const satisfies readonly TranslationStatus[];
/** Runs a person may resume: the spend limit stopped it, a person cancelled it, or it failed. */
export const RESUMABLE_TRANSLATION_STATUSES = ['stopped', 'cancelled', 'failed'] as const satisfies readonly TranslationStatus[];

export const TranslationRunSchema = z.object({
  id: z.string(),
  kind: z.enum(TRANSLATION_KINDS),
  language: z.string(),
  scopeId: z.string().nullable(),
  status: z.enum(TRANSLATION_STATUSES),
  retranslateStale: z.boolean(),
  progress: z.object({
    /** Items this run set out to translate (counted when it started or was resumed). */
    total: z.number(), done: z.number(), flagged: z.number(), batches: z.number(),
  }),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().nullable(), calls: z.number() }),
  model: z.string().nullable(),
  error: z.string().nullable(),
  /** Items the checks refused twice (a placeholder dropped or changed, empty answer): not saved, shown in English. */
  flagged: z.array(z.object({ id: z.string(), reason: z.string() })),
  startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
});
export type TranslationRun = z.infer<typeof TranslationRunSchema>;

export const StartTranslationSchema = z.object({
  kind: z.enum(TRANSLATION_KINDS).default('ui'),
  /** Also re-translate machine translations nobody has reviewed whose English has changed since. */
  retranslateStale: z.boolean().default(false),
}).strict();
export type StartTranslation = z.infer<typeof StartTranslationSchema>;

export const UiCatalogueStatusSchema = z.object({
  language: z.string(),
  /** Strings in the English catalogue that are translated (the product name is not). */
  total: z.number(),
  translated: z.number(),
  reviewed: z.number(),
  /** Translations whose English has changed since they were made. */
  stale: z.number(),
  byAi: z.number(), byPerson: z.number(),
});
export type UiCatalogueStatus = z.infer<typeof UiCatalogueStatusSchema>;

export const LanguagesSettingsSchema = z.object({
  secondaryLanguage: z.string().nullable(),
  defaultLocale: z.string(),
  /** Null when there is no secondary language. */
  catalogue: UiCatalogueStatusSchema.nullable(),
  /** The latest interface translation run for the secondary language, if any. */
  run: TranslationRunSchema.nullable(),
  /** Whether a run can start now; only filled in for people who can start one. */
  readiness: z.object({ ok: z.boolean(), reason: z.string().nullable() }).nullable(),
});
export type LanguagesSettings = z.infer<typeof LanguagesSettingsSchema>;

export const UI_REVIEW_FILTERS = ['all', 'missing', 'needs_review', 'reviewed', 'stale'] as const;
export const UiTranslationRowSchema = z.object({
  key: z.string(), english: z.string(),
  text: z.string().nullable(),
  origin: z.enum(['ai', 'person']).nullable(),
  reviewed: z.boolean(),
  stale: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type UiTranslationRow = z.infer<typeof UiTranslationRowSchema>;
export const UiTranslationPageSchema = z.object({ total: z.number(), rows: z.array(UiTranslationRowSchema) });
export type UiTranslationPage = z.infer<typeof UiTranslationPageSchema>;

export const UiTranslationQuerySchema = z.object({
  filter: z.enum(UI_REVIEW_FILTERS).optional(),
  q: z.string().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const SaveUiTranslationSchema = z.object({ key: z.string().min(1), text: z.string().min(1).max(4000) }).strict();
export type SaveUiTranslation = z.infer<typeof SaveUiTranslationSchema>;
export const MarkUiReviewedSchema = z.object({
  /** The keys to mark; omitted means every translation that is not reviewed yet. */
  keys: z.array(z.string()).max(2000).optional(),
}).strict();

/** The catalogue served to the signed-in app: the secondary language's strings merged over English at runtime. */
export const I18nBundleSchema = z.object({ language: z.string(), etag: z.string(), strings: z.record(z.string(), z.string()) });
export type I18nBundle = z.infer<typeof I18nBundleSchema>;

/** What the sign-in page may read before anyone is authenticated: the language setting and the sign-in strings, nothing else. */
export const PublicI18nSchema = z.object({
  defaultLocale: z.string(),
  secondaryLanguage: z.string().nullable(),
  strings: z.record(z.string(), z.string()),
});
export type PublicI18n = z.infer<typeof PublicI18nSchema>;
