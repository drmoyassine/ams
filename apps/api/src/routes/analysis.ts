import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import { analysisPreflight, cancelAnalysis, decideWordingProposal, getAnalysisReport, getAnalysisRun, getLatestAnalysisReport, listAnalysisRuns, listWordingProposals, startAnalysis } from '@ams/core';
import { AnalysisReportSchema, AnalysisRunSchema, PreflightSchema, toDto, WordingProposalSchema } from '@ams/shared';
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
      method: 'get', path: '/api/framework-versions/{id}/analysis/preflight', access: requires('framework:write'), tags: tag,
      description: 'Can an analysis start now? A checklist (draft, sources, AI on, model and key, reading, embeddings, spend limit) with where to fix each problem. Never shows a key.',
      request: { params: idParam },
      responses: { 200: { description: 'The checks and the first blocking reason', ...json(PreflightSchema) }, ...errors },
    }), async (c) => c.json(toDto(PreflightSchema, await analysisPreflight(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/framework-versions/{id}/analysis/latest-report', access: requires('framework:read'), tags: tag,
      description: 'The report of the version\'s latest finished analysis run, or null when it has had none.',
      request: { params: idParam },
      responses: { 200: { description: 'The report, or null', ...json(AnalysisReportSchema.nullable()) }, ...errors },
    }), async (c) => c.json(toDto(AnalysisReportSchema.nullable(), await getLatestAnalysisReport(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/analysis/{id}/report', access: requires('framework:read'), tags: tag,
      description: 'The intelligence report of one analysis run, computed from what is stored and the draft as it is now.',
      request: { params: idParam },
      responses: { 200: { description: 'What was read and used, the structure found, the requirements, the gaps, the suggested links and what to look at before publishing', ...json(AnalysisReportSchema) }, ...errors },
    }), async (c) => c.json(toDto(AnalysisReportSchema, await getAnalysisReport(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/analysis/{id}/cancel', access: requires('framework:write'), tags: tag,
      description: 'Stops a queued or running analysis after its current step. What it wrote so far stays in the draft.',
      request: { params: idParam },
      responses: { 200: { description: 'Cancelled', ...json(AnalysisRunSchema) }, ...errors },
    }), async (c) => c.json(toDto(AnalysisRunSchema, await cancelAnalysis(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/framework-versions/{id}/wording-proposals', access: requires('framework:read'), tags: tag,
      description: 'The version\'s wording proposals (TASK-107): proposed replacements for an item\'s wording, each with the quote it came from, waiting for a person\'s decision.',
      request: { params: idParam },
      responses: { 200: { description: 'The proposals, newest first', ...json(z.array(WordingProposalSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(WordingProposalSchema), await listWordingProposals(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/wording-proposals/{id}/decide', access: requires('framework:write'), tags: tag,
      description: 'Accepts or declines one pending wording proposal. Accepting writes the proposed wording onto the item (undoable, like any edit) and declines the item\'s other pending proposals.',
      request: { params: idParam, body: { content: { 'application/json': { schema: z.object({ accept: z.boolean() }) } }, required: true } },
      responses: { 200: { description: 'The decided proposal', ...json(WordingProposalSchema) }, ...errors },
    }), async (c) => c.json(toDto(WordingProposalSchema, await decideWordingProposal(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200));
}
