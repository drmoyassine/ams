// Scope and champion of a standard (TASK-086): the scope levels (Settings -> Organization -> Institution), what a person sets on a
// requirement (by standard and code, so it survives new versions) and the units and programs a scope can list. What each
// requirement of a version ends up with (inherited, with its source) is part of GET /api/framework-versions/{id}/requirement-context.
// Reading needs org:read or framework:read; assigning needs framework:write; the levels need org:write. Every change answers with an
// X-Undo header where it can be taken back.
import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  clearRequirementChampion, clearRequirementScope, createScopeLevel, getOwnAssignment, listScopeItems, listScopeLevels, reorderScopeLevels, setRequirementChampion, setRequirementScope, updateScopeLevel,
} from '@ams/core';
import {
  ClearRequirementChampionSchema, CreateScopeLevelSchema, OwnAssignmentSchema, ReorderScopeLevelsSchema, RequirementTargetSchema, ScopeItemsSchema, ScopeLevelSchema, SetRequirementChampionSchema,
  SetRequirementScopeSchema, UpdateScopeLevelSchema, toDto,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

export function scopeRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['scope'];
  const own = { 200: { description: 'What is set on the requirement itself', ...json(OwnAssignmentSchema) }, ...errors };
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/scope-levels', access: requires('org:read'), tags: tag,
      description: 'The scope levels in order (active or not), each with how many units or programs a scope at it can list.',
      responses: { 200: { description: 'The levels', ...json(z.array(ScopeLevelSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(ScopeLevelSchema), await listScopeLevels(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/scope-levels', access: requires('org:write'), tags: tag,
      description: 'Adds a custom level at the end of the list.',
      request: { body: { required: true, ...json(CreateScopeLevelSchema) } },
      responses: { 201: { description: 'Added', ...json(ScopeLevelSchema) }, ...errors },
    }), async (c) => c.json(toDto(ScopeLevelSchema, await createScopeLevel(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/scope-levels/reorder', access: requires('org:write'), tags: tag,
      description: 'The whole list of level ids in the new order.',
      request: { body: { required: true, ...json(ReorderScopeLevelsSchema) } },
      responses: { 200: { description: 'Reordered', ...json(z.array(ScopeLevelSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(ScopeLevelSchema), await reorderScopeLevels(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/scope-levels/{id}', access: requires('org:write'), tags: tag,
      description: 'Renames a level (English and Arabic) or deactivates or reactivates it. Levels are never deleted.',
      request: { params: idParam, body: { required: true, ...json(UpdateScopeLevelSchema) } },
      responses: { 200: { description: 'Updated', ...json(ScopeLevelSchema) }, ...errors },
    }), async (c) => c.json(toDto(ScopeLevelSchema, await updateScopeLevel(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/scope-items', access: requires('org:read'), tags: tag,
      description: 'The active units and programs a scope can list.',
      responses: { 200: { description: 'Units and programs', ...json(ScopeItemsSchema) }, ...errors },
    }), async (c) => c.json(toDto(ScopeItemsSchema, await listScopeItems(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/requirement-assignment', access: requires('framework:read'), tags: tag,
      description: 'What is set on one requirement itself (its own scope and champions), named by standard and code. The inherited values are in the version\'s requirement-context.',
      request: { query: RequirementTargetSchema },
      responses: own,
    }), async (c) => c.json(toDto(OwnAssignmentSchema, await getOwnAssignment(c.get('ctx'), c.req.valid('query'))), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/requirement-scope', access: requires('framework:write'), tags: tag,
      description: 'Sets the requirement\'s own scope: a level and, optionally, a list of its units or programs (empty = all). It overrides what it inherits, and works on a published version too.',
      request: { body: { required: true, ...json(SetRequirementScopeSchema) } },
      responses: own,
    }), async (c) => c.json(toDto(OwnAssignmentSchema, await setRequirementScope(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/requirement-scope', access: requires('framework:write'), tags: tag,
      description: 'Back to inherited: removes the requirement\'s own scope.',
      request: { query: RequirementTargetSchema },
      responses: own,
    }), async (c) => c.json(toDto(OwnAssignmentSchema, await clearRequirementScope(c.get('ctx'), c.req.valid('query'))), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/requirement-champion', access: requires('framework:write'), tags: tag,
      description: 'Sets the overall champion (no item) or the champion of one unit or program of the scope.',
      request: { body: { required: true, ...json(SetRequirementChampionSchema) } },
      responses: own,
    }), async (c) => c.json(toDto(OwnAssignmentSchema, await setRequirementChampion(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/requirement-champion', access: requires('framework:write'), tags: tag,
      description: 'Removes one own champion (the overall one when no item is named), or every own champion with all=true (back to inherited).',
      request: { query: ClearRequirementChampionSchema },
      responses: own,
    }), async (c) => c.json(toDto(OwnAssignmentSchema, await clearRequirementChampion(c.get('ctx'), c.req.valid('query'))), 200));
}
