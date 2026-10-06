import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import { autoMapStandards, createTerm, getGlossary, listExternalTerms, seedDefaultGlossary, setAlias, updateTerm } from '@ams/core';
import { CreateTermSchema, ExternalStandardSchema, GlossarySchema, GlossaryTermSchema, SetAliasSchema, UpdateTermSchema, toDto } from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

export function glossaryRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['glossary'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/glossary', access: requires('org:read'), tags: tag,
      responses: { 200: { description: 'The institution\'s terms and the mappings from each standard\'s words', ...json(GlossarySchema) }, ...errors },
    }), async (c) => c.json(toDto(GlossarySchema, await getGlossary(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/glossary/external-terms', access: requires('org:read'), tags: tag,
      responses: { 200: { description: 'Each standard\'s level names, finding names and report types, with their mapping', ...json(z.array(ExternalStandardSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(ExternalStandardSchema), await listExternalTerms(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/glossary/seed-defaults', access: requires('framework:write'), tags: tag,
      responses: { 200: { description: 'Starter terms added', ...json(z.object({ added: z.number() })) }, ...errors },
    }), async (c) => c.json(await seedDefaultGlossary(c.get('ctx')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/glossary/terms', access: requires('framework:write'), tags: tag,
      request: { body: { required: true, ...json(CreateTermSchema) } },
      responses: { 201: { description: 'Created', ...json(GlossaryTermSchema) }, ...errors },
    }), async (c) => c.json(toDto(GlossaryTermSchema, await createTerm(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/glossary/terms/{id}', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateTermSchema) } },
      responses: { 200: { description: 'Updated', ...json(GlossaryTermSchema) }, ...errors },
    }), async (c) => c.json(toDto(GlossaryTermSchema, await updateTerm(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/glossary/aliases', access: requires('framework:write'), tags: tag,
      request: { body: { required: true, ...json(SetAliasSchema) } },
      responses: { 204: { description: 'Mapped, or cleared when the term is null' }, ...errors },
    }), async (c) => { await setAlias(c.get('ctx'), c.req.valid('json')); return c.body(null, 204); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/glossary/auto-map', access: requires('framework:write'), tags: tag,
      request: { body: { required: true, ...json(z.object({ frameworkId: z.uuid().optional() })) } },
      responses: { 200: { description: 'Unmapped terms mapped by their structural suggestion', ...json(z.object({ mapped: z.number() })) }, ...errors },
    }), async (c) => c.json(await autoMapStandards(c.get('ctx'), c.req.valid('json').frameworkId), 200));
}
