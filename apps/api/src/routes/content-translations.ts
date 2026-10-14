import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  cancelContentTranslation, contentTranslationMap, contentTranslationStatus, listContentTranslations, markContentReviewed, resumeContentTranslation,
  saveContentTranslation, startContentTranslation,
} from '@ams/core';
import {
  ContentTranslationMapSchema, ContentTranslationPageSchema, ContentTranslationQuerySchema, ContentTranslationRowSchema, ContentTranslationStatusSchema,
  MarkContentReviewedSchema, SaveContentTranslationSchema, StartContentTranslationSchema, TranslationRunSchema,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

/**
 * The IQF and external standards in the secondary language (TASK-071). One framework version at a time: its status, the review
 * table, a person's edit, "reviewed", the map the library screens show beside the English, and the translate run with its
 * cancel and resume. Reading is `framework:read`; translating, editing and reviewing are `framework:write` (also on a
 * published version: a translation is stored beside the frozen English, never in it).
 */
export function contentTranslationRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['translations'];
  const write = requires('framework:write');
  const base = '/api/framework-versions/{id}/translations';
  const runParams = z.object({ id: z.uuid(), runId: z.uuid() });
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: base, access: requires('framework:read'), tags: tag, request: { params: idParam },
      responses: { 200: { description: 'How much of the version is translated into the secondary language, the latest run and whether one can start', ...json(ContentTranslationStatusSchema) }, ...errors },
    }), async (c) => c.json(await contentTranslationStatus(c.get('ctx'), c.req.valid('param').id), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: `${base}/map`, access: requires('framework:read'), tags: tag, request: { params: idParam },
      responses: { 200: { description: 'Every translation of the version, beside (never instead of) the English. Translations of an external standard are unofficial', ...json(ContentTranslationMapSchema) }, ...errors },
    }), async (c) => c.json(await contentTranslationMap(c.get('ctx'), c.req.valid('param').id), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: `${base}/items`, access: requires('framework:read'), tags: tag, request: { params: idParam, query: ContentTranslationQuerySchema },
      responses: { 200: { description: 'The review table: each English text of the version beside its translation', ...json(ContentTranslationPageSchema) }, ...errors },
    }), async (c) => {
      const q = c.req.valid('query');
      return c.json(await listContentTranslations(c.get('ctx'), c.req.valid('param').id, {
        ...(q.filter ? { filter: q.filter } : {}), ...(q.q ? { q: q.q } : {}), ...(q.offset !== undefined ? { offset: q.offset } : {}), ...(q.limit !== undefined ? { limit: q.limit } : {}),
      }), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'put', path: base, access: write, tags: tag,
      request: { params: idParam, body: { required: true, ...json(SaveContentTranslationSchema) } },
      responses: { 200: { description: 'A person\'s translation: it is theirs from now on and a machine run never replaces it', ...json(ContentTranslationRowSchema) }, ...errors },
    }), async (c) => c.json(await saveContentTranslation(c.get('ctx'), c.req.valid('param').id, c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: `${base}/reviewed`, access: write, tags: tag,
      request: { params: idParam, body: { required: true, ...json(MarkContentReviewedSchema) } },
      responses: { 200: { description: 'How many were marked reviewed', ...json(z.object({ marked: z.number() })) }, ...errors },
    }), async (c) => c.json(await markContentReviewed(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').items), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: `${base}/translate`, access: write, tags: tag,
      request: { params: idParam, body: { required: true, ...json(StartContentTranslationSchema) } },
      responses: { 201: { description: 'Started: a background job translates what is missing, in batches', ...json(TranslationRunSchema) }, ...errors },
    }), async (c) => c.json(await startContentTranslation(c.get('ctx'), c.req.valid('param').id, { retranslateStale: c.req.valid('json').retranslateStale }), 201))

    .openapi(secured(registry, deps, {
      method: 'post', path: `${base}/runs/{runId}/cancel`, access: write, tags: tag, request: { params: runParams },
      responses: { 200: { description: 'Cancelled; what was translated so far stays', ...json(TranslationRunSchema) }, ...errors },
    }), async (c) => { const p = c.req.valid('param'); return c.json(await cancelContentTranslation(c.get('ctx'), p.id, p.runId), 200); })

    .openapi(secured(registry, deps, {
      method: 'post', path: `${base}/runs/{runId}/resume`, access: write, tags: tag, request: { params: runParams },
      responses: { 200: { description: 'Continues with what is still pending, under a fresh spend allowance', ...json(TranslationRunSchema) }, ...errors },
    }), async (c) => { const p = c.req.valid('param'); return c.json(await resumeContentTranslation(c.get('ctx'), p.id, p.runId), 200); });
}
