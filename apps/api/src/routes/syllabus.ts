import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  approveSyllabus, discardDraft, endorseSyllabus, escalateFlags, getStartingSyllabus, getSyllabusOverview, importSyllabi, getSyllabusSettings, listSyllabi, resolveSuggestion, returnSyllabus,
  saveSyllabusDraft, setCourseStaff, setSyllabusSettings, submitSyllabus, suggestChange, upsertSyllabus,
} from '@ams/core';
import {
  ApproveSyllabusSchema, CourseStaffSchema, ResolveSuggestionSchema, SaveSyllabusSchema, SuggestSchema, SyllabusContentSchema, SyllabusListSchema, SyllabusNoteSchema, SyllabusOverviewSchema,
  SyllabusSettingsSchema, SyllabusSuggestionSchema, SyllabusWorkbookSchema, SyllabusVersionSchema, UpsertSyllabusSchema, toDto,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

// The course syllabus (DEC-038, TASK-124): read, save a draft, upsert by course code (the import and other systems), suggestions, and the
// workflow. Mounted beside the main chain (its type is at the compiler's limit) with its own typed client (SyllabusRoutes). Reading needs
// org:read; who may edit, suggest, endorse and approve is decided by the services (the coordinator, the program chair, the Dean).
export function syllabusRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['syllabus'];
  const flagged = z.object({ flagged: z.enum(['true', 'false']).optional(), mine: z.enum(['true', 'false']).optional() });
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/courses/{id}/syllabus', access: requires('org:read'), tags: tag,
      description: 'The course\'s syllabus: the approved version, the version in progress, the history, the suggestions, what the caller may do, the limits, the template and the PLO choices.',
      request: { params: idParam },
      responses: { 200: { description: 'The syllabus overview', ...json(SyllabusOverviewSchema) }, ...errors },
    }), async (c) => c.json(toDto(SyllabusOverviewSchema, await getSyllabusOverview(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/courses/{id}/syllabus/starting', access: requires('org:read'), tags: tag,
      description: 'A starting syllabus built from what the course already holds (its facts, CLOs, PLO links and levels).',
      request: { params: idParam },
      responses: { 200: { description: 'A syllabus document', ...json(SyllabusContentSchema) }, ...errors },
    }), async (c) => c.json(toDto(SyllabusContentSchema, await getStartingSyllabus(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/courses/{id}/syllabus', access: requires('org:read'), tags: tag,
      description: 'Saves the draft of the course\'s syllabus (creates it, or replaces the draft in progress). A rule never blocks this: the issues come back flagged. Only the course coordinator (or a course writer) may.',
      request: { params: idParam, body: { required: true, ...json(SaveSyllabusSchema) } },
      responses: { 200: { description: 'The draft, with its issues', ...json(SyllabusVersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(SyllabusVersionSchema, await saveSyllabusDraft(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/courses/{id}/syllabus/draft', access: requires('org:read'), tags: tag,
      description: 'Discards the draft in progress (an approved version is never deleted).',
      request: { params: idParam },
      responses: { 200: { description: 'Whether a draft was discarded', ...json(z.object({ deleted: z.boolean() })) }, ...errors },
    }), async (c) => c.json(await discardDraft(c.get('ctx'), c.req.valid('param').id), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/syllabi/upsert', access: requires('org:read'), tags: tag,
      description: 'Creates or updates a course\'s draft syllabus by course code (the import and other systems). It always loads: broken rules are flagged to the coordinator, never refused. Only people approve.',
      request: { body: { required: true, ...json(UpsertSyllabusSchema) } },
      responses: { 200: { description: 'The draft, with its issues', ...json(SyllabusVersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(SyllabusVersionSchema, await upsertSyllabus(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/courses/{id}/staff', access: requires('org:read'), tags: tag,
      description: 'Names the course coordinator and the instructors. Needs program:write at the course\'s unit.',
      request: { params: idParam, body: { required: true, ...json(CourseStaffSchema) } },
      responses: { 200: { description: 'The staff', ...json(CourseStaffSchema) }, ...errors },
    }), async (c) => c.json(await setCourseStaff(c.get('ctx'), c.req.valid('param').id, c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/syllabi/import', access: requires('org:read'), tags: tag,
      description: 'Loads the rows of the Excel workbook (sheets Courses, CLOs, Outline, Materials, Assessments, Rubrics) as draft syllabi. A rule never refuses a course: it loads with its issues flagged. A course the caller may not edit, that is in review, or that does not exist is reported and skipped.',
      request: { body: { required: true, ...json(SyllabusWorkbookSchema) } },
      responses: { 200: { description: 'What loaded and what was skipped', ...json(z.object({ results: z.array(z.object({ courseCode: z.string(), status: z.enum(['loaded', 'unknown_course', 'not_allowed', 'in_review']), versionNo: z.number().optional(), errors: z.number().optional(), warnings: z.number().optional(), message: z.string().optional() })), loaded: z.number(), flagged: z.number() })) }, ...errors },
    }), async (c) => c.json(await importSyllabi(c.get('ctx'), c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/syllabi', access: requires('org:read'), tags: tag,
      description: 'One row per course: its approved version, the version in progress and the flag. `needsMyAttention` follows the line: the coordinator at once, then the chair, the Dean and the VPAA as days pass.',
      request: { query: flagged },
      responses: { 200: { description: 'The syllabi', ...json(SyllabusListSchema) }, ...errors },
    }), async (c) => { const q = c.req.valid('query'); return c.json(toDto(SyllabusListSchema, await listSyllabi(c.get('ctx'), { flagged: q.flagged === 'true', mine: q.mine === 'true' })), 200); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/syllabi/escalate', access: requires('org:read'), tags: tag,
      description: 'Tells the next level of the line about every flag that has gone unfixed past its days (once per level). Called when the Syllabi list is opened.',
      responses: { 200: { description: 'How many notices were made', ...json(z.object({ notified: z.number() })) }, ...errors },
    }), async (c) => c.json(await escalateFlags(c.get('ctx')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/syllabus-versions/{id}/suggestions', access: requires('org:read'), tags: tag,
      description: 'An instructor (or anyone on the line) suggests a change to a section of the syllabus in progress.',
      request: { params: idParam, body: { required: true, ...json(SuggestSchema) } },
      responses: { 201: { description: 'The suggestion', ...json(SyllabusSuggestionSchema) }, ...errors },
    }), async (c) => c.json(toDto(SyllabusSuggestionSchema, await suggestChange(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/syllabus-suggestions/{id}/resolve', access: requires('org:read'), tags: tag,
      description: 'The course coordinator accepts or declines a suggestion.',
      request: { params: idParam, body: { required: true, ...json(ResolveSuggestionSchema) } },
      responses: { 200: { description: 'The decision', ...json(z.object({ id: z.uuid(), status: z.enum(['accepted', 'declined']) })) }, ...errors },
    }), async (c) => c.json(await resolveSuggestion(c.get('ctx'), c.req.valid('param').id, c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/syllabus-versions/{id}/submit', access: requires('org:read'), tags: tag,
      description: 'The coordinator submits the draft for review. Refused while it has errors.',
      request: { params: idParam },
      responses: { 200: { description: 'The version, in review', ...json(SyllabusVersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(SyllabusVersionSchema, await submitSyllabus(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/syllabus-versions/{id}/return', access: requires('org:read'), tags: tag,
      description: 'The program chair or the Dean sends it back to the coordinator with a note.',
      request: { params: idParam, body: { required: false, ...json(SyllabusNoteSchema) } },
      responses: { 200: { description: 'The version, a draft again', ...json(SyllabusVersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(SyllabusVersionSchema, await returnSyllabus(c.get('ctx'), c.req.valid('param').id, (await c.req.json().catch(() => ({})) as { note?: string }).note)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/syllabus-versions/{id}/endorse', access: requires('org:read'), tags: tag,
      description: 'The program chair endorses the syllabus in review.',
      request: { params: idParam },
      responses: { 200: { description: 'The version, endorsed', ...json(SyllabusVersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(SyllabusVersionSchema, await endorseSyllabus(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/syllabus-versions/{id}/approve', access: requires('org:read'), tags: tag,
      description: 'The Dean approves an endorsed syllabus: the course takes its facts and CLOs and the previous version is superseded.',
      request: { params: idParam, body: { required: false, ...json(ApproveSyllabusSchema) } },
      responses: { 200: { description: 'The version, approved', ...json(SyllabusVersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(SyllabusVersionSchema, await approveSyllabus(c.get('ctx'), c.req.valid('param').id, (await c.req.json().catch(() => ({})) as { effectiveFrom?: string }))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/settings/syllabus', access: requires('org:read'), tags: tag,
      description: 'The syllabus limits (minimum and maximum CLOs and PLOs per course) and the escalation days.',
      responses: { 200: { description: 'The settings', ...json(SyllabusSettingsSchema) }, ...errors },
    }), async (c) => c.json(await getSyllabusSettings(c.get('ctx')), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/settings/syllabus', access: requires('org:write'), tags: tag,
      description: 'Sets the limits and the escalation days; every syllabus is checked again and the ones that now break a limit are flagged.',
      request: { body: { required: true, ...json(SyllabusSettingsSchema) } },
      responses: { 200: { description: 'The settings', ...json(SyllabusSettingsSchema) }, ...errors },
    }), async (c) => c.json(await setSyllabusSettings(c.get('ctx'), c.req.valid('json')), 200));
}
