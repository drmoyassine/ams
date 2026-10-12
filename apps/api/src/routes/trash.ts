// Trash, bulk delete and the deletes of whole versions and standards (DEC-026). Every route passes the five-step chain;
// the services decide who may do what (library kinds need framework:write, evidence links evidence:write, milestones
// engagement:manage), so the routes only need a signed-in person with library access.
import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  countTrash, deleteAllRequirements, deleteForever, deleteFramework, deleteMany, deleteVersion, emptyTrash, getTrashGroup, listTrash, previewDelete, restoreTrash,
} from '@ams/core';
import {
  DeletePreviewSchema, DeleteResultSchema, RestoreOptionsSchema, RestoreResultSchema, TRASH_KINDS, TrashContentSchema, TrashGroupSchema, TrashListSchema,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

const Ids = z.object({ ids: z.array(z.uuid()).min(1).max(2000) });
const groupParam = z.object({ groupId: z.uuid() });
const Query = z.object({ kind: z.enum(TRASH_KINDS).optional(), q: z.string().optional() });

export function trashRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['trash'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/requirements/delete-preview', access: requires('framework:write'), tags: tag,
      description: 'What deleting these requirements would remove (their sub-items, notes and links), in the words the confirm dialog uses. Nothing is changed.',
      request: { body: { required: true, ...json(Ids) } },
      responses: { 200: { description: 'The question and the counts', ...json(DeletePreviewSchema) }, ...errors },
    }), async (c) => c.json(await previewDelete(c.get('ctx'), c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/requirements/delete', access: requires('framework:write'), tags: tag,
      description: 'Deletes requirements with everything under them in one action (draft or in-review versions). They go to the Trash for 30 days; the X-Undo header says how to put them back at once.',
      request: { body: { required: true, ...json(Ids) } },
      responses: { 200: { description: 'Deleted', ...json(DeleteResultSchema) }, ...errors },
    }), async (c) => c.json(await deleteMany(c.get('ctx'), c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/{id}/requirements/delete-all', access: requires('framework:write'), tags: tag,
      description: 'Deletes every requirement of a draft version as one Trash item.',
      request: { params: idParam },
      responses: { 200: { description: 'Deleted', ...json(DeleteResultSchema) }, ...errors },
    }), async (c) => c.json(await deleteAllRequirements(c.get('ctx'), c.req.valid('param').id), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/framework-versions/{id}', access: requires('framework:write'), tags: tag,
      description: 'Deletes a draft or in-review version with everything in it. A published or retired version can never be deleted.',
      request: { params: idParam },
      responses: { 200: { description: 'Deleted', ...json(DeleteResultSchema) }, ...errors },
    }), async (c) => c.json(await deleteVersion(c.get('ctx'), c.req.valid('param').id), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/frameworks/{id}', access: requires('framework:write'), tags: tag,
      description: 'Deletes an external standard whose versions are all drafts or in review (and not used by an engagement).',
      request: { params: idParam },
      responses: { 200: { description: 'Deleted', ...json(DeleteResultSchema) }, ...errors },
    }), async (c) => c.json(await deleteFramework(c.get('ctx'), c.req.valid('param').id), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/trash', access: requires('framework:read'), tags: tag,
      description: 'The Trash the caller may see, grouped by the action that put things there.',
      request: { query: Query },
      responses: { 200: { description: 'Groups, newest first', ...json(TrashListSchema) }, ...errors },
    }), async (c) => c.json(await listTrash(c.get('ctx'), c.req.valid('query')), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/trash/count', access: requires('framework:read'), tags: tag,
      request: {}, responses: { 200: { description: 'How many items are in the Trash for the caller', ...json(z.object({ count: z.number() })) }, ...errors },
    }), async (c) => c.json(await countTrash(c.get('ctx')), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/trash/groups/{groupId}', access: requires('framework:read'), tags: tag,
      request: { params: groupParam },
      responses: { 200: { description: 'One group with what it holds', ...json(z.object({ group: TrashGroupSchema, contents: z.array(TrashContentSchema) })) }, ...errors },
    }), async (c) => c.json(await getTrashGroup(c.get('ctx'), c.req.valid('param').groupId), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/trash/groups/{groupId}/restore', access: requires('framework:read'), tags: tag,
      description: 'Puts back everything one action deleted, all or nothing. A refusal says why; where there is a choice the 409 carries `details.code` and the options.',
      request: { params: groupParam, body: { required: false, ...json(RestoreOptionsSchema) } },
      responses: { 200: { description: 'Restored', ...json(RestoreResultSchema) }, ...errors },
    }), async (c) => c.json(await restoreTrash(c.get('ctx'), { groupId: c.req.valid('param').groupId }, c.req.valid('json') ?? {}), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/trash/items/{id}/restore', access: requires('framework:read'), tags: tag,
      request: { params: idParam, body: { required: false, ...json(RestoreOptionsSchema) } },
      responses: { 200: { description: 'Restored', ...json(RestoreResultSchema) }, ...errors },
    }), async (c) => c.json(await restoreTrash(c.get('ctx'), { itemId: c.req.valid('param').id }, c.req.valid('json') ?? {}), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/trash/groups/{groupId}', access: requires('framework:read'), tags: tag,
      description: 'Delete forever: removes a group from the Trash now, and its stored files with it.',
      request: { params: groupParam },
      responses: { 200: { description: 'Removed', ...json(z.object({ removed: z.number() })) }, ...errors },
    }), async (c) => c.json(await deleteForever(c.get('ctx'), { groupId: c.req.valid('param').groupId }), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/trash/items/{id}', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Removed', ...json(z.object({ removed: z.number() })) }, ...errors },
    }), async (c) => c.json(await deleteForever(c.get('ctx'), { itemId: c.req.valid('param').id }), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/trash', access: requires('framework:read'), tags: tag,
      description: 'Empties the Trash (everything the caller may remove).',
      request: {}, responses: { 200: { description: 'Removed', ...json(z.object({ removed: z.number() })) }, ...errors },
    }), async (c) => c.json(await emptyTrash(c.get('ctx')), 200));
}
