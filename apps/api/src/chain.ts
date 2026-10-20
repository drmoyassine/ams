import { OpenAPIHono, createRoute, type RouteConfig } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import type pg from 'pg';
import { resolveFormLink, resolveRequestLink, withIdentity, type Identity } from '@ams/db';
import { hashLinkToken, isPermitted, type Ctx, type JobQueue, type ObjectStore } from '@ams/core';
import { REPLAY_HEADER, UNDO_HEADER, type Permission, type Scope, type UndoDescriptor } from '@ams/shared';

/** Resolves a request to a user and institution (Better Auth in production; injectable in tests). */
export type Authenticator = (req: Request) => Promise<{ userId: string; institutionId: string } | null>;

export interface AppEnv {
  /** `linkTargetId`: on link routes, the one request (or dataset) the link opens. */
  Variables: { caller: Identity; ctx: Ctx; linkTargetId: string; undo: UndoDescriptor };
}
export type AppContext = Context<AppEnv>;

/** Every route declares exactly one of these. There is no default. */
export type Access =
  | { kind: 'public' }
  | { kind: 'permission'; permission: Permission; scope: (c: AppContext) => Scope }
  | { kind: 'link'; target: 'request' | 'form' };

export const requires = (permission: Permission, scope: (c: AppContext) => Scope = () => ({ type: 'any' })): Access =>
  ({ kind: 'permission', permission, scope });
export const publicRoute = (): Access => ({ kind: 'public' });
/**
 * A one-time response link (DEC-018): the `{token}` path parameter is the credential, and it grants exactly one
 * request, whose id the handler reads from `linkTargetId`. No account is involved.
 */
export const responseLink = (): Access => ({ kind: 'link', target: 'request' });
/** A public form link (DEC-020): the `{token}` opens one open form; the dataset's id is in `linkTargetId`. */
export const formLink = (): Access => ({ kind: 'link', target: 'form' });

export const scopeFrom = {
  institution: (): Scope => ({ type: 'institution' }),
  program: (param: string) => (c: AppContext): Scope => ({ type: 'program', id: c.req.param(param) ?? '' }),
  orgUnit: (param: string) => (c: AppContext): Scope => ({ type: 'org_unit', id: c.req.param(param) ?? '' }),
};

/** Remembers what every route declared so startup and CI can prove none was missed. */
export class RouteRegistry {
  readonly declared = new Map<string, Access>();
  key(method: string, path: string) {
    return `${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ':$1')}`;
  }
}

class Rollback extends Error {}

/** The longest percent-encoded X-Undo value sent (bytes); proxies and Node refuse headers beyond a few KB. */
export const MAX_UNDO_HEADER = 6000;

export interface ChainDeps {
  pool: pg.Pool;
  queue: JobQueue;
  authenticate: Authenticator;
  /** Evidence file storage; absent when not configured (uploads then answer 409). */
  store?: ObjectStore;
}

const authenticateStep = (deps: ChainDeps): MiddlewareHandler<AppEnv> => async (c, next) => {
  const who = await deps.authenticate(c.req.raw);
  if (!who) return c.json({ error: 'unauthenticated' }, 401);
  c.set('caller', { userId: who.userId, institutionId: who.institutionId, requestId: crypto.randomUUID() });
  await next();
};

/** Authenticates and authorizes a one-time link at once: the link resolves to one open request, or to nothing. */
const linkStep = (deps: ChainDeps, target: 'request' | 'form'): MiddlewareHandler<AppEnv> => async (c, next) => {
  const token = c.req.param('token') ?? '';
  const found = token.length < 20 ? null
    : target === 'request'
      ? await resolveRequestLink(deps.pool, hashLinkToken(token)).then((f) => f && { id: f.requestId, institutionId: f.institutionId })
      : await resolveFormLink(deps.pool, token).then((f) => f && { id: f.itemId, institutionId: f.institutionId });
  if (!found) {
    return c.json({ error: target === 'request' ? 'this link has been used, has expired or is not valid' : 'this form is closed or the link is no longer valid' }, 404);
  }
  c.set('caller', { userId: null, institutionId: found.institutionId, requestId: crypto.randomUUID(), actorType: 'system' });
  c.set('linkTargetId', found.id);
  await next();
};

const authorizeStep = (deps: ChainDeps, access: Extract<Access, { kind: 'permission' }>): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const caller = c.get('caller');
    const ok = await withIdentity(deps.pool, caller, (tx) => isPermitted(tx, access.permission, access.scope(c)));
    if (!ok) return c.json({ error: 'forbidden', permission: access.permission }, 403);
    await next();
  };

