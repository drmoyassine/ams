import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  collectionConfig, listCollectionRuns, MAX_UPLOAD_BYTES, retryRun, runNow, runsOfItem, skipRun, supplyByCallback, supplyRunWithVersion, ValidationError,
} from '@ams/core';
import { CollectionConfigSchema, CollectionRunSchema, CollectionRunsQuerySchema, SkipRunSchema, SupplyRunSchema, toDto } from '@ams/shared';
import { requires, runCallback, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

const noBi = { config: { baseUrl: null, apiKey: null, endpoints: {}, publicUrl: null, production: false }, client: null } as const;

/**
 * Evidence collection runs (TASK-090, DEC-031): the people's side (list, "Run now", skip, retry, mark supplied) and the BI's callback.
 * `GET /api/bi/v0/runs?updatedSince=` (contract section 5) is planned and NOT built yet: the BI is told what to produce by the AMS's own
 * request to it (docs/ams-bi-contract-v0.md 3.6), so it has nothing to poll for.
 */
export function collectionRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['collection runs'];
  const bi = () => deps.bi ?? noBi;
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/collection-config', access: requires('evidence:read'), tags: tag,
      description: 'Whether the BI is set up on the server (no secrets): the screens show "not configured" for a BI item when it is not.',
      responses: { 200: { description: 'The BI configuration state', ...json(CollectionConfigSchema) }, ...errors },
    }), async (c) => c.json(toDto(CollectionConfigSchema, collectionConfig(deps.bi)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/collection-runs', access: requires('evidence:read'), tags: tag,
      description: 'Runs the caller may see. status is one or more of pending, requested, supplied, late, failed, skipped (comma-separated); mine=true narrows to runs of items the caller owns.',
      request: { query: CollectionRunsQuerySchema },
      responses: { 200: { description: 'Runs', ...json(z.array(CollectionRunSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(CollectionRunSchema), await listCollectionRuns(c.get('ctx'), c.req.valid('query'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/evidence/{id}/runs', access: requires('evidence:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The runs of one evidence item, newest period first', ...json(z.array(CollectionRunSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(CollectionRunSchema), await runsOfItem(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence/{id}/runs/now', access: requires('evidence:write'), tags: tag,
      description: 'Makes the run for today\'s period (or tries the failed one again) and carries it out by the item\'s method. A BI call is waited for, up to the item\'s timeout.',
      request: { params: idParam },
      responses: { 201: { description: 'The run, as it stands after it was carried out', ...json(CollectionRunSchema) }, ...errors },
    }), async (c) => c.json(toDto(CollectionRunSchema, await runNow(c.get('ctx'), c.req.valid('param').id, { bi: bi() })), 201))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/collection-runs/{id}/skip', access: requires('evidence:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(SkipRunSchema) } },
      responses: { 200: { description: 'Skipped, with the reason; its open request is cancelled', ...json(CollectionRunSchema) }, ...errors },
    }), async (c) => c.json(toDto(CollectionRunSchema, await skipRun(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/collection-runs/{id}/retry', access: requires('evidence:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Tried again at once; the run as it stands', ...json(CollectionRunSchema) }, ...errors },
    }), async (c) => c.json(toDto(CollectionRunSchema, await retryRun(c.get('ctx'), c.req.valid('param').id, { bi: bi() })), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/collection-runs/{id}/supply', access: requires('evidence:write'), tags: tag,
      description: 'Marks the run supplied by an existing version of the same evidence item.',
      request: { params: idParam, body: { required: true, ...json(SupplyRunSchema) } },
      responses: { 200: { description: 'Supplied', ...json(CollectionRunSchema) }, ...errors },
    }), async (c) => c.json(toDto(CollectionRunSchema, await supplyRunWithVersion(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    // ---- The BI's callback (docs/ams-bi-contract-v0.md 4.2): no session; the run's one-time token is the credential ----------------
    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/bi/v0/runs/{id}/supply', access: runCallback(), tags: tag,
      description: 'The BI supplies a run it accepted (it answered 202). Authorization: Bearer <the run\'s callbackToken>, valid once and until it expires. '
        + 'Body: exactly one of rows (a dataset), fileBase64 + fileName (+ mime) or url (https), with asOf (yyyy-mm-dd) and optional lineage and notes. '
        + '401: the token is used, expired or wrong. 409: the run is not waiting for a supply. 422: the body does not fit the item (issues say where).',
      request: { params: idParam, body: { required: true, ...json(z.record(z.string(), z.unknown())) } },
      responses: {
        200: { description: 'Supplied: the run, now supplied by the new version', ...json(CollectionRunSchema) },
        401: { description: 'The token is used, has expired or is not valid', ...json(z.object({ error: z.string(), message: z.string() })) },
        409: { description: 'The run is not waiting for a supply', ...json(z.object({ error: z.string(), message: z.string() })) },
        422: { description: 'The body does not fit', ...json(z.object({ error: z.string(), message: z.string(), issues: z.array(z.object({ path: z.string(), message: z.string() })) })) },
      },
    }), async (c) => {
      // A body this large cannot be a supply (a file is capped by the evidence limit; base64 adds a third).
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 1_000_000) {
        return c.json({ error: 'invalid_request', message: 'the supply is larger than the evidence size limit', issues: [{ path: 'fileBase64', message: `the file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB` }] }, 422) as never;
      }
      try {
        const run = await supplyByCallback(c.get('ctx'), c.get('linkTargetId'), c.get('callbackToken'), c.req.valid('json'));
        return c.json(toDto(CollectionRunSchema, run), 200) as never;
      } catch (e) {
        if (e instanceof ValidationError) return c.json({ error: 'invalid_request', message: e.message, issues: e.issues }, 422) as never;
        throw e;
      }
    });
}
