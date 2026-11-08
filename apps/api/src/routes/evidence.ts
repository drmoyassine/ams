import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  addFileVersion, addUrlVersion, createEvidence, evidenceItemsForInternal, getEvidence, linksForEngagementRequirement, linksForInternal, linkToEngagementRequirement,
  dismissNotification, linkToRequirement, listEvidence, listMyNotifications, markNotificationRead, MAX_UPLOAD_BYTES, readVersionFile, removeLink, requirementContexts, resubmitLink, reviewLink, suggestionsFor, updateEvidence, ValidationError,
} from '@ams/core';
import {
  CreateEvidenceSchema, EvidenceDetailSchema, EvidenceItemSchema, EvidenceLinkSchema, EvidenceSuggestionSchema, EvidenceVersionSchema,
  LinkEvidenceSchema, NotificationSchema, RequirementContextsSchema, ResubmitLinkSchema, ReviewLinkSchema, UpdateEvidenceSchema, toDto,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

/** Shown in the browser rather than downloaded. */
const INLINE = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/;

export function evidenceRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['evidence'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/evidence', access: requires('evidence:read'), tags: tag,
      request: { query: z.object({ q: z.string().optional(), includeArchived: z.enum(['true', 'false']).optional() }) },
      responses: { 200: { description: 'The evidence the caller may see, newest first; archived items only when asked for', ...json(z.array(EvidenceItemSchema)) }, ...errors },
    }), async (c) => {
      const { q, includeArchived } = c.req.valid('query');
      return c.json(toDto(z.array(EvidenceItemSchema), await listEvidence(c.get('ctx'), { ...(q ? { q } : {}), includeArchived: includeArchived === 'true' })), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence/for-items', access: requires('evidence:read'), tags: tag,
      description: 'The evidence items linked to these items of the internal framework, by code on the framework.',
      request: { body: { required: true, ...json(z.object({ versionId: z.string().uuid(), requirementIds: z.array(z.string().uuid()).max(2000) })) } },
      responses: { 200: { description: 'Distinct evidence item ids', ...json(z.object({ ids: z.array(z.string().uuid()) })) }, ...errors },
    }), async (c) => {
      const { versionId, requirementIds } = c.req.valid('json');
      return c.json({ ids: await evidenceItemsForInternal(c.get('ctx'), versionId, requirementIds) }, 200);
    })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence', access: requires('evidence:write'), tags: tag,
      request: { body: { required: true, ...json(CreateEvidenceSchema) } },
      responses: { 201: { description: 'Created', ...json(EvidenceItemSchema) }, ...errors },
    }), async (c) => c.json(toDto(EvidenceItemSchema, await createEvidence(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/evidence/{id}', access: requires('evidence:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The item, its versions and everything it is linked to', ...json(EvidenceDetailSchema) }, ...errors },
    }), async (c) => c.json(toDto(EvidenceDetailSchema, await getEvidence(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/evidence/{id}', access: requires('evidence:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateEvidenceSchema) } },
      responses: { 200: { description: 'Updated', ...json(EvidenceItemSchema) }, ...errors },
    }), async (c) => c.json(toDto(EvidenceItemSchema, await updateEvidence(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence/{id}/files', access: requires('evidence:write'), tags: tag,
      description: 'The request body is the file itself; its Content-Type is recorded. Stored as the next version.',
      request: { params: idParam, query: z.object({ fileName: z.string().min(1), asOfDate: z.string().optional(), notes: z.string().optional() }) },
      responses: { 201: { description: 'Stored as a new version', ...json(EvidenceVersionSchema) }, ...errors },
    }), async (c) => {
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > MAX_UPLOAD_BYTES) throw new ValidationError(`the file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB`);
      const { fileName, asOfDate, notes } = c.req.valid('query');
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const mime = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
      return c.json(toDto(EvidenceVersionSchema, await addFileVersion(c.get('ctx'), c.req.valid('param').id, {
        fileName, mime, bytes, ...(asOfDate ? { asOfDate } : {}), ...(notes ? { notes } : {}),
      })), 201);
    })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence/{id}/links-to-documents', access: requires('evidence:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(z.object({ url: z.url(), asOfDate: z.string().optional(), notes: z.string().optional() })) } },
      responses: { 201: { description: 'The address registered as a new version', ...json(EvidenceVersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(EvidenceVersionSchema, await addUrlVersion(c.get('ctx'), c.req.valid('param').id, c.req.valid('json') as { url: string })), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/evidence-versions/{id}/file', access: requires('evidence:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The stored file', content: { 'application/octet-stream': { schema: z.string() } } }, ...errors },
    }), async (c) => {
      const f = await readVersionFile(c.get('ctx'), c.req.valid('param').id);
      const disposition = `${INLINE.test(f.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.fileName)}`;
      return c.body(f.bytes as unknown as ArrayBuffer, 200, { 'content-type': f.mime, 'content-disposition': disposition, 'x-content-type-options': 'nosniff' }) as never;
    })

    // ---- Links ------------------------------------------------------------------------------------------------
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/requirements/{id}/evidence-links', access: requires('evidence:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Evidence linked directly to a requirement of any standard (by its framework and code, so it carries over to new versions)', ...json(z.array(EvidenceLinkSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(EvidenceLinkSchema), await linksForInternal(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/requirements/{id}/evidence-links', access: requires('evidence:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(LinkEvidenceSchema) } },
      responses: { 201: { description: 'Attached, for review', ...json(EvidenceLinkSchema) }, ...errors },
    }), async (c) => c.json(toDto(EvidenceLinkSchema, await linkToRequirement(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/framework-versions/{id}/requirement-context', access: requires('framework:read'), tags: tag,
      description: 'For every requirement of a standard version: the quality framework items it is mapped to, the evidence inherited through approved mappings and the evidence linked to it directly. Read-only; the evidence parts are empty without evidence:read.',
      request: { params: idParam },
      responses: { 200: { description: 'Mappings and evidence by requirement code', ...json(RequirementContextsSchema) }, ...errors },
    }), async (c) => c.json(toDto(RequirementContextsSchema, await requirementContexts(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/engagement-requirements/{id}/evidence-links', access: requires('evidence:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Evidence linked to an engagement requirement', ...json(z.array(EvidenceLinkSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(EvidenceLinkSchema), await linksForEngagementRequirement(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/engagement-requirements/{id}/evidence-links', access: requires('engagement:work'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(LinkEvidenceSchema) } },
      responses: { 201: { description: 'Linked, for review', ...json(EvidenceLinkSchema) }, ...errors },
    }), async (c) => c.json(toDto(EvidenceLinkSchema, await linkToEngagementRequirement(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/engagement-requirements/{id}/evidence-suggestions', access: requires('evidence:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Evidence on the internal items this requirement is mapped to, not yet linked here', ...json(z.array(EvidenceSuggestionSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(EvidenceSuggestionSchema), await suggestionsFor(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence-links/{id}/review', access: requires('evidence:read'), tags: tag,
      description: 'Engagement links need engagement:review on the engagement; internal links need evidence:review (checked in the service). A rejection needs a comment (the reason); the proposer is notified.',
      request: { params: idParam, body: { required: true, ...json(ReviewLinkSchema) } },
      responses: { 200: { description: 'Reviewed', ...json(EvidenceLinkSchema) }, ...errors },
    }), async (c) => c.json(toDto(EvidenceLinkSchema, await reviewLink(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/evidence-links/{id}/resubmit', access: requires('evidence:read'), tags: tag,
      description: 'The person who proposed a rejected link sends it back to review with a new reason (checked in the service).',
      request: { params: idParam, body: { required: true, ...json(ResubmitLinkSchema) } },
      responses: { 200: { description: 'Proposed again', ...json(EvidenceLinkSchema) }, ...errors },
    }), async (c) => c.json(toDto(EvidenceLinkSchema, await resubmitLink(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/evidence-links/{id}', access: requires('evidence:read'), tags: tag,
      description: 'Who may remove a link is checked in the service: the linking or reviewing permission of its target.',
      request: { params: idParam },
      responses: { 204: { description: 'Removed' }, ...errors },
    }), async (c) => { await removeLink(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); })

    // ---- My notifications (TASK-088): each person's own only (row-level security by user) -------------------------
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/notifications', access: requires('evidence:read'), tags: tag,
      description: 'My in-app notifications, unread first. Nobody reads another person\'s.',
      responses: { 200: { description: 'My notifications', ...json(z.array(NotificationSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(NotificationSchema), await listMyNotifications(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/notifications/{id}/read', access: requires('evidence:read'), tags: tag,
      request: { params: idParam }, responses: { 204: { description: 'Marked read' }, ...errors },
    }), async (c) => { await markNotificationRead(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); })

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/notifications/{id}', access: requires('evidence:read'), tags: tag,
      description: 'Dismisses one of my notifications.',
      request: { params: idParam }, responses: { 204: { description: 'Dismissed' }, ...errors },
    }), async (c) => { await dismissNotification(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); });
}
