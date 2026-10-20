// The academic calendar, cycle plans and proposed runs (TASK-081, DEC-029). The calendar (Settings -> Organization -> Institution) is read
// with org:read and changed with org:write. Plans are read with cycle:read and set with cycle:manage (the service checks it for the whole
// institution); a plan on a standard is named by standard and code, so it works on a published version. "Due to launch" is computed on
// request and only PROPOSES: launching is POST /api/cycles with the plan and period. Every change answers with an X-Undo header where it can be taken back.
import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  clearPlan, createAcademicTerm, deleteAcademicTerm, getTargetPlans, listAcademicTerms, listDueRuns, listPlans, reorderAcademicTerms, setNextDate, setPlan, skipDueRun, unskipDueRun, updateAcademicTerm,
} from '@ams/core';
import {
  AcademicTermSchema, CreateAcademicTermSchema, CyclePlanSchema, DueRunsQuerySchema, DueRunsSchema, PlanTargetSchema, ReorderAcademicTermsSchema, SetNextDateSchema, SetPlanSchema, SkipDueRunSchema,
  TargetPlansSchema, UpdateAcademicTermSchema, toDto,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

export function planRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['cycle-plans'];
  const read = requires('cycle:read');
  const manage = requires('cycle:manage');
  return new OpenAPIHono<AppEnv>(options)
    // ---- Academic calendar -------------------------------------------------------------------------------------------------
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/academic-terms', access: requires('org:read'), tags: tag,
      description: 'The institution\'s years and terms in the order they were arranged.',
      responses: { 200: { description: 'Years and terms', ...json(z.array(AcademicTermSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(AcademicTermSchema), await listAcademicTerms(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/academic-terms', access: requires('org:write'), tags: tag,
      description: 'Adds a year or a term. Active ones of a kind never overlap.',
      request: { body: { required: true, ...json(CreateAcademicTermSchema) } },
      responses: { 201: { description: 'Added', ...json(AcademicTermSchema) }, ...errors },
    }), async (c) => c.json(toDto(AcademicTermSchema, await createAcademicTerm(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/academic-terms/reorder', access: requires('org:write'), tags: tag,
      description: 'The whole list of ids in the new order.',
      request: { body: { required: true, ...json(ReorderAcademicTermsSchema) } },
      responses: { 200: { description: 'Reordered', ...json(z.array(AcademicTermSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(AcademicTermSchema), await reorderAcademicTerms(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/academic-terms/{id}', access: requires('org:write'), tags: tag,
      description: 'Renames (English and Arabic), changes the dates, or switches off or on.',
      request: { params: idParam, body: { required: true, ...json(UpdateAcademicTermSchema) } },
      responses: { 200: { description: 'Updated', ...json(AcademicTermSchema) }, ...errors },
    }), async (c) => c.json(toDto(AcademicTermSchema, await updateAcademicTerm(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/academic-terms/{id}', access: requires('org:write'), tags: tag,
      description: 'Removes a year or a term; runs already made keep their label.',
      request: { params: idParam }, responses: { 204: { description: 'Deleted' }, ...errors },
    }), async (c) => { await deleteAcademicTerm(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); })

    // ---- Plans ---------------------------------------------------------------------------------------------------------------
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/cycle-plans', access: read, tags: tag,
      description: 'Every plan and opt-out, with its anchor, template, recurrence, next run not yet launched and how many subjects it covers.',
      responses: { 200: { description: 'Plans', ...json(z.array(CyclePlanSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(CyclePlanSchema), await listPlans(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/cycle-plans/target', access: read, tags: tag,
      description: 'The plans set on one anchor (a requirement by standard and code) and, for a requirement, the plans in effect on it with their sources and what "Back to inherited" would give.',
      request: { query: PlanTargetSchema },
      responses: { 200: { description: 'Own, effective and inherited plans', ...json(TargetPlansSchema) }, ...errors },
    }), async (c) => c.json(toDto(TargetPlansSchema, await getTargetPlans(c.get('ctx'), c.req.valid('query'))), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/cycle-plans', access: manage, tags: tag,
      description: 'Sets the plan of an anchor for a template (new, or the change of the one there). mode opt_out stops that template\'s plan being inherited. Plans only propose runs.',
      request: { body: { required: true, ...json(SetPlanSchema) } },
      responses: { 200: { description: 'The plan', ...json(CyclePlanSchema) }, ...errors },
    }), async (c) => c.json(toDto(CyclePlanSchema, await setPlan(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/cycle-plans/{id}', access: manage, tags: tag,
      description: 'Back to inherited: removes the plan or opt-out. A plan that already made cycles cannot be removed.',
      request: { params: idParam }, responses: { 204: { description: 'Removed' }, ...errors },
    }), async (c) => { await clearPlan(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-plans/{id}/next-date', access: manage, tags: tag,
      description: 'For a plan whose next run is set by a decision: records the date of the next run.',
      request: { params: idParam, body: { required: true, ...json(SetNextDateSchema) } },
      responses: { 200: { description: 'The plan', ...json(CyclePlanSchema) }, ...errors },
    }), async (c) => c.json(toDto(CyclePlanSchema, await setNextDate(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').date)), 200))

    // ---- Proposed runs -------------------------------------------------------------------------------------------------------
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/due-cycle-runs', access: read, tags: tag,
      description: 'The runs due or coming up (no run exists yet and the period was not skipped), computed on request. QA reviews and launches them; nothing launches automatically.',
      request: { query: DueRunsQuerySchema },
      responses: { 200: { description: 'Proposed runs and stretches the calendar does not cover', ...json(DueRunsSchema) }, ...errors },
    }), async (c) => c.json(toDto(DueRunsSchema, await listDueRuns(c.get('ctx'), c.req.valid('query'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-plan-skips', access: manage, tags: tag,
      description: 'Skip this period: records the reason and the run is not proposed again.',
      request: { body: { required: true, ...json(SkipDueRunSchema) } },
      responses: { 200: { description: 'Skipped', ...json(z.object({ ok: z.literal(true) })) }, ...errors },
    }), async (c) => c.json(await skipDueRun(c.get('ctx'), c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/cycle-plan-skips/{id}', access: manage, tags: tag,
      description: 'Brings a skipped period back (Undo of a skip).',
      request: { params: idParam }, responses: { 204: { description: 'Removed' }, ...errors },
    }), async (c) => { await unskipDueRun(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); });
}
