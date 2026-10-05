import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  AddNoteSchema, CreateRequirementSchema, addNote, createRequirement, deleteNote, deleteRequirement, getRequirementWithNotes, listRequirements,
  moveRequirement, reviewNote, reviewRequirement, setNoteAuthority, updateNote, updateRequirement,
} from '@ams/core';
import { NoteSchema, RequirementDetailSchema, RequirementSchema, toDto } from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

const Decision = z.object({ decision: z.enum(['approved', 'rejected']) });
const NoteUpdate = z.object({
  text: z.string().optional(), type: z.enum(['guidance', 'evidence_expectation', 'data_request', 'quantitative_norm']).optional(),
  norm: z.record(z.string(), z.unknown()).nullable().optional(),
  source: z.object({ documentId: z.uuid(), page: z.number().int().min(1), quote: z.string() }).nullable().optional(),
});

export function requirementRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['requirements'];
  const noContent = { 204: { description: 'Deleted' }, ...errors };
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/framework-versions/{id}/requirements', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The requirement tree, flat, parents before children', ...json(z.array(RequirementSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(RequirementSchema), await listRequirements(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/{id}/requirements', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(CreateRequirementSchema.omit({ versionId: true })) } },
      responses: { 201: { description: 'Created', ...json(RequirementSchema) }, ...errors },
    }), async (c) => c.json(toDto(RequirementSchema, await createRequirement(c.get('ctx'), { ...c.req.valid('json'), versionId: c.req.valid('param').id })), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/requirements/{id}', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'A requirement with its notes', ...json(RequirementDetailSchema) }, ...errors },
    }), async (c) => c.json(toDto(RequirementDetailSchema, await getRequirementWithNotes(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/requirements/{id}', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(CreateRequirementSchema.omit({ versionId: true, parentId: true }).partial()) } },
      responses: { 200: { description: 'Updated; returned to review', ...json(RequirementSchema) }, ...errors },
    }), async (c) => c.json(toDto(RequirementSchema, await updateRequirement(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/requirements/{id}/move', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(z.object({ parentId: z.uuid().nullable(), displayOrder: z.number().int().optional() })) } },
      responses: { 200: { description: 'Moved', ...json(RequirementSchema) }, ...errors },
    }), async (c) => {
      const { parentId, displayOrder } = c.req.valid('json');
      return c.json(toDto(RequirementSchema, await moveRequirement(c.get('ctx'), c.req.valid('param').id, parentId, displayOrder)), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/requirements/{id}', access: requires('framework:write'), tags: tag,
      request: { params: idParam }, responses: noContent,
    }), async (c) => { await deleteRequirement(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/requirements/{id}/review', access: requires('framework:review'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(Decision) } },
      responses: { 200: { description: 'Reviewed', ...json(RequirementSchema) }, ...errors },
    }), async (c) => c.json(toDto(RequirementSchema, await reviewRequirement(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').decision)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/requirements/{id}/notes', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(AddNoteSchema.omit({ requirementId: true })) } },
      responses: { 201: { description: 'Created', ...json(NoteSchema) }, ...errors },
    }), async (c) => c.json(toDto(NoteSchema, await addNote(c.get('ctx'), { ...c.req.valid('json'), requirementId: c.req.valid('param').id })), 201))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/notes/{id}', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(NoteUpdate) } },
      responses: { 200: { description: 'Updated; quote re-verified; returned to review', ...json(NoteSchema) }, ...errors },
    }), async (c) => c.json(toDto(NoteSchema, await updateNote(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/notes/{id}/authority', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(z.object({ authority: z.enum(['required', 'example', 'suggested', 'institution_defined']) })) } },
      responses: { 200: { description: 'Reclassified by a person', ...json(NoteSchema) }, ...errors },
    }), async (c) => c.json(toDto(NoteSchema, await setNoteAuthority(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').authority)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/notes/{id}/review', access: requires('framework:review'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(Decision) } },
      responses: { 200: { description: 'Reviewed', ...json(NoteSchema) }, ...errors },
    }), async (c) => c.json(toDto(NoteSchema, await reviewNote(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').decision)), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/notes/{id}', access: requires('framework:write'), tags: tag,
      request: { params: idParam }, responses: noContent,
    }), async (c) => { await deleteNote(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); });
}
