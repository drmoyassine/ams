import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import { createProgram, languageStateOf, listPrograms, listUsers, myAccess, updateMyPreferences } from '@ams/core';
import { CreateProgramSchema, LanguageStateSchema, MeSchema, ProgramSchema, UpdateMyPreferencesSchema, UserSummarySchema } from '@ams/shared';
import { publicRoute, requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from './chain.js';
import { analysisRoutes } from './routes/analysis.js';
import { assistantRoutes } from './routes/assistant.js';
import { engagementRoutes } from './routes/engagements.js';
import { evidenceRoutes } from './routes/evidence.js';
import { collectionRoutes } from './routes/collection.js';
import { publicRoutes } from './routes/public.js';
import { requestRoutes } from './routes/requests.js';
import { datasetRoutes } from './routes/datasets.js';
import { documentRoutes } from './routes/documents.js';
import { formRoutes } from './routes/forms.js';
import { frameworkRoutes } from './routes/frameworks.js';
import { glossaryRoutes } from './routes/glossary.js';
import { contentTranslationRoutes } from './routes/content-translations.js';
import { languageRoutes } from './routes/languages.js';
import { mappingRoutes } from './routes/mappings.js';
import { requirementRoutes } from './routes/requirements.js';
import { settingsRoutes } from './routes/settings.js';
import { cycleRoutes } from './routes/cycles.js';
import { scopeRoutes } from './routes/scope.js';
import { planRoutes } from './routes/plans.js';
import { orgChartRoutes } from './routes/org-chart.js';
import { templateRoutes } from './routes/templates.js';
import { trashRoutes } from './routes/trash.js';

const json = <T extends z.ZodType>(schema: T) => ({ content: { 'application/json': { schema } } });

/** Routes are chained so the app's type carries every path, input and output to the typed RPC client. */
export function buildRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/healthz', access: publicRoute(),
      responses: { 200: { description: 'Liveness', ...json(z.object({ ok: z.literal(true) })) } },
    }), (c) => c.json({ ok: true as const }, 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/me', access: requires('program:read'), tags: ['session'],
      responses: { 200: { description: 'The signed-in user, their roles and effective permissions', ...json(MeSchema) }, 401: { description: 'Unauthenticated' }, 403: { description: 'Forbidden' } },
    }), async (c) => c.json({ ...(await myAccess(c.get('ctx'))), language: await languageStateOf(c.get('ctx')) }, 200))

    // The signed-in person's own preferences: only their own row can change (there is no id to name).
    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/me/preferences', access: requires('program:read'), tags: ['session'],
      request: { body: { required: true, ...json(UpdateMyPreferencesSchema) } },
      responses: { 200: { description: 'The language setting after the change: English or the institution\'s secondary language, or null for the default', ...json(LanguageStateSchema) }, 400: { description: 'Not an allowed language' }, 401: { description: 'Unauthenticated' }, 403: { description: 'Forbidden' } },
    }), async (c) => c.json(await updateMyPreferences(c.get('ctx'), c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/programs', access: requires('program:read'),
      tags: ['programs'],
      responses: {
        200: { description: 'Programs visible to the caller', ...json(z.array(ProgramSchema)) },
        401: { description: 'Unauthenticated' },
        403: { description: 'Forbidden' },
      },
    }), async (c) => c.json(await listPrograms(c.get('ctx')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/programs', access: requires('program:write'),
      tags: ['programs'],
      request: { body: { required: true, ...json(CreateProgramSchema) } },
      responses: {
        201: { description: 'Created', ...json(ProgramSchema) },
        400: { description: 'Invalid input' },
        401: { description: 'Unauthenticated' },
        403: { description: 'Forbidden' },
      },
    }), async (c) => c.json(await createProgram(c.get('ctx'), c.req.valid('json')), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/users', access: requires('org:read'), tags: ['users'],
      responses: { 200: { description: 'Active people of the institution', ...json(z.array(UserSummarySchema)) }, 401: { description: 'Unauthenticated' }, 403: { description: 'Forbidden' } },
    }), async (c) => c.json(await listUsers(c.get('ctx')), 200))

    // Framework library (M1). Each module chains its own routes so their types merge into ApiRoutes.
    .route('/', frameworkRoutes(registry, deps, options))
    .route('/', requirementRoutes(registry, deps, options))
    .route('/', trashRoutes(registry, deps, options))
    .route('/', templateRoutes(registry, deps, options))
    .route('/', analysisRoutes(registry, deps, options))
    .route('/', documentRoutes(registry, deps, options))

    // Engagements and roadmaps (M2).
    .route('/', engagementRoutes(registry, deps, options))

    // Settings: institution, org chart, program edits.
    .route('/', settingsRoutes(registry, deps, options))
    .route('/', orgChartRoutes(registry, deps, options))
    // Sign-in page branding: the only data served without signing in.
    .route('/', publicRoutes(registry, deps, options))
    .route('/', languageRoutes(registry, deps, options))
    .route('/', contentTranslationRoutes(registry, deps, options))
    .route('/', glossaryRoutes(registry, deps, options))
    .route('/', mappingRoutes(registry, deps, options))
    .route('/', evidenceRoutes(registry, deps, options))
    .route('/', requestRoutes(registry, deps, options))
    .route('/', collectionRoutes(registry, deps, options))
    .route('/', datasetRoutes(registry, deps, options))
    .route('/', formRoutes(registry, deps, options))

    // Quality Management cycles (DEC-029).
    .route('/', cycleRoutes(registry, deps, options))
    .route('/', scopeRoutes(registry, deps, options))
    .route('/', planRoutes(registry, deps, options))

    // The in-app assistant (DEC-027).
    .route('/', assistantRoutes(registry, deps, options));
}

export type ApiRoutes = ReturnType<typeof buildRoutes>;
