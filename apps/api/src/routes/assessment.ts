import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  addAction, addResult, createPlan, deleteCourseAssessment, deleteIloSchedule, deleteResult, getBenchmarks, getCourseAttainment, getIloReport, getPlan,
  getProgramAssessment, importResults, listCourseAssessments, recordCourseAttainment, saveCourseAssessment, saveIloSchedule, savePlanItem, setBenchmarks,
  updateAction, updatePlan,
} from '@ams/core';
import {
  AssessmentBenchmarksSchema, AssessmentPlanSchema, CorrectiveActionSchema, CourseAssessmentSchema, CreatePlanSchema, IloReportSchema, IloScheduleRowSchema,
  ImportResultRowSchema, ProgramAssessmentSchema, SaveActionSchema, SaveCourseAssessmentSchema, SaveIloScheduleSchema, SavePlanItemSchema, SaveResultSchema,
  UpdatePlanSchema, toDto,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

const AttainmentSchema = z.object({
  courseId: z.uuid(), term: z.string(), overall: z.number().nullable(), unmapped: z.number(), total: z.number(),
  clos: z.array(z.object({ cloId: z.uuid(), possible: z.number(), achieved: z.number(), attainment: z.number().nullable(), weight: z.number() })),
  plos: z.array(z.object({ ploId: z.uuid(), code: z.string(), programId: z.uuid(), possible: z.number(), achieved: z.number(), attainment: z.number().nullable() })),
});

// Assessment of learning (TASK-114..117): plans, course attainment, results, corrective actions, the ILO rotation. Mounted beside the
// main chain with its own typed client (AssessmentRoutes); the services check permissions at the program, course or institution.
export function assessmentRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['assessment'];
  const pair = z.object({ id: z.uuid(), aid: z.uuid() });
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/settings/assessment-benchmarks', access: requires('org:read'), tags: tag,
      responses: { 200: { description: 'The institution\'s assessment targets', ...json(AssessmentBenchmarksSchema) }, ...errors },
    }), async (c) => c.json(await getBenchmarks(c.get('ctx')), 200))
    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/settings/assessment-benchmarks', access: requires('org:write'), tags: tag,
      request: { body: { required: true, ...json(AssessmentBenchmarksSchema) } },
      responses: { 200: { description: 'Saved', ...json(AssessmentBenchmarksSchema) }, ...errors },
    }), async (c) => c.json(await setBenchmarks(c.get('ctx'), c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/programs/{id}/assessment', access: requires('program:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Plans, results with their standing, corrective actions and gaps without one', ...json(ProgramAssessmentSchema) }, ...errors },
    }), async (c) => c.json(toDto(ProgramAssessmentSchema, await getProgramAssessment(c.get('ctx'), c.req.valid('param').id)), 200))
    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/programs/{id}/plans', access: requires('program:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(CreatePlanSchema) } },
      responses: { 201: { description: 'The plan, with a row per PLO', ...json(AssessmentPlanSchema) }, ...errors },
    }), async (c) => c.json(toDto(AssessmentPlanSchema, await createPlan(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/plans/{id}', access: requires('program:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The plan and what IE-001 still asks of it', ...json(AssessmentPlanSchema) }, ...errors },
    }), async (c) => c.json(toDto(AssessmentPlanSchema, await getPlan(c.get('ctx'), c.req.valid('param').id)), 200))
    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/plans/{id}', access: requires('program:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdatePlanSchema) } },
      responses: { 200: { description: 'Updated', ...json(AssessmentPlanSchema) }, ...errors },
    }), async (c) => c.json(toDto(AssessmentPlanSchema, await updatePlan(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))
    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/plan-items/{id}', access: requires('program:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(SavePlanItemSchema) } },
      responses: { 200: { description: 'The plan', ...json(AssessmentPlanSchema) }, ...errors },
    }), async (c) => c.json(toDto(AssessmentPlanSchema, await savePlanItem(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/courses/{id}/assessments', access: requires('org:read'), tags: tag,
      request: { params: idParam, query: z.object({ term: z.string().optional() }) },
      responses: { 200: { description: 'The course\'s assessments with their parts', ...json(z.array(CourseAssessmentSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(CourseAssessmentSchema), await listCourseAssessments(c.get('ctx'), c.req.valid('param').id, c.req.valid('query').term)), 200))
    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/courses/{id}/assessments', access: requires('program:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(SaveCourseAssessmentSchema) } },
      responses: { 200: { description: 'The term\'s assessments', ...json(z.array(CourseAssessmentSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(CourseAssessmentSchema), await saveCourseAssessment(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))
    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/courses/{id}/assessments/{aid}', access: requires('program:write'), tags: tag,
      request: { params: pair, body: { required: true, ...json(SaveCourseAssessmentSchema) } },
      responses: { 200: { description: 'The term\'s assessments', ...json(z.array(CourseAssessmentSchema)) }, ...errors },
    }), async (c) => { const p = c.req.valid('param'); return c.json(toDto(z.array(CourseAssessmentSchema), await saveCourseAssessment(c.get('ctx'), p.id, c.req.valid('json'), p.aid)), 200); })
    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/courses/{id}/assessments/{aid}', access: requires('program:write'), tags: tag,
      request: { params: pair },
      responses: { 200: { description: 'Deleted', ...json(z.object({ deleted: z.boolean() })) }, ...errors },
    }), async (c) => { const p = c.req.valid('param'); return c.json(await deleteCourseAssessment(c.get('ctx'), p.id, p.aid), 200); })
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/courses/{id}/attainment', access: requires('org:read'), tags: tag,
      request: { params: idParam, query: z.object({ term: z.string().min(1) }) },
      responses: { 200: { description: 'CLO attainment by the QAIEO method and the PLO roll-up', ...json(AttainmentSchema) }, ...errors },
    }), async (c) => c.json(toDto(AttainmentSchema, await getCourseAttainment(c.get('ctx'), c.req.valid('param').id, c.req.valid('query').term)), 200))
    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/courses/{id}/attainment/record', access: requires('program:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(z.object({ term: z.string().min(1) })) } },
      responses: { 200: { description: 'Recorded as direct results', ...json(z.object({ recorded: z.number() })) }, ...errors },
    }), async (c) => c.json(await recordCourseAttainment(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').term), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/results', access: requires('program:write'), tags: tag,
      request: { body: { required: true, ...json(SaveResultSchema) } },
      responses: { 201: { description: 'Added', ...json(z.object({ id: z.uuid() })) }, ...errors },
    }), async (c) => c.json(await addResult(c.get('ctx'), c.req.valid('json')), 201))
    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/results/{id}', access: requires('program:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Deleted', ...json(z.object({ deleted: z.boolean() })) }, ...errors },
    }), async (c) => c.json(await deleteResult(c.get('ctx'), c.req.valid('param').id), 200))
    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/programs/{id}/results/import', access: requires('program:write'), tags: tag,
      description: 'Imports results rows (read in the browser from a course report or survey sheet). With apply false nothing changes.',
      request: { params: idParam, body: { required: true, ...json(z.object({ rows: z.array(ImportResultRowSchema).max(5000), apply: z.boolean(), source: z.string().min(1) })) } },
      responses: { 200: { description: 'Added (or would add) and skipped', ...json(z.object({ added: z.number(), skipped: z.array(z.object({ row: z.string(), reason: z.string() })) })) }, ...errors },
    }), async (c) => { const b = c.req.valid('json'); return c.json(await importResults(c.get('ctx'), c.req.valid('param').id, b.rows, { apply: b.apply, source: b.source }), 200); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/programs/{id}/actions', access: requires('program:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(SaveActionSchema) } },
      responses: { 201: { description: 'Added', ...json(CorrectiveActionSchema) }, ...errors },
    }), async (c) => c.json(toDto(CorrectiveActionSchema, await addAction(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))
    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/actions/{id}', access: requires('program:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(SaveActionSchema.partial()) } },
      responses: { 200: { description: 'Updated', ...json(CorrectiveActionSchema) }, ...errors },
    }), async (c) => c.json(toDto(CorrectiveActionSchema, await updateAction(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/ilo-report', access: requires('program:read'), tags: tag,
      responses: { 200: { description: 'The ILO rotation and, per ILO, the linked PLOs and their latest direct results', ...json(IloReportSchema) }, ...errors },
    }), async (c) => c.json(toDto(IloReportSchema, await getIloReport(c.get('ctx'))), 200))
    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/ilo-schedule', access: requires('org:write'), tags: tag,
      request: { body: { required: true, ...json(SaveIloScheduleSchema) } },
      responses: { 200: { description: 'Saved', ...json(IloScheduleRowSchema) }, ...errors },
    }), async (c) => c.json(await saveIloSchedule(c.get('ctx'), c.req.valid('json')), 200))
    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/ilo-schedule/{id}', access: requires('org:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Deleted', ...json(z.object({ deleted: z.boolean() })) }, ...errors },
    }), async (c) => c.json(await deleteIloSchedule(c.get('ctx'), c.req.valid('param').id), 200));
}
