import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import { getPublicBranding, getPublicI18n, readPublicLogo } from '@ams/core';
import { PublicBrandingSchema, PublicI18nSchema } from '@ams/shared';
import { publicRoute, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { json } from './common.js';

/**
 * The only data routes served without signing in: what the sign-in page shows (the institution's display name, accent
 * colour and logo). They are outside the permission chain on purpose, read nothing but those three things through one
 * database function, and take no input. Everything else about the institution stays behind sign-in.
 */
export function publicRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['public'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/public/branding', access: publicRoute(), tags: tag,
      description: 'Public. The institution\'s display name, accent colour and logo address, for the sign-in page. Nothing else.',
      responses: { 200: { description: 'Branding (all null when the deployment has no single institution)', ...json(PublicBrandingSchema) } },
    }), async (c) => c.json(await getPublicBranding(deps.pool), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/public/i18n', access: publicRoute(), tags: tag,
      description: 'Public. The institution\'s default and secondary language codes and the text of the sign-in page\'s own keys in the secondary language. Nothing else.',
      responses: { 200: { description: 'Sign-in page language data', ...json(PublicI18nSchema) } },
    }), async (c) => c.json(await getPublicI18n(deps.pool), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/public/branding/logo', access: publicRoute(), tags: tag,
      description: 'Public. The institution\'s logo image, if it has one.',
      responses: { 200: { description: 'The logo image', content: { 'application/octet-stream': { schema: z.string() } } }, 404: { description: 'No logo' } },
    }), async (c) => {
      const f = await readPublicLogo(deps.pool, deps.store);
      if (!f) return c.json({ error: 'not_found' }, 404) as never;
      return c.body(f.bytes as unknown as ArrayBuffer, 200, { 'content-type': f.mime, 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=3600' }) as never;
    });
}
