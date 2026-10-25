// Reports (TASK-091/092/094, PRD 10): create one from a reviewed template, read it back as a section tree, rename it,
// save a section's content, upload an attestation's signed letter, hand a section to a person, delete a draft to the
// Trash. Reads need report:read; managing (create, rename, owners, delete, snapshot, mark submitted) needs report:manage
// at the route and again at the report's wrapper in the service; saving content and review moves need report:write /
// report:review (the services check them at the wrapper). The submission snapshot is immutable (PRD 6.9).
import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  approveReport, createReport, createSnapshot, deleteReport, decideSection, getReport, getSnapshot, listReports,
  markSubmitted, MAX_UPLOAD_BYTES, readAttestationLetter, saveAttestationLetter, setSectionOwner, submitSectionForReview,
  updateReport, updateSectionContent, ValidationError,
} from '@ams/core';
import {
  CreateReportSchema, DecideSectionSchema, DeleteResultSchema, MarkSubmittedSchema, ReportDetailDocSchema, ReportDetailSchema,
  ReportFilterSchema, ReportSummarySchema, SetSectionOwnerSchema, SubmissionSnapshotSchema,
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
  const review = requires('report:review');
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
      method: 'post', path: '/api/reports/{id}/sections/{sectionId}/attestation', access: write, tags: tag,
      description: 'The request body is the signed letter itself; its Content-Type is recorded. Stored under the report and set on the section whole (key, name, mime, size), keeping the signatory and statement. Only while the report is a draft.',
      request: { params: sectionParam, query: z.object({ fileName: z.string().min(1) }) },
      responses: { 201: { description: 'The letter stored', ...json(ReportDetailDocSchema) }, ...errors },
    }), async (c) => {
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > MAX_UPLOAD_BYTES) throw new ValidationError(`the file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB`);
      const { sectionId } = c.req.valid('param');
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const mime = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
      return c.json(detail(await saveAttestationLetter(c.get('ctx'), sectionId, {
        fileName: c.req.valid('query').fileName, mime, bytes,
      })), 201);
    })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/reports/{id}/sections/{sectionId}/letter', access: read, tags: tag,
      description: 'The stored signed letter of an attestation section.',
      request: { params: sectionParam },
      responses: { 200: { description: 'The stored file', content: { 'application/octet-stream': { schema: z.string() } } }, ...errors },
    }), async (c) => {
      const f = await readAttestationLetter(c.get('ctx'), c.req.valid('param').sectionId);
      const disposition = `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`;
      return c.body(f.bytes as unknown as ArrayBuffer, 200, { 'content-type': f.mime, 'content-disposition': disposition, 'x-content-type-options': 'nosniff' }) as never;
    })

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/reports/{id}/sections/{sectionId}/owner', access: manage, tags: tag,
      description: 'Hands a section to a person of the institution, or takes the owner off (null).',
      request: { params: sectionParam, body: { required: true, ...json(SetSectionOwnerSchema) } },
      responses: reportOk('The report'),
    }), async (c) => {
      const { sectionId } = c.req.valid('param');
      return c.json(detail(await setSectionOwner(c.get('ctx'), sectionId, c.req.valid('json'))), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/reports/{id}/sections/{sectionId}/review', access: write, tags: tag,
      description: 'The writer hands a draft or returned section to the reviewers. Only while the report is a draft.',
      request: { params: sectionParam },
      responses: reportOk('The report with the section in review'),
    }), async (c) => {
      const { sectionId } = c.req.valid('param');
      return c.json(detail(await submitSectionForReview(c.get('ctx'), sectionId)), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/reports/{id}/sections/{sectionId}/decision', access: review, tags: tag,
      description: 'A reviewer approves a section in review, or returns it with a note (what to fix). Reopening an approved section of an internally approved report is a return too: the report goes back to draft and the review starts over. Every decision is kept.',
      request: { params: sectionParam, body: { required: true, ...json(DecideSectionSchema) } },
      responses: reportOk('The report with the section\'s new state'),
    }), async (c) => {
      const { sectionId } = c.req.valid('param');
      return c.json(detail(await decideSection(c.get('ctx'), sectionId, c.req.valid('json'))), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/reports/{id}/approve', access: review, tags: tag,
      description: 'Internally approves the report. The database checks that every section is approved and the attestation is there, and stamps who approved and when. The wording is exactly "Internally approved" (DEC-005).',
      request: { params: idParam },
      responses: reportOk('The internally approved report'),
    }), async (c) => c.json(detail(await approveReport(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/reports/{id}/snapshot', access: manage, tags: tag,
      description: 'Freezes the immutable submission snapshot: the whole report in one manifest (sections, requirements, approvals, attestation, cited evidence with hashes) and the word changes against the previous round\'s snapshot. One per report; never changed or removed (PRD 6.9). Only an internally approved report.',
      request: { params: idParam },
      responses: { 201: { description: 'The snapshot taken', ...json(SubmissionSnapshotSchema) }, ...errors },
    }), async (c) => c.json(await createSnapshot(c.get('ctx'), c.req.valid('param').id), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/reports/{id}/snapshot', access: read, tags: tag,
      description: 'The report\'s submission snapshot; there is none until a manager froze one.',
      request: { params: idParam },
      responses: { 200: { description: 'The snapshot', ...json(SubmissionSnapshotSchema) }, ...errors },
    }), async (c) => c.json(await getSnapshot(c.get('ctx'), c.req.valid('param').id), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/reports/{id}/submit', access: manage, tags: tag,
      description: 'Marks the report submitted. The snapshot must be taken first; the database stamps who submitted and when, and the engagement\'s submission milestone is completed. The accreditor\'s own reference may be sent now or never.',
      request: { params: idParam, body: { required: true, ...json(MarkSubmittedSchema) } },
      responses: reportOk('The submitted report'),
    }), async (c) => {
      const { id } = c.req.valid('param');
      return c.json(detail(await markSubmitted(c.get('ctx'), id, c.req.valid('json'))), 200);
    });
}
