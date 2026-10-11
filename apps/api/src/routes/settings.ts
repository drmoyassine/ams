import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import { createAiAccount, createOrgUnit, deleteAiAccount, getAiSettings, getInstitution, listAccountModels, listAiAccounts, listOrgUnits, testAiAccount, testAiConnection, updateAiAccount, updateAiSettings, updateInstitution, updateOrgUnit, updateProgram } from '@ams/core';
import {
  AiAccountSchema, AiAccountTestSchema, AiModelListSchema, AiSettingSchema, AiTestRequestSchema, AiTestResultSchema, CreateAiAccountSchema, CreateOrgUnitSchema, UpdateAiAccountSchema, UpdateAiSettingSchema, InstitutionSchema, OrgUnitSchema, ProgramSchema, UpdateInstitutionSchema, UpdateOrgUnitSchema, UpdateProgramSchema, toDto,
} from '@ams/shared';
import { requires, scopeFrom, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

// The chain checks that the caller holds the permission somewhere; the services check it at the unit or program in question.
export function settingsRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['settings'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/institution', access: requires('org:read'), tags: tag,
      responses: { 200: { description: 'The institution: names and branding', ...json(InstitutionSchema) }, ...errors },
    }), async (c) => c.json(toDto(InstitutionSchema, await getInstitution(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/institution', access: requires('institution:write'), tags: tag,
      request: { body: { required: true, ...json(UpdateInstitutionSchema) } },
      responses: { 200: { description: 'Updated', ...json(InstitutionSchema) }, ...errors },
    }), async (c) => c.json(toDto(InstitutionSchema, await updateInstitution(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/settings/ai', access: requires('ai:manage', scopeFrom.institution), tags: tag,
      responses: { 200: { description: 'The AI connection: never the key, only whether one is set and its last 4 characters', ...json(AiSettingSchema) }, ...errors },
    }), async (c) => c.json(toDto(AiSettingSchema, await getAiSettings(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/settings/ai', access: requires('ai:manage', scopeFrom.institution), tags: tag,
      request: { body: { required: true, ...json(UpdateAiSettingSchema) } },
      responses: { 200: { description: 'Saved', ...json(AiSettingSchema) }, ...errors },
    }), async (c) => c.json(toDto(AiSettingSchema, await updateAiSettings(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/settings/ai/test', access: requires('ai:manage', scopeFrom.institution), tags: tag,
      request: { body: { required: false, ...json(AiTestRequestSchema) } },
      responses: { 200: { description: 'Result of one tiny call for one role (analysis, reading or embeddings) through the saved settings; embeddings also stores the detected vector size', ...json(AiTestResultSchema) }, ...errors },
    }), async (c) => c.json(toDto(AiTestResultSchema, await testAiConnection(c.get('ctx'), (c.req.valid('json') ?? { role: 'analysis' as const }).role)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/settings/ai/accounts', access: requires('ai:manage', scopeFrom.institution), tags: tag,
      responses: { 200: { description: 'The saved AI accounts: never a key, only whether one is set and its last 4 characters', ...json(z.array(AiAccountSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(AiAccountSchema), await listAiAccounts(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/settings/ai/accounts', access: requires('ai:manage', scopeFrom.institution), tags: tag,
      request: { body: { required: true, ...json(CreateAiAccountSchema) } },
      responses: { 201: { description: 'Created; the key is encrypted before it is stored', ...json(AiAccountSchema) }, ...errors },
    }), async (c) => c.json(toDto(AiAccountSchema, await createAiAccount(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/settings/ai/accounts/{id}', access: requires('ai:manage', scopeFrom.institution), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateAiAccountSchema) } },
      responses: { 200: { description: 'Updated. Changing the provider removes the saved key unless a new one comes with it', ...json(AiAccountSchema) }, ...errors },
    }), async (c) => c.json(toDto(AiAccountSchema, await updateAiAccount(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/settings/ai/accounts/{id}', access: requires('ai:manage', scopeFrom.institution), tags: tag,
      request: { params: idParam },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }), async (c) => { await deleteAiAccount(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/settings/ai/accounts/{id}/test', access: requires('ai:manage', scopeFrom.institution), tags: tag,
      request: { params: idParam, body: { required: false, ...json(AiAccountTestSchema) } },
      responses: { 200: { description: 'One tiny call with a fixed prompt, or (with no model to try) a check of the key by fetching the model list', ...json(AiTestResultSchema) }, ...errors },
    }), async (c) => c.json(toDto(AiTestResultSchema, await testAiAccount(c.get('ctx'), c.req.valid('param').id, c.req.valid('json') ?? {})), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/settings/ai/accounts/{id}/models', access: requires('ai:manage', scopeFrom.institution), tags: tag,
      description: 'The models the account\'s provider offers, fetched on the server (a metadata call, no inference). Cached for 10 minutes; refresh=true skips the cache. A failure comes back as `error` with an empty list.',
      request: { params: idParam, query: z.object({ kind: z.enum(['chat', 'embedding']).optional(), refresh: z.enum(['true', 'false']).optional() }) },
      responses: { 200: { description: 'The model list', ...json(AiModelListSchema) }, ...errors },
    }), async (c) => {
      const q = c.req.valid('query');
      return c.json(toDto(AiModelListSchema, await listAccountModels(c.get('ctx'), c.req.valid('param').id, { ...(q.kind ? { kind: q.kind } : {}), refresh: q.refresh === 'true' })), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/org-units', access: requires('org:read'), tags: tag,
      responses: { 200: { description: 'The org chart as a flat list', ...json(z.array(OrgUnitSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(OrgUnitSchema), await listOrgUnits(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/org-units', access: requires('org:write'), tags: tag,
      request: { body: { required: true, ...json(CreateOrgUnitSchema) } },
      responses: { 201: { description: 'Created', ...json(OrgUnitSchema) }, ...errors },
    }), async (c) => c.json(toDto(OrgUnitSchema, await createOrgUnit(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/org-units/{id}', access: requires('org:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateOrgUnitSchema) } },
      responses: { 200: { description: 'Renamed, moved or (de)activated', ...json(OrgUnitSchema) }, ...errors },
    }), async (c) => c.json(toDto(OrgUnitSchema, await updateOrgUnit(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/programs/{id}', access: requires('program:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateProgramSchema) } },
      responses: { 200: { description: 'Updated', ...json(ProgramSchema) }, ...errors },
    }), async (c) => c.json(toDto(ProgramSchema, await updateProgram(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200));
}
