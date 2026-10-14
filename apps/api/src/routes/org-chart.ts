// The org chart builder (TASK-072): the whole chart, moving units (drag and drop), deleting to the Trash, and the unit types.
// Creating and editing a unit are in settings.ts. The chain checks the caller holds the permission somewhere; the services check
// it at the unit in question. Every mutation answers with an X-Undo header.
import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  createOrgUnitType, deleteOrgUnits, getOrgChart, moveOrgUnits, previewDeleteOrgUnits, removeOrgUnitType, reorderOrgUnitTypes, updateOrgUnitType,
} from '@ams/core';
import {
  CreateOrgUnitTypeSchema, DeletePreviewSchema, DeleteResultSchema, MoveManyInputSchema, OrgChartSchema, OrgUnitTypeSchema, ReorderOrgUnitTypesSchema, UpdateOrgUnitTypeSchema, toDto,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

const Ids = z.object({ ids: z.array(z.uuid()).min(1).max(2000) });

export function orgChartRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['org-chart'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/org-chart', access: requires('org:read'), tags: tag,
      description: 'The org chart in tree order, each unit with its programs and counts, and the institution\'s unit types.',
      responses: { 200: { description: 'The chart', ...json(OrgChartSchema) }, ...errors },
    }), async (c) => c.json(toDto(OrgChartSchema, await getOrgChart(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/org-units/move-many', access: requires('org:write'), tags: tag,
      description: 'Moves several units in one action (drag and drop): [{ id, parentId, index }], positions counted with every moved unit taken out; or placements (what Undo sends). Atomic; never under itself.',
      request: { body: { required: true, ...json(MoveManyInputSchema) } },
      responses: { 200: { description: 'Moved; the X-Undo header says how to put them back', ...json(z.object({ moved: z.number(), changed: z.number(), unchanged: z.boolean() })) }, ...errors },
    }), async (c) => c.json(await moveOrgUnits(c.get('ctx'), c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/org-units/delete-preview', access: requires('org:write'), tags: tag,
      description: 'What deleting these units would remove, in the words the confirm dialog uses. Refused (409) while programs are attached. Nothing is changed.',
      request: { body: { required: true, ...json(Ids) } },
      responses: { 200: { description: 'The question and the counts', ...json(DeletePreviewSchema) }, ...errors },
    }), async (c) => c.json(await previewDeleteOrgUnits(c.get('ctx'), c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/org-units/delete', access: requires('org:write'), tags: tag,
      description: 'Deletes units with their sub-units to the Trash (30 days). Refused while programs are attached to them.',
      request: { body: { required: true, ...json(Ids) } },
      responses: { 200: { description: 'Deleted', ...json(DeleteResultSchema) }, ...errors },
    }), async (c) => c.json(await deleteOrgUnits(c.get('ctx'), c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/org-units/{id}', access: requires('org:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Deleted to the Trash', ...json(DeleteResultSchema) }, ...errors },
    }), async (c) => c.json(await deleteOrgUnits(c.get('ctx'), { ids: [c.req.valid('param').id] }), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/org-unit-types', access: requires('org:read'), tags: tag,
      responses: { 200: { description: 'The unit types in order', ...json(z.array(OrgUnitTypeSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(OrgUnitTypeSchema), (await getOrgChart(c.get('ctx'))).types), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/org-unit-types', access: requires('org:write'), tags: tag,
      request: { body: { required: true, ...json(CreateOrgUnitTypeSchema) } },
      responses: { 201: { description: 'Added', ...json(OrgUnitTypeSchema) }, ...errors },
    }), async (c) => c.json(toDto(OrgUnitTypeSchema, await createOrgUnitType(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/org-unit-types/reorder', access: requires('org:write'), tags: tag,
      description: 'The whole list of type ids in the new order.',
      request: { body: { required: true, ...json(ReorderOrgUnitTypesSchema) } },
      responses: { 200: { description: 'Reordered', ...json(z.array(OrgUnitTypeSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(OrgUnitTypeSchema), await reorderOrgUnitTypes(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/org-unit-types/{id}', access: requires('org:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateOrgUnitTypeSchema) } },
      responses: { 200: { description: 'Renamed', ...json(OrgUnitTypeSchema) }, ...errors },
    }), async (c) => c.json(toDto(OrgUnitTypeSchema, await updateOrgUnitType(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/org-unit-types/{id}', access: requires('org:write'), tags: tag,
      description: 'Removes a type that no unit uses.',
      request: { params: idParam }, responses: { 204: { description: 'Removed' }, ...errors },
    }), async (c) => { await removeOrgUnitType(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); });
}
