import { OpenAPIHono, type Hook } from '@hono/zod-openapi';
import { deleteCourse, exportCourses, upsertCourses } from '@ams/core';
import { CourseSchema, CoursesExportSchema, UpsertCoursesResultSchema, UpsertCoursesSchema, toDto } from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

// Courses over the API (DEC-042): list, create, one and update are in outcomes.ts; here delete (deactivate) and the courses workbook (every
// course with its record, placements and content; and its import). Mounted beside the main chain with its own typed client (CourseRoutes).
export function courseRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['courses'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/courses-workbook', access: requires('org:read'), tags: tag,
      description: 'Every course as the rows of the courses workbook (Courses, Placement, CLOs, Outline, Materials, Assessments, Rubrics, Sections), each course with its ID and its content (its draft in progress, else the approved content), and the choices for the template\'s dropdowns.',
      responses: { 200: { description: 'The rows and the lists', ...json(CoursesExportSchema) }, ...errors },
    }), async (c) => c.json(toDto(CoursesExportSchema, await exportCourses(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/courses-workbook', access: requires('program:write'), tags: tag,
      description: 'Adds or updates courses from the workbook rows, by ID or Course code. The record (code, unit, year of study, SIS code, coordinator, active) and the programs a course serves change at once; its content goes into its draft (approved as on the course page), a part of it replaced only when the file has rows for that course. An empty cell leaves a field as it is; nothing absent is removed. With apply false nothing is written.',
      request: { body: { required: true, ...json(UpsertCoursesSchema) } },
      responses: { 200: { description: 'What was (or would be) done, row by row', ...json(UpsertCoursesResultSchema) }, ...errors },
    }), async (c) => c.json(toDto(UpsertCoursesResultSchema, await upsertCourses(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/courses/{id}', access: requires('program:write'), tags: tag,
      description: 'Deactivates the course: results, syllabi and the audit trail refer to it, so the record stays and can be reactivated (PATCH active: true).',
      request: { params: idParam },
      responses: { 200: { description: 'The course, inactive', ...json(CourseSchema) }, ...errors },
    }), async (c) => c.json(toDto(CourseSchema, await deleteCourse(c.get('ctx'), c.req.valid('param').id)), 200));
}
