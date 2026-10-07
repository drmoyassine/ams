import { OpenAPIHono, type Hook } from '@hono/zod-openapi';
import { getDatasetSpec, readVersionData, saveDatasetRows, saveDatasetSpec } from '@ams/core';
import { DatasetDataSchema, DatasetSpecSchema, EvidenceVersionSchema, SaveDatasetRowsSchema, SaveDatasetSpecSchema, toDto } from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

/** Data evidence (PRD 9.4): the definition, rows saved as versions, and the rows of a version. */
export function datasetRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['data'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/evidence/{id}/data-definition', access: requires('evidence:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'What the data means and its columns', ...json(DatasetSpecSchema) }, ...errors },
    }), async (c) => c.json(toDto(DatasetSpecSchema, await getDatasetSpec(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/evidence/{id}/data-definition', access: requires('evidence:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(SaveDatasetSpecSchema) } },
      responses: { 200: { description: 'Saved; data already saved keeps its own columns', ...json(DatasetSpecSchema) }, ...errors },
    }), async (c) => c.json(toDto(DatasetSpecSchema, await saveDatasetSpec(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence/{id}/data', access: requires('evidence:write'), tags: tag,
      description: 'Every cell is checked against the columns; any invalid cell refuses the save and is named in issues (rows.<n>.<key>).',
      request: { params: idParam, body: { required: true, ...json(SaveDatasetRowsSchema) } },
      responses: { 201: { description: 'Saved as the next version', ...json(EvidenceVersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(EvidenceVersionSchema, await saveDatasetRows(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/evidence-versions/{id}/data', access: requires('evidence:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The columns and rows of a data version', ...json(DatasetDataSchema) }, ...errors },
    }), async (c) => c.json(toDto(DatasetDataSchema, await readVersionData(c.get('ctx'), c.req.valid('param').id)), 200));
}
