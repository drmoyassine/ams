import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import { bulkUpdateEvidence, createEvidence, deleteEvidence, updateEvidence } from '@ams/core';
import { BulkEvidenceSchema, CreateEvidenceSchema, DeleteResultSchema, EvidenceItemSchema, UpdateEvidenceSchema, toDto } from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

// Creating, changing and deleting evidence, and changing several items at once (TASK-119, TASK-120). Mounted beside the main chain (its type is at the compiler's
// limit); the services check evidence:write. A delete goes to the Trash with an Undo; evidence versions are immutable and stay.
export function evidenceOpsRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['evidence'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence', access: requires('evidence:write'), tags: tag,
      request: { body: { required: true, ...json(CreateEvidenceSchema) } },
      responses: { 201: { description: 'Created', ...json(EvidenceItemSchema) }, ...errors },
    }), async (c) => c.json(toDto(EvidenceItemSchema, await createEvidence(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/evidence/{id}', access: requires('evidence:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateEvidenceSchema) } },
      responses: { 200: { description: 'Updated', ...json(EvidenceItemSchema) }, ...errors },
    }), async (c) => c.json(toDto(EvidenceItemSchema, await updateEvidence(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/evidence/{id}', access: requires('evidence:write'), tags: tag,
      description: 'Moves the evidence to the Trash with its links; a restore brings both back. Refused while it has an open request or collection run.',
      request: { params: idParam },
      responses: { 200: { description: 'Deleted', ...json(DeleteResultSchema) }, ...errors },
    }), async (c) => c.json(toDto(DeleteResultSchema, await deleteEvidence(c.get('ctx'), [c.req.valid('param').id])), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence/delete', access: requires('evidence:write'), tags: tag,
      description: 'Moves several pieces of evidence to the Trash as one group (all or none).',
      request: { body: { required: true, ...json(z.object({ ids: z.array(z.uuid()).min(1).max(500) })) } },
      responses: { 200: { description: 'Deleted', ...json(DeleteResultSchema) }, ...errors },
    }), async (c) => c.json(toDto(DeleteResultSchema, await deleteEvidence(c.get('ctx'), c.req.valid('json').ids)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence/bulk', access: requires('evidence:write'), tags: tag,
      description: 'Changes several items at once, all or none: owner unit and person, confidentiality, student-data flag, period, archive or restore, and tags added or removed.',
      request: { body: { required: true, ...json(BulkEvidenceSchema) } },
      responses: { 200: { description: 'How many changed', ...json(z.object({ updated: z.number(), unchanged: z.number() })) }, ...errors },
    }), async (c) => c.json(await bulkUpdateEvidence(c.get('ctx'), c.req.valid('json')), 200));
}
