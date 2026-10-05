import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import { createProgram, listPrograms } from '@ams/core';
import { CreateProgramSchema, ProgramSchema } from '@ams/shared';
import { publicRoute, requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from './chain.js';
import { frameworkRoutes } from './routes/frameworks.js';
import { requirementRoutes } from './routes/requirements.js';
import { templateRoutes } from './routes/templates.js';

const json = <T extends z.ZodType>(schema: T) => ({ content: { 'application/json': { schema } } });

/** Routes are chained so the app's type carries every path, input and output to the typed RPC client. */
export function buildRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/healthz', access: publicRoute(),
      responses: { 200: { description: 'Liveness', ...json(z.object({ ok: z.literal(true) })) } },
    }), (c) => c.json({ ok: true as const }, 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/programs', access: requires('program:read'),
      tags: ['programs'],
      responses: {
        200: { description: 'Programs visible to the caller', ...json(z.array(ProgramSchema)) },
        401: { description: 'Unauthenticated' },
        403: { description: 'Forbidden' },
      },
    }), async (c) => c.json(await listPrograms(c.get('ctx')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/programs', access: requires('program:write'),
      tags: ['programs'],
      request: { body: { required: true, ...json(CreateProgramSchema) } },
      responses: {
        201: { description: 'Created', ...json(ProgramSchema) },
        400: { description: 'Invalid input' },
        401: { description: 'Unauthenticated' },
        403: { description: 'Forbidden' },
      },
    }), async (c) => c.json(await createProgram(c.get('ctx'), c.req.valid('json')), 201))

    // Framework library (M1). Each module chains its own routes so their types merge into ApiRoutes.
    .route('/', frameworkRoutes(registry, deps, options))
    .route('/', requirementRoutes(registry, deps, options))
    .route('/', templateRoutes(registry, deps, options));
}

export type ApiRoutes = ReturnType<typeof buildRoutes>;
