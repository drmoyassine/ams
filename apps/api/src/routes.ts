import { z } from '@hono/zod-openapi';
import { createProgram, listPrograms } from '@ams/core';
import { CreateProgramSchema, ProgramSchema } from '@ams/shared';
import { requires, publicRoute, type AppEnv, type ChainDeps, type RouteRegistry } from './chain.js';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { secureRoute } from './chain.js';

const json = <T extends z.ZodType>(schema: T) => ({ content: { 'application/json': { schema } } });

export function registerRoutes(app: OpenAPIHono<AppEnv>, registry: RouteRegistry, deps: ChainDeps): void {
  secureRoute(app, registry, deps, {
    method: 'get', path: '/healthz', access: publicRoute(),
    responses: { 200: { description: 'Liveness', ...json(z.object({ ok: z.literal(true) })) } },
  }, (c) => c.json({ ok: true as const }, 200));

  secureRoute(app, registry, deps, {
    method: 'get', path: '/api/programs', access: requires('program:read'),
    tags: ['programs'],
    responses: {
      200: { description: 'Programs visible to the caller', ...json(z.array(ProgramSchema)) },
      401: { description: 'Unauthenticated' },
      403: { description: 'Forbidden' },
    },
  }, async (c) => c.json(await listPrograms(c.get('ctx')), 200));

  secureRoute(app, registry, deps, {
    method: 'post', path: '/api/programs', access: requires('program:write'),
    tags: ['programs'],
    request: { body: { required: true, ...json(CreateProgramSchema) } },
    responses: {
      201: { description: 'Created', ...json(ProgramSchema) },
      400: { description: 'Invalid input' },
      401: { description: 'Unauthenticated' },
      403: { description: 'Forbidden' },
    },
  }, async (c) => c.json(await createProgram(c.get('ctx'), c.req.valid('json')), 201));
}
