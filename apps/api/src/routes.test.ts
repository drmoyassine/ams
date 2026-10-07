import { z } from '@hono/zod-openapi';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { assertAllRoutesDeclared, publicRoute, RouteRegistry, secured } from './chain.js';

// No database is needed: nothing here opens a connection.
const pool = new pg.Pool({ connectionString: 'postgres://nobody@localhost:1/none' });
const authenticate = async () => null;

describe('route permission coverage', () => {
  it('every route of the real app declares access', () => {
    const { app, registry } = createApp({ pool, authenticate });
    expect(app.routes.length).toBeGreaterThan(0);
    expect(() => assertAllRoutesDeclared(app, registry)).not.toThrow();
    expect([...registry.declared.values()].every((a) => a.kind === 'public' || a.kind === 'permission' || a.kind === 'link')).toBe(true);
    // Only the one-time response links (DEC-018) and public form links (DEC-020) take a link instead of a signed-in user.
    const linkRoutes = [...registry.declared].filter(([, a]) => a.kind === 'link').map(([k]) => k);
    expect(linkRoutes.length).toBeGreaterThan(0);
    expect(linkRoutes.every((k) => /\/api\/(response-links|form-links)\/:token/.test(k))).toBe(true);
  });

  it('startup fails when a route is registered without requires(...)', () => {
    expect(() => createApp({
      pool, authenticate,
      extend: (_app, registry, deps) => {
        secured(registry, deps, { method: 'get', path: '/api/rogue', responses: { 200: { description: 'x' } } } as never);
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
    const registry = new RouteRegistry();
    const cfg = {
      method: 'get' as const, path: '/x', access: publicRoute(),
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({}) } } } },
    };
    secured(registry, { pool, authenticate, queue: { send: async () => undefined } }, cfg);
    expect(() => secured(registry, { pool, authenticate, queue: { send: async () => undefined } }, cfg)).toThrow(/twice/);
  });
});
