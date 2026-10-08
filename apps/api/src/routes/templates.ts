import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  deleteSourceDocument, deleteSourcePage, listSourcePages, MAX_SOURCE_BYTES, readSourceFile, setSourcePage, updateSourceDocument, UpdateSourceDocumentSchema,
  uploadSourceFile, ValidationError,
  AddSourceDocumentSchema, addSourceDocument, addSourcePage, deleteReportTemplate, getSourcePage, listReportTemplates, listSourceDocuments,
  reviewReportTemplate, upsertReportTemplate,
} from '@ams/core';
import { SourceDocumentSchema, SourcePageSchema, TemplateSchema, TEMPLATE_KINDS, toDto } from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

// The structure is a recursive schema the OpenAPI generator cannot expand, so the route accepts it as opaque JSON; the
// service validates it against ReportTemplateStructureSchema and answers 400 with the exact paths.
const TemplateBody = z.object({
  name: z.string().min(1),
  kind: z.enum(TEMPLATE_KINDS),
  language: z.string().min(2).optional(),
  structure: z.unknown(),
  word_limit: z.number().int().positive().nullable().optional(),
  requires_attestation: z.boolean().optional(),
});
const keyParam = z.object({ id: z.uuid(), key: z.string().min(1) });

export function templateRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['templates and sources'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/framework-versions/{id}/report-templates', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Report templates', ...json(z.array(TemplateSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(TemplateSchema), await listReportTemplates(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/framework-versions/{id}/report-templates/{key}', access: requires('framework:write'), tags: tag,
      request: { params: keyParam, body: { required: true, ...json(TemplateBody) } },
      responses: { 200: { description: 'Created or replaced; returned to review', ...json(TemplateSchema) }, ...errors },
    }), async (c) => {
      const { id, key } = c.req.valid('param');
      return c.json(toDto(TemplateSchema, await upsertReportTemplate(c.get('ctx'), id, { ...c.req.valid('json'), key } as never)), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/framework-versions/{id}/report-templates/{key}', access: requires('framework:write'), tags: tag,
      request: { params: keyParam }, responses: { 204: { description: 'Deleted' }, ...errors },
    }), async (c) => { const { id, key } = c.req.valid('param'); await deleteReportTemplate(c.get('ctx'), id, key); return c.body(null, 204); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/{id}/report-templates/{key}/review', access: requires('framework:review'), tags: tag,
      request: { params: keyParam, body: { required: true, ...json(z.object({ decision: z.enum(['approved', 'rejected']) })) } },
      responses: { 200: { description: 'Reviewed', ...json(TemplateSchema) }, ...errors },
    }), async (c) => {
      const { id, key } = c.req.valid('param');
      return c.json(toDto(TemplateSchema, await reviewReportTemplate(c.get('ctx'), id, key, c.req.valid('json').decision)), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/framework-versions/{id}/source-documents', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Source documents', ...json(z.array(SourceDocumentSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(SourceDocumentSchema), await listSourceDocuments(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/{id}/source-documents', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(AddSourceDocumentSchema.omit({ versionId: true })) } },
      responses: { 201: { description: 'Registered', ...json(SourceDocumentSchema) }, ...errors },
    }), async (c) => c.json(toDto(SourceDocumentSchema, await addSourceDocument(c.get('ctx'), { ...c.req.valid('json'), versionId: c.req.valid('param').id })), 201))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/source-documents/{id}/pages', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(z.object({ pageNo: z.number().int().min(1), text: z.string().min(1), method: z.enum(['pdf_text', 'ocr']) })) } },
      responses: { 201: { description: 'Stored', ...json(SourcePageSchema) }, ...errors },
    }), async (c) => c.json(toDto(SourcePageSchema, await addSourcePage(c.get('ctx'), { ...c.req.valid('json'), documentId: c.req.valid('param').id })), 201))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/source-documents/{id}', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateSourceDocumentSchema) } },
      responses: { 200: { description: 'Updated', ...json(SourceDocumentSchema) }, ...errors },
    }), async (c) => c.json(toDto(SourceDocumentSchema, await updateSourceDocument(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/source-documents/{id}', access: requires('framework:write'), tags: tag,
      request: { params: idParam },
      responses: { 204: { description: 'Removed with its pages' }, ...errors },
    }), async (c) => { await deleteSourceDocument(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); })

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/source-documents/{id}/file', access: requires('framework:write'), tags: tag,
      description: 'The request body is the file itself; its Content-Type is recorded.',
      request: { params: idParam, query: z.object({ fileName: z.string().min(1) }) },
      responses: { 200: { description: 'Stored', ...json(SourceDocumentSchema) }, ...errors },
    }), async (c) => {
      if (Number(c.req.header('content-length') ?? 0) > MAX_SOURCE_BYTES) throw new ValidationError(`the file is larger than ${Math.round(MAX_SOURCE_BYTES / 1048576)} MB`);
      const mime = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
      const row = await uploadSourceFile(c.get('ctx'), c.req.valid('param').id, { fileName: c.req.valid('query').fileName, mime, bytes: new Uint8Array(await c.req.arrayBuffer()) });
      return c.json(toDto(SourceDocumentSchema, row), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/source-documents/{id}/file', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The original file', content: { 'application/octet-stream': { schema: z.string() } } }, ...errors },
    }), async (c) => {
      const f = await readSourceFile(c.get('ctx'), c.req.valid('param').id);
      const inline = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(f.mime);
      return c.body(f.bytes as unknown as ArrayBuffer, 200, {
        'content-type': f.mime, 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.fileName)}`, 'x-content-type-options': 'nosniff',
      }) as never;
    })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/source-documents/{id}/pages', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Every stored page, in order', ...json(z.array(SourcePageSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(SourcePageSchema), await listSourcePages(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/source-documents/{id}/pages/{pageNo}', access: requires('framework:write'), tags: tag,
      request: { params: z.object({ id: z.uuid(), pageNo: z.coerce.number().int().min(1) }), body: { required: true, ...json(z.object({ text: z.string().min(1) })) } },
      responses: { 200: { description: 'The page as stored', ...json(SourcePageSchema) }, ...errors },
    }), async (c) => {
      const { id, pageNo } = c.req.valid('param');
      return c.json(toDto(SourcePageSchema, await setSourcePage(c.get('ctx'), id, pageNo, c.req.valid('json').text)), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/source-documents/{id}/pages/{pageNo}', access: requires('framework:write'), tags: tag,
      request: { params: z.object({ id: z.uuid(), pageNo: z.coerce.number().int().min(1) }) },
      responses: { 204: { description: 'Removed' }, ...errors },
    }), async (c) => { const { id, pageNo } = c.req.valid('param'); await deleteSourcePage(c.get('ctx'), id, pageNo); return c.body(null, 204); })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/source-documents/{id}/pages/{pageNo}', access: requires('framework:read'), tags: tag,
      request: { params: z.object({ id: z.uuid(), pageNo: z.coerce.number().int().min(1) }) },
      responses: { 200: { description: 'A source page', ...json(SourcePageSchema) }, ...errors },
    }), async (c) => {
      const { id, pageNo } = c.req.valid('param');
      const page = await getSourcePage(c.get('ctx'), id, pageNo);
      return page ? c.json(toDto(SourcePageSchema, page), 200) : c.json({ error: 'not_found' }, 404);
    });
}
