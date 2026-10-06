import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  CreateAccreditorSchema, CreateFrameworkSchema, CreateVersionSchema, createAccreditor, createFramework, createVersion, exportVersion,
  getQualityFramework, getVersionDetail, importVersion, listFrameworks, listVersions, newVersionFrom, publishVersion, retireVersion, returnToDraft, setQualityLevels, setUpQualityFramework, submitForReview,
  updateVersionConfig, validateVersion,
} from '@ams/core';
import {
  AccreditorSchema, FrameworkListItemSchema, FrameworkSchema, ImportResultSchema, NewVersionResultSchema, QualityFrameworkSchema, ValidationResultSchema, VersionSchema,
  toDto,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

const ConfigPatchBody = z.object({
  levelLabels: z.array(z.string()).optional(),
  lifecycleTemplate: z.unknown().optional(),
  decisionVocab: z.unknown().optional(),
  findingVocab: z.unknown().optional(),
  responseVocab: z.unknown().optional(),
  ratingMethod: z.unknown().optional(),
  effectiveFrom: z.string().nullable().optional(),
  effectiveTo: z.string().nullable().optional(),
  changeSummary: z.string().nullable().optional(),
});

export function frameworkRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['frameworks'];
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/frameworks', access: requires('framework:read'), tags: tag,
      responses: { 200: { description: 'Frameworks', ...json(z.array(FrameworkListItemSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(FrameworkListItemSchema), await listFrameworks(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/quality-framework', access: requires('framework:read'), tags: tag,
      responses: { 200: { description: 'The institution\'s own quality framework and its versions', ...json(QualityFrameworkSchema) }, ...errors },
    }), async (c) => c.json(toDto(QualityFrameworkSchema, await getQualityFramework(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/quality-framework', access: requires('framework:write'), tags: tag,
      request: { body: { required: true, ...json(z.object({ name: z.string().optional(), levelLabels: z.array(z.string()).optional() })) } },
      responses: { 201: { description: 'Set up', ...json(QualityFrameworkSchema) }, ...errors },
    }), async (c) => c.json(toDto(QualityFrameworkSchema, await setUpQualityFramework(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/quality-framework/levels', access: requires('framework:write'), tags: tag,
      request: { body: { required: true, ...json(z.object({ levelLabels: z.array(z.string()) })) } },
      responses: { 200: { description: 'The level names, top first, set on the newest draft version', ...json(QualityFrameworkSchema) }, ...errors },
    }), async (c) => c.json(toDto(QualityFrameworkSchema, await setQualityLevels(c.get('ctx'), c.req.valid('json').levelLabels)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/accreditors', access: requires('framework:write'), tags: tag,
      request: { body: { required: true, ...json(CreateAccreditorSchema) } },
      responses: { 201: { description: 'Created', ...json(AccreditorSchema) }, ...errors },
    }), async (c) => c.json(toDto(AccreditorSchema, await createAccreditor(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/frameworks', access: requires('framework:write'), tags: tag,
      request: { body: { required: true, ...json(CreateFrameworkSchema) } },
      responses: { 201: { description: 'Created', ...json(FrameworkSchema) }, ...errors },
    }), async (c) => c.json(toDto(FrameworkSchema, await createFramework(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/frameworks/{id}/versions', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Versions', ...json(z.array(VersionSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(VersionSchema), await listVersions(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/frameworks/{id}/versions', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(CreateVersionSchema.omit({ frameworkId: true })) } },
      responses: { 201: { description: 'Created', ...json(VersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(VersionSchema, await createVersion(c.get('ctx'), { ...c.req.valid('json'), frameworkId: c.req.valid('param').id })), 201))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/import', access: requires('framework:write'), tags: tag,
      request: { body: { required: true, ...json(z.object({ file: z.unknown(), edition: z.string().optional(), autoApprove: z.boolean().optional() })) } },
      responses: { 201: { description: 'Imported as a new draft version', ...json(ImportResultSchema) }, ...errors },
    }), async (c) => {
      const { file, edition, autoApprove } = c.req.valid('json');
      return c.json(toDto(ImportResultSchema, await importVersion(c.get('ctx'), file, { ...(edition ? { edition } : {}), ...(autoApprove ? { autoApprove } : {}) })), 201);
    })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/framework-versions/{id}', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Version with its configuration', ...json(VersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(VersionSchema, await getVersionDetail(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/framework-versions/{id}/validation', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Configuration check; ok=false lists every issue', ...json(ValidationResultSchema) }, ...errors },
    }), async (c) => {
      const r = await validateVersion(c.get('ctx'), c.req.valid('param').id);
      return c.json({ ok: r.ok, issues: r.ok ? [] : r.issues }, 200);
    })

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/framework-versions/{id}/config', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(ConfigPatchBody) } },
      responses: { 200: { description: 'Updated draft version', ...json(VersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(VersionSchema, await updateVersionConfig(c.get('ctx'), c.req.valid('param').id, c.req.valid('json') as never)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/{id}/submit', access: requires('framework:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Now in review', ...json(VersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(VersionSchema, await submitForReview(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/{id}/return-to-draft', access: requires('framework:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Back to draft', ...json(VersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(VersionSchema, await returnToDraft(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/{id}/publish', access: requires('framework:publish'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Published; immutable from now on', ...json(VersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(VersionSchema, await publishVersion(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/{id}/retire', access: requires('framework:publish'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Retired', ...json(VersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(VersionSchema, await retireVersion(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/{id}/new-version', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(z.object({ edition: z.string().min(1), changeSummary: z.string().optional() })) } },
      responses: { 201: { description: 'A new draft copied from this version', ...json(NewVersionResultSchema) }, ...errors },
    }), async (c) => {
      const { edition, changeSummary } = c.req.valid('json');
      return c.json(toDto(NewVersionResultSchema, await newVersionFrom(c.get('ctx'), c.req.valid('param').id, { edition, ...(changeSummary ? { changeSummary } : {}) })), 201);
    })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/framework-versions/{id}/export', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The version as one framework file', ...json(z.record(z.string(), z.unknown())) }, ...errors },
    }), async (c) => c.json(JSON.parse(JSON.stringify(await exportVersion(c.get('ctx'), c.req.valid('param').id))) as Record<string, unknown>, 200));
}
