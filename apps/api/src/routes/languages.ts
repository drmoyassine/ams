import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  cancelTranslation, languagesSettings, listUiTranslations, markUiReviewed, resumeTranslation, saveUiTranslation, startTranslation, uiBundle, NotFoundError, ValidationError,
  languageStateOf,
} from '@ams/core';
import {
  I18nBundleSchema, LanguagesSettingsSchema, MarkUiReviewedSchema, SaveUiTranslationSchema, StartTranslationSchema, TranslationRunSchema,
  UiTranslationPageSchema, UiTranslationQuerySchema, UiTranslationRowSchema, isLanguageCode,
} from '@ams/shared';
import { requires, scopeFrom, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

/**
 * Languages (TASK-070): the Languages section of Settings -> Organization, the interface catalogue the app merges over English,
 * and the translation runs. Reading is for anyone who can read the organization; changing and translating are for administrators
 * (`institution:write`). The catalogue itself is served to every signed-in person.
 */
export function languageRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['languages'];
  const admin = requires('institution:write', scopeFrom.institution);
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/settings/languages', access: requires('org:read'), tags: tag,
      responses: { 200: { description: 'The secondary language, the interface catalogue\'s status, the latest translation run and whether one can start', ...json(LanguagesSettingsSchema) }, ...errors },
    }), async (c) => c.json(await languagesSettings(c.get('ctx')), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/settings/languages/translations', access: requires('org:read'), tags: tag,
      request: { query: UiTranslationQuerySchema },
      responses: { 200: { description: 'The review table: every English interface text beside its translation', ...json(UiTranslationPageSchema) }, ...errors },
    }), async (c) => {
      const q = c.req.valid('query');
      return c.json(await listUiTranslations(c.get('ctx'), { ...(q.filter ? { filter: q.filter } : {}), ...(q.q ? { q: q.q } : {}), ...(q.offset !== undefined ? { offset: q.offset } : {}), ...(q.limit !== undefined ? { limit: q.limit } : {}) }), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/settings/languages/translations', access: admin, tags: tag,
      request: { body: { required: true, ...json(SaveUiTranslationSchema) } },
      responses: { 200: { description: 'A person\'s translation: it is theirs from now on and a machine run never replaces it', ...json(UiTranslationRowSchema) }, ...errors },
    }), async (c) => c.json(await saveUiTranslation(c.get('ctx'), c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/settings/languages/translations/reviewed', access: admin, tags: tag,
      request: { body: { required: true, ...json(MarkUiReviewedSchema) } },
      responses: { 200: { description: 'How many were marked reviewed', ...json(z.object({ marked: z.number() })) }, ...errors },
    }), async (c) => c.json(await markUiReviewed(c.get('ctx'), c.req.valid('json').keys), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/settings/languages/translate', access: admin, tags: tag,
      request: { body: { required: true, ...json(StartTranslationSchema) } },
      responses: { 201: { description: 'Started: a background job translates what is missing, in batches', ...json(TranslationRunSchema) }, ...errors },
    }), async (c) => {
      const ctx = c.get('ctx');
      const body = c.req.valid('json');
      const state = await languageStateOf(ctx);
      if (!state.secondaryLanguage) throw new ValidationError('choose a secondary language first');
      return c.json(await startTranslation(ctx, { kind: body.kind, language: state.secondaryLanguage, retranslateStale: body.retranslateStale }), 201);
    })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/settings/languages/translate/{id}/cancel', access: admin, tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Cancelled; what was translated so far stays', ...json(TranslationRunSchema) }, ...errors },
    }), async (c) => c.json(await cancelTranslation(c.get('ctx'), c.req.valid('param').id), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/settings/languages/translate/{id}/resume', access: admin, tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Continues with what is still pending, under a fresh spend allowance', ...json(TranslationRunSchema) }, ...errors },
    }), async (c) => c.json(await resumeTranslation(c.get('ctx'), c.req.valid('param').id), 200))

    // Any signed-in person: the app merges this over English. ETag by the latest change; the browser revalidates every time.
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/i18n/{language}', access: requires('program:read'), tags: tag,
      request: { params: z.object({ language: z.string().min(2).max(20) }) },
      responses: { 200: { description: 'The interface catalogue of the institution\'s secondary language (key -> text)', ...json(I18nBundleSchema) }, 304: { description: 'Not modified' }, ...errors },
    }), async (c) => {
      const language = c.req.valid('param').language;
      if (!isLanguageCode(language)) throw new ValidationError(`"${language}" is not a language this application knows`);
      const bundle = await uiBundle(c.get('ctx'), language);
      if (!bundle) throw new NotFoundError(`interface catalogue for ${language}`);
      const etag = `"${bundle.etag}"`;
      const headers = { etag, 'cache-control': 'private, no-cache' };
      if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers) as never;
      return c.json(bundle, 200, headers);
    });
}
