// The Garage bootstrap must be safe to run on every deploy. A fake of the Garage admin API (v1) records what it is
// asked to change; a second run against the same state must change nothing.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../../../scripts/garage-init.mjs');
const KEY = `GK${'ab'.repeat(12)}`;
const SECRET = 'cd'.repeat(32);

let server: Server;
let url: string;
const state = { roles: [] as unknown[], layoutVersion: 0, keys: new Set<string>(), buckets: new Map<string, string>(), grants: [] as unknown[] };
const writes: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url!, 'http://x');
      const reply = (status: number, json: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(json)); };
      if (req.headers.authorization !== 'Bearer admin-token') return reply(403, { message: 'forbidden' });
      const key = `${req.method} ${u.pathname}`;
      if (req.method !== 'GET') writes.push(key);
      const data = body ? JSON.parse(body) : null;
      switch (key) {
        case 'GET /v1/status': return reply(200, { node: 'node1', layoutVersion: state.layoutVersion });
        case 'GET /v1/layout': return reply(200, { version: state.layoutVersion, roles: state.roles, stagedRoleChanges: [] });
        case 'POST /v1/layout': state.roles = data; return reply(200, {});
        case 'POST /v1/layout/apply': if (data.version !== state.layoutVersion + 1) return reply(500, { message: 'Invalid new layout version' }); state.layoutVersion = data.version; return reply(200, {});
        case 'GET /v1/key': return state.keys.has(u.searchParams.get('id')!) ? reply(200, { accessKeyId: u.searchParams.get('id') }) : reply(404, { message: 'no such key' });
        case 'POST /v1/key/import': if (state.keys.has(data.accessKeyId)) return reply(500, { message: 'key exists' }); state.keys.add(data.accessKeyId); return reply(200, {});
        case 'GET /v1/bucket': { const id = state.buckets.get(u.searchParams.get('globalAlias')!); return id ? reply(200, { id }) : reply(404, { message: 'no such bucket' }); }
        case 'POST /v1/bucket': if (state.buckets.has(data.globalAlias)) return reply(409, {}); state.buckets.set(data.globalAlias, `bucket-${state.buckets.size + 1}`); return reply(200, { id: state.buckets.get(data.globalAlias) });
        case 'POST /v1/bucket/allow': state.grants.push(data); return reply(200, {});
        default: return reply(404, { message: `unexpected ${key}` });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const run = (env: Record<string, string> = {}) => new Promise<{ code: number | null; out: string }>((done) => {
  const p = spawn('node', [SCRIPT], {
    env: { PATH: process.env.PATH ?? '', GARAGE_ADMIN_URL: url, GARAGE_ADMIN_TOKEN: 'admin-token', S3_ACCESS_KEY_ID: KEY, S3_SECRET_ACCESS_KEY: SECRET, S3_BUCKET: 'ams', ...env },
  });
  let out = '';
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.on('data', (c) => { out += c; });
  p.on('close', (code) => done({ code, out }));
});

describe('garage-init', () => {
  it('bootstraps an empty Garage: layout, key, bucket, grant', async () => {
    const r = await run();
    expect(r.code, r.out).toBe(0);
    expect(writes).toEqual(['POST /v1/layout', 'POST /v1/layout/apply', 'POST /v1/key/import', 'POST /v1/bucket', 'POST /v1/bucket/allow']);
    expect(state.grants).toEqual([{ bucketId: 'bucket-1', accessKeyId: KEY, permissions: { read: true, write: true, owner: true } }]);
  });

  it('is a no-op on a second run (redeploy): nothing is re-created, and it still succeeds', async () => {
    writes.length = 0;
    const r = await run();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/layout already present/);
    expect(r.out).toMatch(/access key already present/);
    expect(r.out).toMatch(/bucket already present/);
    expect(writes).toEqual(['POST /v1/bucket/allow']); // re-granting is idempotent
  });

  it('refuses keys that are not Garage-shaped, and says why', async () => {
    const r = await run({ S3_ACCESS_KEY_ID: 'amsminio' });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Garage keys must look like GK/);
  });

  it('fails loudly, with Garage\'s own answer, when the admin token is wrong', async () => {
    const r = await run({ GARAGE_ADMIN_TOKEN: 'wrong', GARAGE_INIT_ATTEMPTS: '1' });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/status -> 403/);
  });
});
