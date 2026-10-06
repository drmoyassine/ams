import { OpenAPIHono, type Hook } from '@hono/zod-openapi';
import { createMapping, deleteMapping, getMappings, reviewMapping, updateMapping } from '@ams/core';
import { CreateMappingSchema, MappingSchema, MappingsSchema, UpdateMappingSchema, toDto } from '@ams/shared';
import { z } from 'zod';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

export function mappingRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['mappings'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/framework-versions/{id}/mappings', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Mappings from this standard onto the quality framework, and the items to choose from', ...json(MappingsSchema) }, ...errors },
    }), async (c) => c.json(toDto(MappingsSchema, await getMappings(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/{id}/mappings', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(CreateMappingSchema) } },
      responses: { 201: { description: 'Proposed', ...json(MappingSchema) }, ...errors },
    }), async (c) => c.json(toDto(MappingSchema, await createMapping(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/mappings/{id}', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateMappingSchema) } },
      responses: { 200: { description: 'Updated and back in review', ...json(MappingSchema) }, ...errors },
    }), async (c) => c.json(toDto(MappingSchema, await updateMapping(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/mappings/{id}/review', access: requires('framework:review'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(z.object({ decision: z.enum(['approved', 'rejected']) })) } },
      responses: { 200: { description: 'Reviewed', ...json(MappingSchema) }, ...errors },
    }), async (c) => c.json(toDto(MappingSchema, await reviewMapping(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').decision)), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/mappings/{id}', access: requires('framework:write'), tags: tag,
      request: { params: idParam },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }), async (c) => { await deleteMapping(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); });
}
