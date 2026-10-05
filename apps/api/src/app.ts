import { OpenAPIHono } from '@hono/zod-openapi';
import { ForbiddenError, NotFoundError } from '@ams/core';
import {
  assertAllRoutesDeclared, rawPublicRoute, RouteRegistry, type AppEnv, type Authenticator, type ChainDeps,
} from './chain.js';
import { buildRoutes } from './routes.js';
import type pg from 'pg';

export interface AppOptions {
  pool: pg.Pool;
  authenticate: Authenticator;
  /** Better Auth's request handler, mounted at /api/auth/*. */
  authHandler?: (req: Request) => Response | Promise<Response>;
  /** Extra route modules, registered before the startup check (used by tests to prove the check bites). */
  extend?: (app: OpenAPIHono<AppEnv>, registry: RouteRegistry, deps: ChainDeps) => void;
}

/** Builds the API. Throws if any route lacks a permission declaration. */
export function createApp(opts: AppOptions) {
  const registry = new RouteRegistry();
  const deps: ChainDeps = { pool: opts.pool, authenticate: opts.authenticate };
  const app = buildRoutes(registry, deps, {
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid_request', issues: result.error.issues }, 400);
    },
  });
  if (opts.authHandler) rawPublicRoute(app, registry, ['GET', 'POST'], '/api/auth/*', opts.authHandler);
  opts.extend?.(app, registry, deps);

  app.doc('/openapi.json', { openapi: '3.0.0', info: { title: 'AMS API', version: '0.0.0' } });
  registry.declared.set('GET /openapi.json', { kind: 'public' });

  app.onError((err, c) => {
    if (err instanceof ForbiddenError) return c.json({ error: 'forbidden', message: err.message }, 403);
    if (err instanceof NotFoundError) return c.json({ error: 'not_found' }, 404);
    console.error(JSON.stringify({ level: 'error', msg: err.message }));
    return c.json({ error: 'internal_error' }, 500);
  });

  assertAllRoutesDeclared(app, registry);
  return { app, registry };
}
