import { OpenAPIHono, type Hook } from '@hono/zod-openapi';
import { createApiKey, listApiKeys, revokeApiKey } from '@ams/core';
import { ApiKeyListSchema, ApiKeySchema, CreateApiKeySchema, IssuedApiKeySchema, toDto } from '@ams/shared';
import { requires, scopeFrom, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

// API keys (DEC-040): an administrator issues, lists and revokes the keys other systems call the API with. A key acts as a service user
// with one role; the key itself is returned once, when issued. Mounted beside the main chain with its own typed client (ApiKeyRoutes).
export function apiKeyRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['api-keys'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/settings/api-keys', access: requires('institution:write', scopeFrom.institution), tags: tag,
      responses: { 200: { description: 'The keys (never their secrets)', ...json(ApiKeyListSchema) }, ...errors },
    }), async (c) => c.json(toDto(ApiKeyListSchema, await listApiKeys(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/settings/api-keys', access: requires('institution:write', scopeFrom.institution), tags: tag,
      description: 'Issues a key with a name, a role and an optional expiry. The key (`token`) is in this answer only: store it now.',
      request: { body: { required: true, ...json(CreateApiKeySchema) } },
      responses: { 200: { description: 'The key and its secret', ...json(IssuedApiKeySchema) }, ...errors },
    }), async (c) => c.json(toDto(IssuedApiKeySchema, await createApiKey(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/settings/api-keys/{id}/revoke', access: requires('institution:write', scopeFrom.institution), tags: tag,
      description: 'Revokes the key for good; calls with it are refused from now on.',
      request: { params: idParam },
      responses: { 200: { description: 'The key, revoked', ...json(ApiKeySchema) }, ...errors },
    }), async (c) => c.json(toDto(ApiKeySchema, await revokeApiKey(c.get('ctx'), c.req.valid('param').id)), 200));
}