/** Wraps validation and the handler in one identity-carrying transaction; a 4xx/5xx response rolls it back. */
const transactionStep = (deps: ChainDeps): MiddlewareHandler<AppEnv> => async (c, next) => {
  const caller = c.get('caller');
  const hooks: (() => Promise<void>)[] = [];
  let committed = true;
  try {
    await withIdentity(deps.pool, caller, async (tx) => {
      c.set('ctx', { tx, caller, queue: deps.queue, afterCommit: (fn) => { hooks.push(fn); }, undo: (d) => { c.set('undo', d); }, ...(deps.store ? { store: deps.store } : {}) });
      await next();
      // A reversible action says how to take it back (DEC-026): the last descriptor a service reported, percent-encoded JSON.
      const undo = c.get('undo');
      if (undo && !c.error && c.res.status < 400) {
        // Headers are small; an edit whose earlier text is long enough to burst the limit simply offers no undo.
        // A request sent as an Undo answers with the descriptor that redoes the action, and one sent as a Redo with the Undo
        // again (the client sends X-Replay). Same cap, same last-report-wins rule; the permission and the trigger checks of
        // the request are those of any other request.
        const replay = c.req.header(REPLAY_HEADER);
        const tagged: UndoDescriptor = replay === 'undo' ? { ...undo, kind: 'redo' } : replay === 'redo' ? { ...undo, kind: 'undo' } : undo;
        const encoded = encodeURIComponent(JSON.stringify(tagged));
        if (encoded.length <= MAX_UNDO_HEADER) c.header(UNDO_HEADER, encoded);
      }
      if (c.error || c.res.status >= 400) throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    committed = false;
  }
  if (committed) {
    for (const hook of hooks) {
      await hook().catch((err: unknown) => console.error(JSON.stringify({ level: 'error', msg: 'afterCommit failed', err: String(err) })));
    }
  }
};

export type SecureRouteConfig = Omit<RouteConfig, 'middleware'> & { access: Access };

/**
 * The only way to define an API route: wraps the config with authenticate -> authorize -> transaction; Zod validation
 * and the handler follow when the route is mounted with `app.openapi(...)`. A route without an `access` declaration
 * throws here, so the app refuses to start (PRD 18.3). Returns the typed route so the Hono RPC client can infer it.
 */
export function secured<P extends string, C extends Omit<SecureRouteConfig, 'path'> & { path: P }>(
  registry: RouteRegistry, deps: ChainDeps, config: C,
) {
  const { access, ...route } = config;
  if (!access || (access.kind !== 'public' && access.kind !== 'permission' && access.kind !== 'link')) {
    throw new Error(`Route ${route.method.toUpperCase()} ${route.path} has no requires(...) or publicRoute() declaration`);
  }
  const key = registry.key(route.method, route.path);
  if (registry.declared.has(key)) throw new Error(`Route ${key} is registered twice`);
  registry.declared.set(key, access);

  const middleware: MiddlewareHandler<AppEnv>[] = access.kind === 'public'
    ? []
    : access.kind === 'link'
      ? [linkStep(deps, access.target), transactionStep(deps)]
      : [authenticateStep(deps), authorizeStep(deps, access), transactionStep(deps)];
  return createRoute({ ...route, middleware } as unknown as Omit<C, 'access'> & { middleware: MiddlewareHandler<AppEnv>[] });
}

/** Fails if the router holds any handler that did not come through secureRoute (or an explicit exemption). */
export function assertAllRoutesDeclared(
  app: OpenAPIHono<AppEnv>,
  registry: RouteRegistry,
  exempt: readonly string[] = [],
): void {
  const missing: string[] = [];
  for (const r of app.routes) {
    if (r.method === 'ALL' && (r.path === '/*' || r.path === '*')) continue; // global middleware
    const key = `${r.method} ${r.path}`;
    if (!registry.declared.has(key) && !exempt.includes(key)) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(`Routes registered without a requires(...) declaration: ${missing.join(', ')}`);
  }
}

/**
 * Mounts a handler that is deliberately outside the permission chain (the authentication endpoints), recorded as
 * public so the startup check still accounts for it.
 */
export function rawPublicRoute(
  app: OpenAPIHono<AppEnv>,
  registry: RouteRegistry,
  methods: ('GET' | 'POST')[],
  path: string,
  handler: (req: Request) => Response | Promise<Response>,
): void {
  for (const m of methods) registry.declared.set(registry.key(m, path), { kind: 'public' });
  app.on(methods, path, (c) => handler(c.req.raw));
}
