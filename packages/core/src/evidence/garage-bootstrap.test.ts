// The Garage bootstrap runs on every start of the app, so a second run against the same state must change nothing.
// A fake of the Garage admin API (v1) behind a stubbed fetch records what it is asked to change.
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrapGarage, bootstrapGarageFromEnv, GarageBootstrapError, type GarageBootstrapOptions } from './garage-bootstrap.js';

const KEY = `GK${'ab'.repeat(12)}`;
const SECRET = 'cd'.repeat(32);
const TOKEN = 'admin-token';

let state: { roles: unknown[]; layoutVersion: number; keys: Set<string>; buckets: Map<string, string>; grants: unknown[] };
let writes: string[];
let failures: Record<string, number>; // path -> how many calls still fail with a network error
let notReady: number; // how many /v1/status calls still fail

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fakeFetch: typeof fetch = async (input, init) => {
  const u = new URL(String(input));
  const method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers);
  if (headers.get('authorization') !== `Bearer ${TOKEN}`) return json(403, { message: 'forbidden' });
  const key = `${method} ${u.pathname}`;
  if (key === 'GET /v1/status' && notReady > 0) { notReady--; throw new TypeError('connect ECONNREFUSED'); }
  if (failures[key]) { failures[key]--; throw new TypeError('socket hang up'); }
  if (method !== 'GET') writes.push(key);
  const data = init?.body ? JSON.parse(String(init.body)) : null;
  switch (key) {
    case 'GET /v1/status': return json(200, { node: 'node1', layoutVersion: state.layoutVersion });
    case 'GET /v1/layout': return json(200, { version: state.layoutVersion, roles: state.roles, stagedRoleChanges: [] });
    case 'POST /v1/layout': state.roles = data; return json(200, {});
    case 'POST /v1/layout/apply': if (data.version !== state.layoutVersion + 1) return json(500, { message: 'Invalid new layout version' }); state.layoutVersion = data.version; return json(200, {});
    case 'GET /v1/key': return state.keys.has(u.searchParams.get('id')!) ? json(200, { accessKeyId: u.searchParams.get('id') }) : json(404, { message: 'no such key' });
    case 'POST /v1/key/import': if (state.keys.has(data.accessKeyId)) return json(500, { message: 'key exists' }); state.keys.add(data.accessKeyId); return json(200, {});
    case 'GET /v1/bucket': { const id = state.buckets.get(u.searchParams.get('globalAlias')!); return id ? json(200, { id }) : json(404, { message: 'no such bucket' }); }
    case 'POST /v1/bucket': if (state.buckets.has(data.globalAlias)) return json(409, {}); state.buckets.set(data.globalAlias, `bucket-${state.buckets.size + 1}`); return json(200, { id: state.buckets.get(data.globalAlias) });
    case 'POST /v1/bucket/allow': state.grants.push(data); return json(200, {});
    default: return json(404, { message: `unexpected ${key}` });
  }
};

const sleeps: number[] = [];
const opts = (extra: Partial<GarageBootstrapOptions> = {}): GarageBootstrapOptions => ({
  adminUrl: 'http://garage:3903/', adminToken: TOKEN, accessKeyId: KEY, secretAccessKey: SECRET, bucket: 'ams',
  attempts: 5, delayMs: 7, fetch: fakeFetch, sleep: async (ms) => { sleeps.push(ms); }, ...extra,
});

beforeEach(() => {
  state = { roles: [], layoutVersion: 0, keys: new Set(), buckets: new Map(), grants: [] };
  writes = []; failures = {}; notReady = 0; sleeps.length = 0;
});

