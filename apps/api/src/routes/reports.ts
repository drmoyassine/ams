// Reports (TASK-091, PRD 10): create one from a reviewed template, read it back as a section tree, rename it, save a
// section's content, hand a section to a person, delete a draft to the Trash. Reads need report:read; managing (create,
// rename, owners, delete) needs report:manage at the route and again at the report's wrapper in the service; saving
// content needs report:write (the service checks it at the wrapper). The review moves and submission arrive with TASK-094.
import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import { createReport, deleteReport, getReport, listReports, setSectionOwner, updateReport, updateSectionContent } from '@ams/core';
import {
  CreateReportSchema, DeleteResultSchema, ReportDetailDocSchema, ReportDetailSchema, ReportFilterSchema, ReportSummarySchema, SetSectionOwnerSchema,
  UpdateReportSchema, UpdateSectionContentSchema, toDto,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

const sectionParam = z.object({ id: z.uuid(), sectionId: z.uuid() });
// Validated with the real (recursive) schema; declared with the doc-friendly one (see ReportDetailDocSchema).
const detail = (v: unknown) => toDto(ReportDetailSchema, v);

export function reportRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['reports'];
  const read = requires('report:read');
  const write = requires('report:write');
  const manage = requires('report:manage');
  const reportOk = (description: string) => ({ 200: { description, ...json(ReportDetailDocSchema) }, ...errors });
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/reports', access: read, tags: tag,
      description: 'Reports, newest first. Filter by engagement, subject, framework edition, status, or a title search.',
      request: { query: ReportFilterSchema },
      responses: { 200: { description: 'Reports with their section counts', ...json(z.array(ReportSummarySchema)) }, ...errors },
    }), async (c) => c.json(await listReports(c.get('ctx'), c.req.valid('query')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/reports', access: manage, tags: tag,
      description: 'Creates a report from a reviewed template: for an engagement, or about a subject (institution, unit, program). The template\'s sections, requirement links and word limits are copied; owners come from the requirements or the champions, flagged when nobody resolves.',
      request: { body: { required: true, ...json(CreateReportSchema) } },
      responses: { 201: { description: 'Created', ...json(ReportDetailDocSchema) }, ...errors },
    }), async (c) => c.json(detail(await createReport(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/reports/{id}', access: read, tags: tag,
      request: { params: idParam },
      responses: reportOk('The report: summary and the section tree'),
    }), async (c) => c.json(detail(await getReport(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/reports/{id}', access: manage, tags: tag,
      description: 'Renames a report. What it was made from never changes.',
      request: { params: idParam, body: { required: true, ...json(UpdateReportSchema) } },
      responses: reportOk('The report'),
    }), async (c) => {
      const { id } = c.req.valid('param');
      return c.json(detail(await updateReport(c.get('ctx'), id, c.req.valid('json'))), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/reports/{id}', access: manage, tags: tag,
      description: 'Deletes a draft report to the Trash with its sections and requirement links. A report that is internally approved or submitted is not deleted.',
      request: { params: idParam },
      responses: { 200: { description: 'Deleted', ...json(DeleteResultSchema) }, ...errors },
    }), async (c) => c.json(await deleteReport(c.get('ctx'), { id: c.req.valid('param').id }), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/reports/{id}/sections/{sectionId}/content', access: write, tags: tag,
      description: 'Saves the content of one section under its block type (narrative, data_table, attestation, appendix). Only while the report is a draft; the word count of a narrative is recomputed.',
      request: { params: sectionParam, body: { required: true, ...json(UpdateSectionContentSchema) } },
      responses: reportOk('The report with the section\'s new content'),
    }), async (c) => {
      const { sectionId } = c.req.valid('param');
      return c.json(detail(await updateSectionContent(c.get('ctx'), sectionId, c.req.valid('json'))), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/reports/{id}/sections/{sectionId}/owner', access: manage, tags: tag,
      description: 'Hands a section to a person of the institution, or takes the owner off (null).',
      request: { params: sectionParam, body: { required: true, ...json(SetSectionOwnerSchema) } },
      responses: reportOk('The report'),
    }), async (c) => {
      const { sectionId } = c.req.valid('param');
      return c.json(detail(await setSectionOwner(c.get('ctx'), sectionId, c.req.valid('json'))), 200);
    });
}
