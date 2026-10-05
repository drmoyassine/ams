import { OpenAPIHono, z } from '@hono/zod-openapi';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { assertAllRoutesDeclared, publicRoute, RouteRegistry, secureRoute, type AppEnv } from './chain.js';

// No database is needed: nothing here opens a connection.
const pool = new pg.Pool({ connectionString: 'postgres://nobody@localhost:1/none' });
const authenticate = async () => null;

describe('route permission coverage', () => {
  it('every route of the real app declares access', () => {
    const { app, registry } = createApp({ pool, authenticate });
    expect(app.routes.length).toBeGreaterThan(0);
    expect(() => assertAllRoutesDeclared(app, registry)).not.toThrow();
    expect([...registry.declared.values()].every((a) => a.kind === 'public' || a.kind === 'permission')).toBe(true);
  });

  it('startup fails when a route is registered without requires(...)', () => {
    expect(() => createApp({
      pool, authenticate,
      extend: (app, registry, deps) => {
        secureRoute(app, registry, deps, {
          method: 'get', path: '/api/rogue',
          responses: { 200: { description: 'x' } },
        } as never, (() => new Response()) as never);
      },
    })).toThrow(/no requires\(\.\.\.\)/);
  });

  it('startup fails when a route bypasses the helper with a raw app.get', () => {
    expect(() => createApp({
      pool, authenticate,
      extend: (app) => { app.get('/api/sneaky', (c) => c.json({})); },
    })).toThrow(/Routes registered without a requires\(\.\.\.\) declaration: GET \/api\/sneaky/);
  });

  it('a raw app.all() cannot hide behind the middleware exemption', () => {
    expect(() => createApp({
      pool, authenticate,
      extend: (app) => { app.all('/api/anything', (c) => c.json({})); },
    })).toThrow(/ALL \/api\/anything/);
  });

  it('refuses to register the same route twice', () => {
    const app = new OpenAPIHono<AppEnv>();
    const registry = new RouteRegistry();
    const cfg = {
      method: 'get' as const, path: '/x', access: publicRoute(),
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({}) } } } },
    };
    secureRoute(app, registry, { pool, authenticate }, cfg, (c) => c.json({}, 200));
    expect(() => secureRoute(app, registry, { pool, authenticate }, cfg, (c) => c.json({}, 200))).toThrow(/twice/);
  });
});
