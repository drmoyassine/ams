import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import { cancelAnalysis, getAnalysisRun, listAnalysisRuns, startAnalysis } from '@ams/core';
import { AnalysisRunSchema, toDto } from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

/**
 * Framework analysis (PRD 15, step C): start a background run over a draft version's sources, follow it, cancel it.
 * The routes only queue and report; the model is called by the worker's `analyse` jobs, never here (DEC-012).
 */
export function analysisRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['analysis'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/{id}/analysis', access: requires('framework:write'), tags: tag,
      description: 'Starts analysing the draft version\'s sources. Refused unless the version is a draft, AI is on and set up, there are sources, and no run is active.',
      request: { params: idParam },
      responses: { 202: { description: 'Queued', ...json(AnalysisRunSchema) }, ...errors },
    }), async (c) => c.json(toDto(AnalysisRunSchema, await startAnalysis(c.get('ctx'), c.req.valid('param').id)), 202))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/framework-versions/{id}/analysis', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The version\'s analysis runs, newest first', ...json(z.array(AnalysisRunSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(AnalysisRunSchema), await listAnalysisRuns(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/analysis/{id}', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'One analysis run: status, stage, progress, usage and stats', ...json(AnalysisRunSchema) }, ...errors },
    }), async (c) => c.json(toDto(AnalysisRunSchema, await getAnalysisRun(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/analysis/{id}/cancel', access: requires('framework:write'), tags: tag,
      description: 'Stops a queued or running analysis after its current step. What it wrote so far stays in the draft.',
      request: { params: idParam },
      responses: { 200: { description: 'Cancelled', ...json(AnalysisRunSchema) }, ...errors },
    }), async (c) => c.json(toDto(AnalysisRunSchema, await cancelAnalysis(c.get('ctx'), c.req.valid('param').id)), 200));
}
