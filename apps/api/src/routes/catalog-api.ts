import { OpenAPIHono, type Hook } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  createConcentration, createGenedArea, createStudySlot, deleteConcentration, getCatalogVersion, listCatalogEditions, previewCatalogSnapshot, publishCatalogVersion, startCatalogEdition, deleteGenedArea, deleteStudySlot, getProgramRequirements, listGenedAreas, setAreaCourses, setCatalogSettings, setProgramBlock,
  setProgramGenedArea, updateConcentration, updateGenedArea, updateStudySlot,
} from '@ams/core';
import {
  CatalogEditionSchema, CatalogEditionsSchema, CatalogSettingsSchema, CatalogSnapshotSchema, CatalogVersionSchema, CatalogVersionSummarySchema, ConcentrationSchema, PublishVersionSchema, StartEditionSchema, CreateConcentrationSchema, CreateGenedAreaSchema, CreateStudySlotSchema, GenedAreaSchema, GenedOverviewSchema, ProgramBlockSchema, ProgramRequirementsSchema,
  SetAreaCoursesSchema, SetProgramBlockSchema, SetProgramGenedAreaSchema, StudySlotSchema, UpdateConcentrationSchema, UpdateGenedAreaSchema, UpdateStudySlotSchema, toDto,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

// The catalog's structure (DEC-046): General Education (credits, areas, pools; Academic Affairs), a program's concentrations, block credits,
// elective slots and its requirements with their checks. Mounted beside the main chain with its own typed client (CatalogRoutes).
export function catalogRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['catalog'];
  const deleted = z.object({ deleted: z.boolean() });
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/catalog/gened', access: requires('org:read'), tags: tag,
      description: 'General Education: its credits, and its areas, each with its minimum credits and the pool of courses that count toward it.',
      responses: { 200: { description: 'The settings and the areas', ...json(GenedOverviewSchema) }, ...errors },
    }), async (c) => c.json(toDto(GenedOverviewSchema, await listGenedAreas(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/catalog/settings', access: requires('program:write'), tags: tag,
      description: 'Sets the institution\'s defaults: the credits of General education and of Free electives (a program may set its own). A field left out stays as it is. Needs program:write for the whole institution.',
      request: { body: { required: true, ...json(CatalogSettingsSchema.partial()) } },
      responses: { 200: { description: 'The settings', ...json(CatalogSettingsSchema) }, ...errors },
    }), async (c) => c.json(toDto(CatalogSettingsSchema, await setCatalogSettings(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/catalog/gened/areas', access: requires('program:write'), tags: tag,
      request: { body: { required: true, ...json(CreateGenedAreaSchema) } },
      responses: { 200: { description: 'The area', ...json(GenedAreaSchema) }, ...errors },
    }), async (c) => c.json(toDto(GenedAreaSchema, await createGenedArea(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/catalog/gened/areas/{id}', access: requires('program:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateGenedAreaSchema) } },
      responses: { 200: { description: 'The area', ...json(GenedAreaSchema) }, ...errors },
    }), async (c) => c.json(toDto(GenedAreaSchema, await updateGenedArea(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/catalog/gened/areas/{id}', access: requires('program:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Deleted', ...json(deleted) }, ...errors },
    }), async (c) => c.json(await deleteGenedArea(c.get('ctx'), c.req.valid('param').id), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/catalog/gened/areas/{id}/courses', access: requires('program:write'), tags: tag,
      description: 'Sets the pool of the area: exactly these courses count toward it.',
      request: { params: idParam, body: { required: true, ...json(SetAreaCoursesSchema) } },
      responses: { 200: { description: 'The area', ...json(GenedAreaSchema) }, ...errors },
    }), async (c) => c.json(toDto(GenedAreaSchema, await setAreaCourses(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').courseIds)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/catalog/editions', access: requires('org:read'), tags: tag,
      description: 'The catalog editions (one per academic year) with their published versions, and the draft of the working edition: what publishing now would add, and what the checks flag.',
      responses: { 200: { description: 'The editions', ...json(CatalogEditionsSchema) }, ...errors },
    }), async (c) => c.json(toDto(CatalogEditionsSchema, await listCatalogEditions(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/catalog/editions', access: requires('program:write'), tags: tag,
      description: 'Starts an edition (a new academic year, for example 2027-28); the edition being worked on must have a published version and is closed. Needs program:write for the whole institution (Academic Affairs).',
      request: { body: { required: true, ...json(StartEditionSchema) } },
      responses: { 200: { description: 'The edition', ...json(CatalogEditionSchema) }, ...errors },
    }), async (c) => c.json(toDto(CatalogEditionSchema, await startCatalogEdition(c.get('ctx'), c.req.valid('json').label)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/catalog/versions', access: requires('program:write'), tags: tag,
      description: 'Publishes the live structure as the next version of the working edition: a frozen snapshot of everything the catalog prints (programs, requirements, study plans, courses with their approved content, requisites) and the list of what changed since the version before. A published version never changes.',
      request: { body: { required: true, ...json(PublishVersionSchema) } },
      responses: { 200: { description: 'The version', ...json(CatalogVersionSummarySchema) }, ...errors },
    }), async (c) => c.json(toDto(CatalogVersionSummarySchema, await publishCatalogVersion(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/catalog/versions/{id}', access: requires('org:read'), tags: tag,
      description: 'A published version with its snapshot and its changes.',
      request: { params: idParam },
      responses: { 200: { description: 'The version', ...json(CatalogVersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(CatalogVersionSchema, await getCatalogVersion(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/catalog/preview', access: requires('org:read'), tags: tag,
      description: 'The draft as a snapshot: what the next version would freeze.',
      responses: { 200: { description: 'The snapshot', ...json(CatalogSnapshotSchema) }, ...errors },
    }), async (c) => c.json(toDto(CatalogSnapshotSchema, await previewCatalogSnapshot(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/programs/{id}/requirements', access: requires('org:read'), tags: tag,
      description: 'A program\'s requirements: its concentrations, the credits asked of each block, its study plan and elective slots, the credits planned per block, and what the checks flag (General Education total and areas, block credits, the degree\'s credits).',
      request: { params: idParam },
      responses: { 200: { description: 'The requirements', ...json(ProgramRequirementsSchema) }, ...errors },
    }), async (c) => c.json(toDto(ProgramRequirementsSchema, await getProgramRequirements(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/program-gened-areas', access: requires('program:write'), tags: tag,
      description: 'Sets a program\'s own minimum for a General education area (0: the program does not ask for it); null returns it to the institution\'s.',
      request: { body: { required: true, ...json(SetProgramGenedAreaSchema) } },
      responses: { 200: { description: 'The minimum that is now the program\'s own', ...json(z.object({ minCredits: z.number().nullable() })) }, ...errors },
    }), async (c) => c.json(await setProgramGenedArea(c.get('ctx'), c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/concentrations', access: requires('program:write'), tags: tag,
      request: { body: { required: true, ...json(CreateConcentrationSchema) } },
      responses: { 200: { description: 'The concentration', ...json(ConcentrationSchema) }, ...errors },
    }), async (c) => c.json(toDto(ConcentrationSchema, await createConcentration(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/concentrations/{id}', access: requires('program:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateConcentrationSchema) } },
      responses: { 200: { description: 'The concentration', ...json(ConcentrationSchema) }, ...errors },
    }), async (c) => c.json(toDto(ConcentrationSchema, await updateConcentration(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/concentrations/{id}', access: requires('program:write'), tags: tag,
      description: 'Deletes a concentration nobody uses; one with courses, slots or credits is deactivated instead (`deleted` says which).',
      request: { params: idParam },
      responses: { 200: { description: 'What was done', ...json(z.object({ deleted: z.boolean(), concentration: ConcentrationSchema })) }, ...errors },
    }), async (c) => c.json(toDto(z.object({ deleted: z.boolean(), concentration: ConcentrationSchema }), await deleteConcentration(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/program-blocks', access: requires('program:write'), tags: tag,
      description: 'Sets the credits a program (or one of its concentrations) asks of a block, core or elective; credits null clears it.',
      request: { body: { required: true, ...json(SetProgramBlockSchema) } },
      responses: { 200: { description: 'The block, or null when cleared', ...json(ProgramBlockSchema.nullable()) }, ...errors },
    }), async (c) => c.json(toDto(ProgramBlockSchema.nullable(), await setProgramBlock(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/study-slots', access: requires('program:write'), tags: tag,
      description: 'An elective slot of a program\'s study plan: a name, the rule that fills it, credits, and where it sits (block, concentration, year, term).',
      request: { body: { required: true, ...json(CreateStudySlotSchema) } },
      responses: { 200: { description: 'The slot', ...json(StudySlotSchema) }, ...errors },
    }), async (c) => c.json(toDto(StudySlotSchema, await createStudySlot(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/study-slots/{id}', access: requires('program:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateStudySlotSchema) } },
      responses: { 200: { description: 'The slot', ...json(StudySlotSchema) }, ...errors },
    }), async (c) => c.json(toDto(StudySlotSchema, await updateStudySlot(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/study-slots/{id}', access: requires('program:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Deleted', ...json(deleted) }, ...errors },
    }), async (c) => c.json(await deleteStudySlot(c.get('ctx'), c.req.valid('param').id), 200));
}