describe('bootstrapGarage', () => {
  it('first run: assigns the layout, imports the key, creates the bucket and grants access', async () => {
    expect(await bootstrapGarage(opts())).toEqual({ layout: 'applied', key: 'imported', bucket: 'created' });
    expect(writes).toEqual(['POST /v1/layout', 'POST /v1/layout/apply', 'POST /v1/key/import', 'POST /v1/bucket', 'POST /v1/bucket/allow']);
    expect(state.roles).toEqual([{ id: 'node1', zone: 'dc1', capacity: 1073741824, tags: [] }]);
    expect(state.layoutVersion).toBe(1);
    expect(state.keys.has(KEY)).toBe(true);
    expect(state.grants).toEqual([{ bucketId: 'bucket-1', accessKeyId: KEY, permissions: { read: true, write: true, owner: true } }]);
  });

  it('second run: everything exists, nothing is created (the grant is the only, repeatable, write)', async () => {
    await bootstrapGarage(opts());
    writes.length = 0;
    expect(await bootstrapGarage(opts())).toEqual({ layout: 'present', key: 'present', bucket: 'present' });
    expect(writes).toEqual(['POST /v1/bucket/allow']);
    expect(state.layoutVersion).toBe(1);
    expect(state.buckets.size).toBe(1);
  });

  it('partial state: only what is missing is done', async () => {
    state.roles = [{ id: 'node1' }]; state.layoutVersion = 1; state.keys.add(KEY); // layout and key, no bucket
    expect(await bootstrapGarage(opts())).toEqual({ layout: 'present', key: 'present', bucket: 'created' });
    expect(writes).toEqual(['POST /v1/bucket', 'POST /v1/bucket/allow']);

    state = { roles: [], layoutVersion: 0, keys: new Set(), buckets: new Map([['ams', 'bucket-9']]), grants: [] }; // bucket made by hand
    writes.length = 0;
    expect(await bootstrapGarage(opts())).toEqual({ layout: 'applied', key: 'imported', bucket: 'present' });
    expect(writes).toEqual(['POST /v1/layout', 'POST /v1/layout/apply', 'POST /v1/key/import', 'POST /v1/bucket/allow']);
    expect(state.grants[0]).toMatchObject({ bucketId: 'bucket-9' });
  });

  it('refuses keys that are not Garage-shaped, before calling Garage', async () => {
    await expect(bootstrapGarage(opts({ accessKeyId: 'AKIAEXAMPLE' }))).rejects.toThrow(/GK \+ 24 hex/);
    await expect(bootstrapGarage(opts({ secretAccessKey: 'short' }))).rejects.toThrow(GarageBootstrapError);
    expect(writes).toEqual([]);
  });

  it('waits while Garage starts, then proceeds', async () => {
    notReady = 3;
    expect(await bootstrapGarage(opts())).toMatchObject({ bucket: 'created' });
    expect(sleeps).toEqual([7, 7, 7]);
  });

  it('fails clearly when Garage never becomes ready', async () => {
    notReady = 99;
    await expect(bootstrapGarage(opts({ attempts: 3 }))).rejects.toThrow(/did not become ready after 3 attempts/);
    expect(writes).toEqual([]);
  });

  it('fails clearly on a refused admin token', async () => {
    await expect(bootstrapGarage(opts({ adminToken: 'wrong' }))).rejects.toThrow(/refused the admin token/);
  });

  it('a hard refusal shows what Garage answered and is not retried', async () => {
    state.roles = [{ id: 'node1' }]; state.layoutVersion = 1;
    const refusing: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === '/v1/key/import') return json(500, { message: 'cannot import' });
      return fakeFetch(input, init);
    };
    await expect(bootstrapGarage(opts({ fetch: refusing }))).rejects.toThrow('Garage refused POST /v1/key/import: 500 {"message":"cannot import"}');
    expect(writes).toEqual([]);
  });

  it('retries a call that got no answer, then gives up with a clear error', async () => {
    failures['GET /v1/layout'] = 2;
    expect(await bootstrapGarage(opts())).toMatchObject({ layout: 'applied' });
    failures['GET /v1/layout'] = 99;
    await expect(bootstrapGarage(opts())).rejects.toThrow(/did not answer GET \/v1\/layout: socket hang up/);
  });
});

describe('bootstrapGarageFromEnv', () => {
  const env = { GARAGE_ADMIN_URL: 'http://garage:3903', GARAGE_ADMIN_TOKEN: TOKEN, GARAGE_BOOTSTRAP_ATTEMPTS: 5, GARAGE_BOOTSTRAP_DELAY_MS: 1, S3_ACCESS_KEY_ID: KEY, S3_SECRET_ACCESS_KEY: SECRET, S3_BUCKET: 'ams' };

  it('does nothing when GARAGE_ADMIN_URL is not set (AWS S3, MinIO ...)', async () => {
    let called = false;
    const spy: typeof fetch = async () => { called = true; return json(200, {}); };
    expect(await bootstrapGarageFromEnv({ ...env, GARAGE_ADMIN_URL: undefined }, { fetch: spy })).toBeNull();
    expect(called).toBe(false);
  });

  it('runs with the environment when it is set, and needs the admin token', async () => {
    expect(await bootstrapGarageFromEnv(env, { fetch: fakeFetch })).toMatchObject({ bucket: 'created' });
    await expect(bootstrapGarageFromEnv({ ...env, GARAGE_ADMIN_TOKEN: undefined }, { fetch: fakeFetch })).rejects.toThrow(/GARAGE_ADMIN_TOKEN is required/);
  });
});
