import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  AddNoteSchema, CreateRequirementSchema, addNote, createRequirement, deleteNote, deleteRequirement, getRequirementWithNotes, listRequirements,
  MergeRequirementSchema, SplitRequirementSchema, listReviewItems, mergeRequirement, splitRequirement,
  indentRequirement, moveRequirement, outdentRequirement, reviewNote, reviewRequirement, setNoteAuthority, updateNote, updateRequirement, UpdateRequirementSchema, unsplitRequirement, UnsplitSchema,
} from '@ams/core';
import { MergeResultSchema, NoteSchema, RequirementDetailSchema, RequirementSchema, ReviewItemsSchema, SplitResultSchema, toDto } from '@ams/shared';
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
      request: { params: idParam, body: { required: true, ...json(UpdateRequirementSchema) } },
      responses: { 200: { description: 'Updated; returned to review', ...json(RequirementSchema) }, ...errors },
    }), async (c) => c.json(toDto(RequirementSchema, await updateRequirement(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/requirements/{id}/indent', access: requires('framework:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Indented under the item above it (internal quality framework); its level follows its depth', ...json(RequirementSchema) }, ...errors },
    }), async (c) => c.json(toDto(RequirementSchema, await indentRequirement(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/requirements/{id}/outdent', access: requires('framework:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Outdented to follow its parent (internal quality framework); its level follows its depth', ...json(RequirementSchema) }, ...errors },
    }), async (c) => c.json(toDto(RequirementSchema, await outdentRequirement(c.get('ctx'), c.req.valid('param').id)), 200))

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
      method: 'get', path: '/api/framework-versions/{id}/review-items', access: requires('framework:read'), tags: tag,
      description: 'The requirements and notes of a version that deserve a look first: quote not found, low confidence, placed at the top level for want of a parent, suggested by the analysis.',
      request: { params: idParam },
      responses: { 200: { description: 'Only items with at least one reason', ...json(ReviewItemsSchema) }, ...errors },
    }), async (c) => c.json(toDto(ReviewItemsSchema, await listReviewItems(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/requirements/{id}/merge', access: requires('framework:write'), tags: tag,
      description: 'Merges this requirement into another of the same draft: its notes and children move to the target, which keeps its own wording unless asked. Refused on a published version.',
      request: { params: idParam, body: { required: true, ...json(MergeRequirementSchema) } },
      responses: { 200: { description: 'Merged; the target as it is now', ...json(MergeResultSchema) }, ...errors },
    }), async (c) => c.json(toDto(MergeResultSchema, await mergeRequirement(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/requirements/{id}/split', access: requires('framework:write'), tags: tag,
      description: 'Moves a chosen part of the requirement\'s text out into a new sibling requirement with its own code. Both keep the source; the new one\'s quote is verified against the stored page. Refused on a published version.',
      request: { params: idParam, body: { required: true, ...json(SplitRequirementSchema) } },
      responses: { 201: { description: 'Split', ...json(SplitResultSchema) }, ...errors },
    }), async (c) => c.json(toDto(SplitResultSchema, await splitRequirement(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/requirements/{id}/unsplit', access: requires('framework:write'), tags: tag,
      description: 'Takes a split back (the Undo of a split): the split-out requirement goes to the Trash and the original gets its earlier text.',
      request: { params: idParam, body: { required: true, ...json(UnsplitSchema) } },
      responses: { 200: { description: 'The original as it is now', ...json(RequirementSchema) }, ...errors },
    }), async (c) => c.json(toDto(RequirementSchema, await unsplitRequirement(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

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
