import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  addResponsesToData, formByLink, formToAnswer, getDataForm, listDataResponses, newDataFormLink, removeDataFormLink, setDataFormOpen,
  submitByFormLink, submitDataResponse,
} from '@ams/core';
import { DataFormSchema, DataResponseSchema, EvidenceVersionSchema, PublicFormSchema, SetFormOpenSchema, SubmitResponseSchema, toDto } from '@ams/shared';
import { formLink, requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

const tokenParam = z.object({ token: z.string().min(1) });

/** Forms on data items (DEC-020): the form's state and link, answering signed in or by link, and the responses. */
export function formRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['forms'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/evidence/{id}/form', access: requires('evidence:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Whether the form takes responses, its link (for editors) and response counts', ...json(DataFormSchema) }, ...errors },
    }), async (c) => c.json(toDto(DataFormSchema, await getDataForm(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/evidence/{id}/form/open', access: requires('evidence:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(SetFormOpenSchema) } },
      responses: { 200: { description: 'Opened or closed', ...json(DataFormSchema) }, ...errors },
    }), async (c) => c.json(toDto(DataFormSchema, await setDataFormOpen(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').open)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence/{id}/form/link', access: requires('evidence:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'A new public link; the previous one stops working', ...json(DataFormSchema) }, ...errors },
    }), async (c) => c.json(toDto(DataFormSchema, await newDataFormLink(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/evidence/{id}/form/link', access: requires('evidence:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The public link is turned off', ...json(DataFormSchema) }, ...errors },
    }), async (c) => c.json(toDto(DataFormSchema, await removeDataFormLink(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/evidence/{id}/form/questions', access: requires('evidence:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The form to answer (open forms only)', ...json(PublicFormSchema) }, ...errors },
    }), async (c) => c.json(toDto(PublicFormSchema, await formToAnswer(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence/{id}/form/responses', access: requires('evidence:read'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(SubmitResponseSchema) } },
      responses: { 204: { description: 'Received' }, ...errors },
    }), async (c) => { await submitDataResponse(c.get('ctx'), c.req.valid('param').id, c.req.valid('json')); return c.body(null, 204); })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/evidence/{id}/responses', access: requires('evidence:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Every response, newest first', ...json(z.array(DataResponseSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(DataResponseSchema), await listDataResponses(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence/{id}/responses/add-to-data', access: requires('evidence:write'), tags: tag,
      request: { params: idParam },
      responses: { 201: { description: 'The waiting responses, added to the data as the next version', ...json(EvidenceVersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(EvidenceVersionSchema, await addResponsesToData(c.get('ctx'), c.req.valid('param').id)), 201))

    // ---- Public form link (DEC-020): no account; the link answers one open form -------------------------------------
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/form-links/{token}', access: formLink(), tags: tag,
      request: { params: tokenParam },
      responses: { 200: { description: 'The form this link answers', ...json(PublicFormSchema) }, ...errors },
    }), async (c) => c.json(toDto(PublicFormSchema, await formByLink(c.get('ctx'), c.get('linkTargetId'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/form-links/{token}/responses', access: formLink(), tags: tag,
      request: { params: tokenParam, body: { required: true, ...json(SubmitResponseSchema) } },
      responses: { 204: { description: 'Received' }, ...errors },
    }), async (c) => { await submitByFormLink(c.get('ctx'), c.get('linkTargetId'), c.req.valid('json')); return c.body(null, 204); });
}
