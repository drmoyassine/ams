import { OpenAPIHono, type Hook } from '@hono/zod-openapi';
import { deleteProgram, exportPrograms, getProgram, upsertPrograms } from '@ams/core';
import { ProgramSchema, ProgramsExportSchema, UpsertProgramsResultSchema, UpsertProgramsSchema, toDto } from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

// Programs over the API (the owner, 2026-11-16): list and create (routes.ts), update (settings.ts), and here one program and delete.
// A program's PEOs and PLOs are read with GET /api/programs/{id}/outcomes and written with /api/outcomes. Mounted beside the main
// chain (its type is at the compiler's limit) with its own typed client (ProgramRoutes).
export function programRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['programs'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/programs/export', access: requires('program:read'), tags: tag,
      description: 'Every program the caller sees, with its PEOs and PLOs, as the rows of the template (sheets Programs, PEOs, PLOs, each row with its ID), and the choices for the template\'s dropdowns (units as org-chart paths, languages).',
      responses: { 200: { description: 'The rows and the lists', ...json(ProgramsExportSchema) }, ...errors },
    }), async (c) => c.json(toDto(ProgramsExportSchema, await exportPrograms(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/programs/upsert', access: requires('program:write'), tags: tag,
      description: 'Adds or updates programs, PEOs and PLOs from the template rows, matched by Program code (and outcome code). An empty cell leaves a field as it is; nothing absent is removed. A row missing a required field is saved and flagged; one that cannot be placed is skipped with the reason. With apply false nothing is written.',
      request: { body: { required: true, ...json(UpsertProgramsSchema) } },
      responses: { 200: { description: 'What was (or would be) done, row by row', ...json(UpsertProgramsResultSchema) }, ...errors },
    }), async (c) => c.json(toDto(UpsertProgramsResultSchema, await upsertPrograms(c.get('ctx'), c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/programs/{id}', access: requires('program:read'), tags: tag,
      description: 'One program, with what its record still lacks (`missing`).',
      request: { params: idParam },
      responses: { 200: { description: 'The program', ...json(ProgramSchema) }, ...errors },
    }), async (c) => c.json(toDto(ProgramSchema, await getProgram(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/programs/{id}', access: requires('program:write'), tags: tag,
      description: 'Deactivates the program: engagements, results and the audit trail refer to it, so the record stays and can be reactivated (PATCH active: true).',
      request: { params: idParam },
      responses: { 200: { description: 'The program, inactive', ...json(ProgramSchema) }, ...errors },
    }), async (c) => c.json(toDto(ProgramSchema, await deleteProgram(c.get('ctx'), c.req.valid('param').id)), 200));
}
