import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
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
      method: 'get', path: '/api/source-documents/{id}/pages/{pageNo}', access: requires('framework:read'), tags: tag,
      request: { params: z.object({ id: z.uuid(), pageNo: z.coerce.number().int().min(1) }) },
      responses: { 200: { description: 'A source page', ...json(SourcePageSchema) }, ...errors },
    }), async (c) => {
      const { id, pageNo } = c.req.valid('param');
      const page = await getSourcePage(c.get('ctx'), id, pageNo);
      return page ? c.json(toDto(SourcePageSchema, page), 200) : c.json({ error: 'not_found' }, 404);
    });
}
