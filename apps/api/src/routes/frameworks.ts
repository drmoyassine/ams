import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  getFramework, updateAccreditor, UpdateAccreditorSchema, updateFramework, UpdateFrameworkSchema,
  MAX_LOGO_BYTES, readAccreditorLogo, removeAccreditorLogo, setAccreditorLogo, ValidationError,
  CreateStandardFromFilesSchema, createStandardFromFiles, importedItemsByDocument,
  addQualityItem, applyQualityTemplate, editQualityItem, newQualityVersion, QualityItemSchema, publishQualityVersion, CreateAccreditorSchema, CreateFrameworkSchema, CreateVersionSchema, createAccreditor, createFramework, createVersion, exportVersion,
  getQualityFramework, getVersionDetail, importVersion, listFrameworks, listVersions, newVersionFrom, publishVersion, retireVersion, returnToDraft, setQualityLevels, setUpQualityFramework, submitForReview,
  updateVersionConfig, validateVersion,
} from '@ams/core';
import {
  AccreditorSchema, StandardFromFilesSchema, FrameworkListItemSchema, FrameworkSchema, ImportResultSchema, NewVersionResultSchema, QualityFrameworkSchema, RequirementSchema, ValidationResultSchema, VersionSchema,
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
      request: { body: { required: true, ...json(z.object({ name: z.string().optional(), levelLabels: z.array(z.string()).optional(), template: z.boolean().optional() })) } },
      responses: { 201: { description: 'Set up', ...json(QualityFrameworkSchema) }, ...errors },
    }), async (c) => c.json(toDto(QualityFrameworkSchema, await setUpQualityFramework(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/{id}/quality-template', access: requires('framework:write'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'An empty draft of the internal framework filled with the generic starting template', ...json(z.array(RequirementSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(RequirementSchema), await applyQualityTemplate(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/{id}/quality-items', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(QualityItemSchema) } },
      responses: { 201: { description: 'Added to the draft; 1 is a standard, 1.2 goes under standard 1', ...json(RequirementSchema) }, ...errors },
    }), async (c) => c.json(toDto(RequirementSchema, await addQualityItem(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/quality-items/{id}', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(QualityItemSchema) } },
      responses: { 200: { description: 'Edited; a new code can move it, and renumbering a standard renumbers its sub-standards', ...json(RequirementSchema) }, ...errors },
    }), async (c) => c.json(toDto(RequirementSchema, await editQualityItem(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/{id}/publish-quality', access: requires('framework:publish'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The internal framework draft approved and published in one step', ...json(VersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(VersionSchema, await publishQualityVersion(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/quality-framework/versions', access: requires('framework:write'), tags: tag,
      responses: { 201: { description: 'The next draft, copied from the newest version', ...json(VersionSchema) }, ...errors },
    }), async (c) => c.json(toDto(VersionSchema, await newQualityVersion(c.get('ctx'))), 201))

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
      method: 'patch', path: '/api/accreditors/{id}', access: requires('framework:write'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateAccreditorSchema) } },
      responses: { 200: { description: 'Updated', ...json(AccreditorSchema) }, ...errors },
    }), async (c) => c.json(toDto(AccreditorSchema, await updateAccreditor(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/frameworks/{id}', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The standard, its accreditor and its versions with their counts', ...json(FrameworkListItemSchema) }, ...errors },
    }), async (c) => c.json(toDto(FrameworkListItemSchema, await getFramework(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/frameworks/{id}', access: requires('framework:write'), tags: tag,
      description: 'Name, scope, commission and description of a standard; editable whatever the state of its versions.',
      request: { params: idParam, body: { required: true, ...json(UpdateFrameworkSchema) } },
      responses: { 200: { description: 'Updated', ...json(FrameworkListItemSchema) }, ...errors },
    }), async (c) => c.json(toDto(FrameworkListItemSchema, await updateFramework(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/accreditors/{id}/logo', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The logo image', content: { 'application/octet-stream': { schema: z.string() } } }, ...errors },
    }), async (c) => {
      const f = await readAccreditorLogo(c.get('ctx'), c.req.valid('param').id);
      return c.body(f.bytes as unknown as ArrayBuffer, 200, { 'content-type': f.mime, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=86400' }) as never;
    })

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/accreditors/{id}/logo', access: requires('framework:write'), tags: tag,
      description: 'The request body is the image itself (PNG, JPEG or WebP, at most 512 KB).',
      request: { params: idParam },
      responses: { 204: { description: 'Saved' }, ...errors },
    }), async (c) => {
      if (Number(c.req.header('content-length') ?? 0) > MAX_LOGO_BYTES) throw new ValidationError(`the logo is larger than ${MAX_LOGO_BYTES / 1024} KB`);
      await setAccreditorLogo(c.get('ctx'), c.req.valid('param').id, new Uint8Array(await c.req.arrayBuffer()));
      return c.body(null, 204);
    })

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/accreditors/{id}/logo', access: requires('framework:write'), tags: tag,
      request: { params: idParam },
      responses: { 204: { description: 'Removed' }, ...errors },
    }), async (c) => { await removeAccreditorLogo(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); })

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
      request: { body: { required: true, ...json(z.object({ file: z.unknown(), edition: z.string().optional() })) } },
      responses: { 201: { description: 'Imported as a new draft version', ...json(ImportResultSchema) }, ...errors },
    }), async (c) => {
      const { file, edition } = c.req.valid('json');
      return c.json(toDto(ImportResultSchema, await importVersion(c.get('ctx'), file, { ...(edition ? { edition } : {}) })), 201);
    })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/framework-versions/from-files', access: requires('framework:write'), tags: tag,
      description: 'Creates (or reuses) the accreditor, the standard and its first draft version, and one source per file named, in one transaction. The files themselves are then uploaded to the returned documents, and the analysis is started.',
      request: { body: { required: true, ...json(CreateStandardFromFilesSchema) } },
      responses: { 201: { description: 'Created; upload each file to its document', ...json(StandardFromFilesSchema) }, ...errors },
    }), async (c) => c.json(toDto(StandardFromFilesSchema, await createStandardFromFiles(c.get('ctx'), c.req.valid('json'))), 201))

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
      return c.json({ ok: r.ok, issues: r.ok ? [] : r.issues, warnings: r.warnings ?? [] }, 200);
    })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/framework-versions/{id}/imported-items', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The items each import of this version created, by the document its run read: document id -> requirement ids', ...json(z.record(z.string(), z.array(z.string().uuid()))) }, ...errors },
    }), async (c) => c.json(await importedItemsByDocument(c.get('ctx'), c.req.valid('param').id), 200))

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
