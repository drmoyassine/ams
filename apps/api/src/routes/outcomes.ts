import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  createCourse, createOutcome, deleteOutcome, getCourse, getOutcomeLevels, getProgramOutcomes, listCourseOutcomes, listCourses, listIlos,
  loadOutcomesWorkbook, removeCourseProgram, removeOutcomeLink, setCourseProgram, setOutcomeLevels, setOutcomeLink, updateCourse, updateOutcome,
} from '@ams/core';
import {
  CourseProgramInputSchema, CourseSchema, CreateCourseSchema, CreateOutcomeSchema, LearningOutcomeSchema, OutcomeLevelSchema, OutcomeLinkInputSchema,
  OutcomeLinkSchema, OutcomesWorkbookResultSchema, OutcomesWorkbookSchema, ProgramOutcomesSchema, UpdateCourseSchema, UpdateOutcomeSchema, toDto,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

// Courses, learning outcomes and their links (TASK-105, TASK-112). The chain checks the permission is held somewhere; the services
// check it at the unit, program or institution in question.
export function outcomeRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['outcomes'];
  const coursePair = z.object({ id: z.uuid(), programId: z.uuid() });
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/courses', access: requires('org:read'), tags: tag,
      request: { query: z.object({ programId: z.uuid().optional() }) },
      responses: { 200: { description: 'The institution\'s courses (of one program with programId)', ...json(z.array(CourseSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(CourseSchema), await listCourses(c.get('ctx'), c.req.valid('query'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/courses', access: requires('program:write'), tags: tag,
      request: { body: { required: true, ...json(CreateCourseSchema) } },
      responses: { 201: { description: 'Created', ...json(CourseSchema) }, ...errors },
    }), async (c) => c.json(toDto(CourseSchema, await createCourse(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/courses/{id}', access: requires('org:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'A course', ...json(CourseSchema) }, ...errors },
    }), async (c) => c.json(toDto(CourseSchema, await getCourse(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/courses/{id}', access: requires('program:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateCourseSchema) } },
      responses: { 200: { description: 'Updated', ...json(CourseSchema) }, ...errors },
    }), async (c) => c.json(toDto(CourseSchema, await updateCourse(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/courses/{id}/programs/{programId}', access: requires('program:write'), tags: tag,
      description: 'Puts the course in the program, or changes its role (core, elective, service), year and term there.',
      request: { params: coursePair, body: { required: true, ...json(CourseProgramInputSchema) } },
      responses: { 200: { description: 'The course', ...json(CourseSchema) }, ...errors },
    }), async (c) => { const p = c.req.valid('param'); return c.json(toDto(CourseSchema, await setCourseProgram(c.get('ctx'), p.id, p.programId, c.req.valid('json'))), 200); })

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/courses/{id}/programs/{programId}', access: requires('program:write'), tags: tag,
      description: 'Takes the course out of the program; its CLOs\' links to that program\'s PLOs are removed with it.',
      request: { params: coursePair },
      responses: { 200: { description: 'The course', ...json(CourseSchema) }, ...errors },
    }), async (c) => { const p = c.req.valid('param'); return c.json(toDto(CourseSchema, await removeCourseProgram(c.get('ctx'), p.id, p.programId)), 200); })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/courses/{id}/outcomes', access: requires('org:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The course\'s CLOs', ...json(z.array(LearningOutcomeSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(LearningOutcomeSchema), await listCourseOutcomes(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/programs/{id}/outcomes', access: requires('program:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'PEOs, PLOs, indicators, ILOs, courses with CLOs, links, curriculum map and coverage', ...json(ProgramOutcomesSchema) }, ...errors },
    }), async (c) => c.json(toDto(ProgramOutcomesSchema, await getProgramOutcomes(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/ilos', access: requires('org:read'), tags: tag,
      responses: { 200: { description: 'The institution\'s learning outcomes', ...json(z.array(LearningOutcomeSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(LearningOutcomeSchema), await listIlos(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/outcomes', access: requires('program:write'), tags: tag,
      description: 'Adds an ILO (org:write at the institution), a PEO, PLO or performance indicator (program:write on the program) or a CLO (program:write at the course\'s unit).',
      request: { body: { required: true, ...json(CreateOutcomeSchema) } },
      responses: { 201: { description: 'Created', ...json(LearningOutcomeSchema) }, ...errors },
    }), async (c) => c.json(toDto(LearningOutcomeSchema, await createOutcome(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/outcomes/{id}', access: requires('program:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateOutcomeSchema) } },
      responses: { 200: { description: 'Updated', ...json(LearningOutcomeSchema) }, ...errors },
    }), async (c) => c.json(toDto(LearningOutcomeSchema, await updateOutcome(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/outcomes/{id}', access: requires('program:write'), tags: tag,
      description: 'Deletes a draft outcome and its links. An approved or retired outcome is kept for the record.',
      request: { params: idParam },
      responses: { 200: { description: 'Deleted', ...json(z.object({ deleted: z.literal(true) })) }, ...errors },
    }), async (c) => c.json(await deleteOutcome(c.get('ctx'), c.req.valid('param').id), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/outcome-links', access: requires('program:write'), tags: tag,
      description: 'Adds or changes a link: CLO -> PLO with a mapping level (a code or alias, or null), PLO -> ILO, PLO -> PEO.',
      request: { body: { required: true, ...json(OutcomeLinkInputSchema) } },
      responses: { 200: { description: 'The link', ...json(OutcomeLinkSchema) }, ...errors },
    }), async (c) => c.json(toDto(OutcomeLinkSchema, await setOutcomeLink(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/outcome-links/remove', access: requires('program:write'), tags: tag,
      request: { body: { required: true, ...json(z.object({ fromId: z.uuid(), toId: z.uuid() })) } },
      responses: { 200: { description: 'Removed', ...json(z.object({ removed: z.boolean() })) }, ...errors },
    }), async (c) => { const b = c.req.valid('json'); return c.json(await removeOutcomeLink(c.get('ctx'), b.fromId, b.toId), 200); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/outcomes/workbook', access: requires('org:write'), tags: tag,
      description: 'Loads programs, PEOs and PLOs from the rows of a workbook (read in the browser). Additive: creates what is missing, fills empty program fields, never overwrites. With apply false it only reports what would happen.',
      request: { body: { required: true, ...json(OutcomesWorkbookSchema) } },
      responses: { 200: { description: 'What was (or would be) done', ...json(OutcomesWorkbookResultSchema) }, ...errors },
    }), async (c) => c.json(toDto(OutcomesWorkbookResultSchema, await loadOutcomesWorkbook(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/settings/outcome-levels', access: requires('org:read'), tags: tag,
      responses: { 200: { description: 'The CLO-PLO mapping levels (DEC-036)', ...json(z.array(OutcomeLevelSchema)) }, ...errors },
    }), async (c) => c.json(await getOutcomeLevels(c.get('ctx')), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/settings/outcome-levels', access: requires('org:write'), tags: tag,
      request: { body: { required: true, ...json(z.array(OutcomeLevelSchema)) } },
      responses: { 200: { description: 'Saved', ...json(z.array(OutcomeLevelSchema)) }, ...errors },
    }), async (c) => c.json(await setOutcomeLevels(c.get('ctx'), c.req.valid('json')), 200));
}
