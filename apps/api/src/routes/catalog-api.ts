import { OpenAPIHono, type Hook } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  createConcentration, createGenedArea, createStudySlot, deleteConcentration, deleteGenedArea, deleteStudySlot, getProgramRequirements, listGenedAreas, setAreaCourses, setCatalogSettings, setProgramBlock,
  updateConcentration, updateGenedArea, updateStudySlot,
} from '@ams/core';
import {
  CatalogSettingsSchema, ConcentrationSchema, CreateConcentrationSchema, CreateGenedAreaSchema, CreateStudySlotSchema, GenedAreaSchema, GenedOverviewSchema, ProgramBlockSchema, ProgramRequirementsSchema,
  SetAreaCoursesSchema, SetProgramBlockSchema, StudySlotSchema, UpdateConcentrationSchema, UpdateGenedAreaSchema, UpdateStudySlotSchema, toDto,
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
      description: 'Sets the credits of General Education, the same for every degree (needs program:write for the whole institution).',
      request: { body: { required: true, ...json(CatalogSettingsSchema) } },
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
      method: 'get', path: '/api/programs/{id}/requirements', access: requires('org:read'), tags: tag,
      description: 'A program\'s requirements: its concentrations, the credits asked of each block, its study plan and elective slots, the credits planned per block, and what the checks flag (General Education total and areas, block credits, the degree\'s credits).',
      request: { params: idParam },
      responses: { 200: { description: 'The requirements', ...json(ProgramRequirementsSchema) }, ...errors },
    }), async (c) => c.json(toDto(ProgramRequirementsSchema, await getProgramRequirements(c.get('ctx'), c.req.valid('param').id)), 200))

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
