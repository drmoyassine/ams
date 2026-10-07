import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  answerByLink, answerEvidenceRequest, cancelEvidenceRequest, createEvidenceRequest, listEvidenceRequests, MAX_UPLOAD_BYTES, renewRequestLink,
  requestByLink, requestsForInternal, ValidationError, type UploadedFile,
} from '@ams/core';
import { CreateEvidenceRequestSchema, EvidenceRequestSchema, IssuedRequestSchema, RequestByLinkSchema, toDto } from '@ams/shared';
import { requires, responseLink, secured, type AppContext, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

const tokenParam = z.object({ token: z.string().min(1) });
const fileQuery = z.object({ fileName: z.string().min(1), note: z.string().optional() });

/** The request body is the file itself; its Content-Type is recorded. */
async function readUpload(c: AppContext, fileName: string): Promise<UploadedFile> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw new ValidationError(`the file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB`);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const mime = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
  return { fileName, mime, bytes };
}

export function requestRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['evidence requests'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/requirements/{id}/evidence-requests', access: requires('evidence:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Requests for evidence on an item of the internal framework', ...json(z.array(EvidenceRequestSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(EvidenceRequestSchema), await requestsForInternal(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/requirements/{id}/evidence-requests', access: requires('evidence:write'), tags: tag,
      description: 'When the address has no AMS account, a one-time link is issued; its secret is returned here once.',
      request: { params: idParam, body: { required: true, ...json(CreateEvidenceRequestSchema) } },
      responses: { 201: { description: 'Requested', ...json(IssuedRequestSchema) }, ...errors },
    }), async (c) => c.json(toDto(IssuedRequestSchema, await createEvidenceRequest(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/evidence-requests', access: requires('evidence:read'), tags: tag,
      request: { query: z.object({ mine: z.enum(['true', 'false']).optional() }) },
      responses: { 200: { description: 'Requests asked of the caller (mine=true) or all requests', ...json(z.array(EvidenceRequestSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(EvidenceRequestSchema), await listEvidenceRequests(c.get('ctx'), { mine: c.req.valid('query').mine === 'true' })), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence-requests/{id}/cancel', access: requires('evidence:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Cancelled; its link stops working', ...json(EvidenceRequestSchema) }, ...errors },
    }), async (c) => c.json(toDto(EvidenceRequestSchema, await cancelEvidenceRequest(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence-requests/{id}/new-link', access: requires('evidence:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'A new one-time link; the previous one stops working', ...json(IssuedRequestSchema) }, ...errors },
    }), async (c) => c.json(toDto(IssuedRequestSchema, await renewRequestLink(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence-requests/{id}/answer', access: requires('evidence:read'), tags: tag,
      description: 'The body is the file. The person asked may answer; so may anyone with evidence:write (checked in the service).',
      request: { params: idParam, query: fileQuery },
      responses: { 200: { description: 'Answered: the file is evidence, proposed on the item', ...json(EvidenceRequestSchema) }, ...errors },
    }), async (c) => {
      const { fileName, note } = c.req.valid('query');
      return c.json(toDto(EvidenceRequestSchema, await answerEvidenceRequest(c.get('ctx'), c.req.valid('param').id, await readUpload(c, fileName), note)), 200);
    })

    // ---- One-time links (DEC-018): no account; the link opens one request ----------------------------------------
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/response-links/{token}', access: responseLink(), tags: tag,
      request: { params: tokenParam },
      responses: { 200: { description: 'The request this link opens', ...json(RequestByLinkSchema) }, ...errors },
    }), async (c) => c.json(toDto(RequestByLinkSchema, await requestByLink(c.get('ctx'), c.get('linkTargetId'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/response-links/{token}/answer', access: responseLink(), tags: tag,
      description: 'The body is the file. The link stops working once it is used.',
      request: { params: tokenParam, query: fileQuery },
      responses: { 204: { description: 'Received' }, ...errors },
    }), async (c) => {
      const { fileName, note } = c.req.valid('query');
      await answerByLink(c.get('ctx'), c.get('linkTargetId'), await readUpload(c, fileName), note);
      return c.body(null, 204);
    });
}
