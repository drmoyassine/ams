import { OpenAPIHono, type Hook } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  decideSubmission, getQualityOffice, getRequirementQuality, getSubmission, getSubmissionById, openSubmission, qualityTab, qualityTabs, saveSubmissionEvidence,
  setQualityOffice, setRequirementApproval, setRequirementFrequency, submitSubmission,
} from '@ams/core';
import {
  DecideSubmissionSchema, OpenSubmissionSchema, QualityTabDetailSchema, QualityTabsSchema, RequirementQualitySchema, SaveSubmissionEvidenceSchema,
  SetRequirementApprovalSchema, SetRequirementFrequencySchema, SubmissionDetailSchema, toDto,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

// Quality Management as the IQF in operation (DEC-048): a standard's frequency and approval steps, the QA office, the tabs a person
// sees, and the submissions of their courses, programs and units with their approval. Who may submit or decide is the service's
// question (the submitter of the item, the person of the current step); the routes ask only that the caller may read.
// Mounted beside the main chain with its own typed client (QualityRoutes).
export function qualityRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['quality'];
  const ok = z.object({ ok: z.boolean() });
  const subjectQuery = z.object({ frameworkId: z.uuid(), code: z.string().min(1), subjectKind: z.enum(['course', 'program', 'org_unit', 'institution']), subjectId: z.uuid().optional(), periodKey: z.string().min(1) });
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/quality/requirements', access: requires('framework:read'), tags: tag,
      description: 'Every standard of a version with its frequency and approval steps: its own, what applies, and where that comes from.',
      request: { query: z.object({ versionId: z.uuid(), frameworkId: z.uuid() }) },
      responses: { 200: { description: 'By code', ...json(z.array(RequirementQualitySchema)) }, ...errors },
    }), async (c) => { const q = c.req.valid('query'); return c.json(toDto(z.array(RequirementQualitySchema), await getRequirementQuality(c.get('ctx'), q.versionId, q.frameworkId)), 200); })

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/quality/frequency', access: requires('framework:write'), tags: tag,
      description: 'Sets a standard\'s own frequency, an opt-out of the inherited one, or neither (back to inherited).',
      request: { body: { required: true, ...json(SetRequirementFrequencySchema) } },
      responses: { 200: { description: 'Set', ...json(ok) }, ...errors },
    }), async (c) => { await setRequirementFrequency(c.get('ctx'), c.req.valid('json')); return c.json({ ok: true }, 200); })

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/quality/approval', access: requires('framework:write'), tags: tag,
      description: 'Sets a standard\'s own approval steps (the QA office and the champion always follow them); null: back to inherited.',
      request: { body: { required: true, ...json(SetRequirementApprovalSchema) } },
      responses: { 200: { description: 'Set', ...json(ok) }, ...errors },
    }), async (c) => { await setRequirementApproval(c.get('ctx'), c.req.valid('json')); return c.json({ ok: true }, 200); })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/quality/office', access: requires('org:read'), tags: tag,
      responses: { 200: { description: 'The unit that is the QA office', ...json(z.object({ unitId: z.string().nullable() })) }, ...errors },
    }), async (c) => c.json(await getQualityOffice(c.get('ctx')), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/quality/office', access: requires('org:write'), tags: tag,
      description: 'Names the unit whose head and members are the QA office step of every approval chain.',
      request: { body: { required: true, ...json(z.object({ unitId: z.uuid().nullable() })) } },
      responses: { 200: { description: 'Set', ...json(z.object({ unitId: z.string().nullable() })) }, ...errors },
    }), async (c) => c.json(await setQualityOffice(c.get('ctx'), c.req.valid('json').unitId), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/quality/tabs', access: requires('org:read'), tags: tag,
      description: 'The tabs of Quality Management for the caller: the top-level standards they submit or approve for (administrators and the QA office: every one, read-only).',
      responses: { 200: { description: 'The tabs', ...json(QualityTabsSchema) }, ...errors },
    }), async (c) => c.json(toDto(QualityTabsSchema, await qualityTabs(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/quality/tabs/{code}', access: requires('org:read'), tags: tag,
      description: 'One tab: the standard read-only and the caller\'s submissions for a period (`current`: the open ones and the next to come).',
      request: { params: z.object({ code: z.string().min(1) }), query: z.object({ period: z.string().optional() }) },
      responses: { 200: { description: 'The standard and the submissions', ...json(QualityTabDetailSchema) }, ...errors },
    }), async (c) => c.json(toDto(QualityTabDetailSchema, await qualityTab(c.get('ctx'), c.req.valid('param').code, c.req.valid('query').period ?? 'current')), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/quality/submission', access: requires('org:read'), tags: tag,
      description: 'The submission of a standard for an item and a period, as it is (not started when nobody has opened it).',
      request: { query: subjectQuery },
      responses: { 200: { description: 'The submission', ...json(SubmissionDetailSchema) }, ...errors },
    }), async (c) => { const q = c.req.valid('query'); return c.json(toDto(SubmissionDetailSchema, await getSubmission(c.get('ctx'), { ...q, subjectId: q.subjectId ?? null })), 200); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/quality/submissions', access: requires('org:read'), tags: tag,
      description: 'Starts the submission (the person who submits for the item only).',
      request: { body: { required: true, ...json(OpenSubmissionSchema) } },
      responses: { 200: { description: 'The submission', ...json(SubmissionDetailSchema) }, ...errors },
    }), async (c) => c.json(toDto(SubmissionDetailSchema, await openSubmission(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/quality/submissions/{id}', access: requires('org:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The submission', ...json(SubmissionDetailSchema) }, ...errors },
    }), async (c) => c.json(toDto(SubmissionDetailSchema, await getSubmissionById(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/quality/submissions/{id}/evidence', access: requires('org:read'), tags: tag,
      description: 'Answers one evidence item with a version of it (uploaded for this submission, or one to reuse); null clears it.',
      request: { params: idParam, body: { required: true, ...json(SaveSubmissionEvidenceSchema) } },
      responses: { 200: { description: 'The submission', ...json(SubmissionDetailSchema) }, ...errors },
    }), async (c) => c.json(toDto(SubmissionDetailSchema, await saveSubmissionEvidence(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/quality/submissions/{id}/submit', access: requires('org:read'), tags: tag,
      description: 'Submits it for approval (every evidence item answered).',
      request: { params: idParam },
      responses: { 200: { description: 'The submission', ...json(SubmissionDetailSchema) }, ...errors },
    }), async (c) => c.json(toDto(SubmissionDetailSchema, await submitSubmission(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/quality/submissions/{id}/decision', access: requires('org:read'), tags: tag,
      description: 'The current step approves ("Internally approved" after the last) or returns it to the submitter with a note.',
      request: { params: idParam, body: { required: true, ...json(DecideSubmissionSchema) } },
      responses: { 200: { description: 'The submission', ...json(SubmissionDetailSchema) }, ...errors },
    }), async (c) => c.json(toDto(SubmissionDetailSchema, await decideSubmission(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200));
}
