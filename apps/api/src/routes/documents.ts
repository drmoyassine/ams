// Documents and AI import (TASK-075, docs/ai-import.md). Every route passes the five-step chain. The chain's check is the coarse one
// (a signed-in person who can read the organisation); the services then apply the PLACE's own permission (the scope registry: a
// Programs Docs tab needs program permissions, a standards version framework permissions), so one set of routes serves every Docs tab.
// The model is called by the worker's `import` jobs, never here (DEC-012).
import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  applyImport, cancelImport, decideImportProposals, deleteDocument, editImportProposal, getDocument, getDocumentPageView, getImportReport, getImportRun, getScopeInfo,
  importPreflight, listAllDocuments, listDocumentPages, listDocuments, listImportProposals, listImportRuns, listImportTargets, MAX_SOURCE_BYTES, previewImportApply,
  readDocumentFile, redoImportApply, requestRead, startImport, undoImportApply, uploadDocument, ValidationError,
} from '@ams/core';
import {
  DecideProposalsSchema, DeleteResultSchema, DocScopeInfoSchema, DocumentFiltersSchema, DocumentListSchema, DocumentRowSchema, DOC_SCOPE_KINDS, EditProposalSchema, ImportApplyPreviewSchema,
  ImportApplyResultSchema, ImportPageSchema, ImportProposalListSchema, ImportProposalSchema, ImportReportSchema, ImportRunSchema, ImportTargetInfoSchema, PreflightSchema,
  SourcePageViewSchema, StartImportSchema, toDto,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

const scopeQuery = z.object({ scopeKind: z.enum(DOC_SCOPE_KINDS), scopeId: z.uuid().optional() });
const preflightQuery = scopeQuery.extend({ targetKind: z.string().min(1) });
const uploadQuery = scopeQuery.extend({ fileName: z.string().min(1), language: z.string().min(2).max(12).optional() });
const pageParam = z.object({ id: z.uuid(), pageNo: z.coerce.number().int().min(1) });

export function documentRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['documents'];
  const importTag = ['ai import'];
  const read = requires('org:read');
  return new OpenAPIHono<AppEnv>(options)
    // ---- Documents ----------------------------------------------------------------------------------------------------------
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/documents', access: read, tags: tag,
      description: 'The documents of one place (a standards version, Programs, the org chart...) in one row shape, with who uploaded them and when. Needs that place\'s read permission.',
      request: { query: scopeQuery },
      responses: { 200: { description: 'Documents', ...json(z.array(DocumentRowSchema)) }, ...errors },
    }), async (c) => { const q = c.req.valid('query'); return c.json(toDto(z.array(DocumentRowSchema), await listDocuments(c.get('ctx'), q.scopeKind, q.scopeId ?? null)), 200); })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/document-library', access: read, tags: tag,
      description: 'Settings -> Documents: every document the person may see across the institution (uploads and standards sources, never evidence), with filters.',
      request: { query: DocumentFiltersSchema },
      responses: { 200: { description: 'Documents with where each is used', ...json(DocumentListSchema) }, ...errors },
    }), async (c) => c.json(toDto(DocumentListSchema, await listAllDocuments(c.get('ctx'), c.req.valid('query'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/document-scopes', access: read, tags: tag,
      description: 'What the person may do in one place: read, write, and whether it can still change.',
      request: { query: scopeQuery },
      responses: { 200: { description: 'The place', ...json(DocScopeInfoSchema) }, ...errors },
    }), async (c) => { const q = c.req.valid('query'); return c.json(toDto(DocScopeInfoSchema, await getScopeInfo(c.get('ctx'), q.scopeKind, q.scopeId ?? null)), 200); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/documents/upload', access: read, tags: tag,
      description: 'The request body is the file itself; its Content-Type is recorded. Needs the place\'s write permission. The file is stored and queued for reading; the same file twice in one place is refused.',
      request: { query: uploadQuery },
      responses: { 201: { description: 'Stored', ...json(DocumentRowSchema) }, ...errors },
    }), async (c) => {
      if (Number(c.req.header('content-length') ?? 0) > MAX_SOURCE_BYTES) throw new ValidationError(`the file is larger than ${Math.round(MAX_SOURCE_BYTES / 1048576)} MB`);
      const q = c.req.valid('query');
      const mime = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
      const row = await uploadDocument(c.get('ctx'), {
        scopeKind: q.scopeKind, scopeId: q.scopeId ?? null, fileName: q.fileName, mime, bytes: new Uint8Array(await c.req.arrayBuffer()), ...(q.language ? { language: q.language } : {}),
      });
      return c.json(toDto(DocumentRowSchema, row), 201);
    })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/documents/{id}', access: read, tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'One document', ...json(DocumentRowSchema) }, ...errors },
    }), async (c) => c.json(toDto(DocumentRowSchema, await getDocument(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/documents/{id}', access: read, tags: tag,
      description: 'Deletes a document. It goes to the Trash for 30 days with its pages (its file stays in storage until then); the X-Undo header puts it back.',
      request: { params: idParam },
      responses: { 200: { description: 'Deleted', ...json(DeleteResultSchema) }, ...errors },
    }), async (c) => c.json(await deleteDocument(c.get('ctx'), c.req.valid('param').id), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/documents/{id}/file', access: read, tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The original file', content: { 'application/octet-stream': { schema: z.string() } } }, ...errors },
    }), async (c) => {
      const f = await readDocumentFile(c.get('ctx'), c.req.valid('param').id);
      const inline = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(f.mime);
      return c.body(f.bytes as unknown as ArrayBuffer, 200, {
        'content-type': f.mime, 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.fileName)}`, 'x-content-type-options': 'nosniff',
      }) as never;
    })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/documents/{id}/read', access: read, tags: tag,
      description: 'Queues reading the file again into page text (the parser service). Needs the place\'s write permission.',
      request: { params: idParam },
      responses: { 202: { description: 'Queued', ...json(z.object({ jobId: z.string(), status: z.string() })) }, ...errors },
    }), async (c) => c.json(await requestRead(c.get('ctx'), c.req.valid('param').id), 202))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/documents/{id}/pages', access: read, tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Every stored page, in order', ...json(z.array(ImportPageSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(ImportPageSchema), await listDocumentPages(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/documents/{id}/pages/{pageNo}/view', access: read, tags: tag,
      description: 'One page for the review\'s source viewer, with the quote located by the same matcher that verifies quotes.',
      request: { params: pageParam, query: z.object({ quote: z.string().max(4000).optional() }) },
      responses: { 200: { description: 'The page and the highlight', ...json(SourcePageViewSchema) }, ...errors },
    }), async (c) => { const { id, pageNo } = c.req.valid('param'); return c.json(toDto(SourcePageViewSchema, await getDocumentPageView(c.get('ctx'), id, pageNo, c.req.valid('query').quote)), 200); })

    // ---- Imports ------------------------------------------------------------------------------------------------------------
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/imports/targets', access: read, tags: importTag,
      description: 'The imports a place offers (the Import buttons of its Docs tab).',
      request: { query: scopeQuery },
      responses: { 200: { description: 'Targets', ...json(z.array(ImportTargetInfoSchema)) }, ...errors },
    }), async (c) => { const q = c.req.valid('query'); return c.json(await listImportTargets(c.get('ctx'), q.scopeKind, q.scopeId ?? null), 200); })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/imports/preflight', access: read, tags: importTag,
      description: 'Can an import start now? A checklist (place can change, documents, AI on, model and key, reading, spend limit) with where to fix each problem. Never shows a key.',
      request: { query: preflightQuery },
      responses: { 200: { description: 'The checks and the first blocking reason', ...json(PreflightSchema) }, ...errors },
    }), async (c) => { const q = c.req.valid('query'); return c.json(toDto(PreflightSchema, await importPreflight(c.get('ctx'), q.scopeKind, q.scopeId ?? null, q.targetKind)), 200); })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/imports', access: read, tags: importTag,
      description: 'A place\'s import history, newest first.',
      request: { query: scopeQuery },
      responses: { 200: { description: 'Runs', ...json(z.array(ImportRunSchema)) }, ...errors },
    }), async (c) => { const q = c.req.valid('query'); return c.json(toDto(z.array(ImportRunSchema), await listImportRuns(c.get('ctx'), q.scopeKind, q.scopeId ?? null)), 200); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/imports', access: read, tags: importTag,
      description: 'Starts reading documents into a target. Refused unless the place can change, AI is on and set up, the documents are in the place and no run of the same target is active there. Needs the place\'s write permission.',
      request: { body: { required: true, ...json(StartImportSchema) } },
      responses: { 202: { description: 'Queued', ...json(ImportRunSchema) }, ...errors },
    }), async (c) => c.json(toDto(ImportRunSchema, await startImport(c.get('ctx'), c.req.valid('json'))), 202))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/imports/{id}', access: read, tags: importTag,
      request: { params: idParam },
      responses: { 200: { description: 'One run: status, stage, progress, usage and counts', ...json(ImportRunSchema) }, ...errors },
    }), async (c) => c.json(toDto(ImportRunSchema, await getImportRun(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/imports/{id}/cancel', access: read, tags: importTag,
      description: 'Stops a queued or running import after its current step. What it found so far is kept as proposals.',
      request: { params: idParam },
      responses: { 200: { description: 'Cancelled', ...json(ImportRunSchema) }, ...errors },
    }), async (c) => c.json(toDto(ImportRunSchema, await cancelImport(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/imports/{id}/report', access: read, tags: importTag,
      description: 'What was read, found and checked, with the reasons a row deserves a look. Counts only: no score or verdict.',
      request: { params: idParam },
      responses: { 200: { description: 'The report', ...json(ImportReportSchema) }, ...errors },
    }), async (c) => c.json(toDto(ImportReportSchema, await getImportReport(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/imports/{id}/proposals', access: read, tags: importTag,
      request: { params: idParam },
      responses: { 200: { description: 'The run and its proposals in reading order', ...json(ImportProposalListSchema) }, ...errors },
    }), async (c) => c.json(toDto(ImportProposalListSchema, await listImportProposals(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/imports/{id}/proposals/decide', access: read, tags: importTag,
      description: 'Accept, skip or reset one or many proposals.',
      request: { params: idParam, body: { required: true, ...json(DecideProposalsSchema) } },
      responses: { 200: { description: 'How many changed', ...json(z.object({ changed: z.number() })) }, ...errors },
    }), async (c) => c.json(await decideImportProposals(c.get('ctx'), c.req.valid('param').id, c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/imports/{id}/apply-preview', access: read, tags: importTag,
      description: 'What Apply would write, in the words the confirm dialog uses. Nothing is changed.',
      request: { params: idParam },
      responses: { 200: { description: 'The question and the count', ...json(ImportApplyPreviewSchema) }, ...errors },
    }), async (c) => c.json(await previewImportApply(c.get('ctx'), c.req.valid('param').id), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/imports/{id}/apply', access: read, tags: importTag,
      description: 'Writes the accepted proposals as the person, in one transaction: all or nothing, refused when the place cannot change. The X-Undo header takes the whole apply back.',
      request: { params: idParam },
      responses: { 200: { description: 'What was written and what was left alone', ...json(ImportApplyResultSchema) }, ...errors },
    }), async (c) => c.json(toDto(ImportApplyResultSchema, await applyImport(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/import-proposals/{id}', access: read, tags: importTag,
      description: 'Changes the values of one proposal. They must fit what the target can fill; the AI\'s original stays beside them. Counts as accepted.',
      request: { params: idParam, body: { required: true, ...json(EditProposalSchema) } },
      responses: { 200: { description: 'The proposal', ...json(ImportProposalSchema) }, ...errors },
    }), async (c) => c.json(toDto(ImportProposalSchema, await editImportProposal(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').payload)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/import-applies/{id}/undo', access: read, tags: importTag,
      description: 'Takes a whole apply back in one transaction.',
      request: { params: idParam },
      responses: { 200: { description: 'Undone', ...json(ImportApplyResultSchema) }, ...errors },
    }), async (c) => c.json(toDto(ImportApplyResultSchema, await undoImportApply(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/import-applies/{id}/redo', access: read, tags: importTag,
      description: 'Does an undone apply again; refused when the same items were applied again meanwhile.',
      request: { params: idParam },
      responses: { 200: { description: 'Done again', ...json(ImportApplyResultSchema) }, ...errors },
    }), async (c) => c.json(toDto(ImportApplyResultSchema, await redoImportApply(c.get('ctx'), c.req.valid('param').id)), 200));
}
