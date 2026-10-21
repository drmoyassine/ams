// Evidence collection runs (TASK-090): the retry schedule, the body the BI supplies, and the BI settings of the environment.
import { describe, expect, it } from 'vitest';
import { loadEnv } from './config.js';
import { BiSupplyBodySchema, COLLECTION_RETRY_MINUTES, MAX_COLLECTION_ATTEMPTS, nextAttemptAfter } from './collection.js';
import { JOB_TYPES, QUEUE_GROUPS } from './permissions.js';

const base = {
  APP_URL: 'http://localhost:3000', DATABASE_URL: 'postgres://ams:ams@localhost:5432/ams', AUTH_SECRET: 'x'.repeat(32),
  S3_ENDPOINT: 'http://localhost:9000', S3_BUCKET: 'ams', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's',
};

describe('the retry schedule', () => {
  const t0 = new Date('2027-01-01T00:00:00Z');
  it('waits 15 minutes, 1 hour, 4 hours and 12 hours after the first four failures, and gives up after five', () => {
    expect(COLLECTION_RETRY_MINUTES).toEqual([15, 60, 240, 720]);
    const delays = [1, 2, 3, 4].map((n) => (nextAttemptAfter(n, t0)!.getTime() - t0.getTime()) / 60_000);
    expect(delays).toEqual([15, 60, 240, 720]);
    expect(MAX_COLLECTION_ATTEMPTS).toBe(5);
    expect(nextAttemptAfter(5, t0)).toBeNull();
    expect(nextAttemptAfter(9, t0)).toBeNull();
  });
});

describe('what the BI supplies', () => {
  const ok = (b: unknown) => BiSupplyBodySchema.safeParse(b);
  const messages = (b: unknown) => { const r = ok(b); return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`); };

  it('is exactly one of rows, a file or an address, with the date it is true as of', () => {
    expect(ok({ rows: [{ a: 1, b: 'x', c: null, d: true }], asOf: '2027-01-01' }).success).toBe(true);
    expect(ok({ rows: [], asOf: '2027-01-01T10:00:00Z', lineage: { by: 'bi' }, notes: 'n' }).success).toBe(true);
    expect(ok({ fileBase64: 'AAAA', fileName: 'a.pdf', mime: 'application/pdf', asOf: '2027-01-01' }).success).toBe(true);
    expect(ok({ url: 'https://x.example/a', asOf: '2027-01-01' }).success).toBe(true);
    expect(messages({ asOf: '2027-01-01' })).toEqual([': send exactly one of rows, fileBase64 or url']);
    expect(messages({ rows: [], url: 'https://x.example/a', asOf: '2027-01-01' })).toContain(': send exactly one of rows, fileBase64 or url');
    expect(messages({ rows: [] })).toEqual(['asOf: Invalid input: expected string, received undefined']);
    expect(messages({ rows: [], asOf: 'yesterday' })[0]).toMatch(/^asOf: asOf is a date/);
  });

  it('names a file, takes only https addresses, and refuses what it does not know', () => {
    expect(messages({ fileBase64: 'AAAA', asOf: '2027-01-01' })).toEqual(['fileName: name the file']);
    expect(messages({ url: 'http://x.example/a', asOf: '2027-01-01' })).toEqual(['url: the address must be https']);
    expect(ok({ rows: [], asOf: '2027-01-01', status: 'supplied' }).success).toBe(false); // strict: the BI cannot name a status
    expect(ok({ rows: [{ a: { nested: 1 } }], asOf: '2027-01-01' }).success).toBe(false); // a cell is text, a number, true/false or empty
  });
});

describe('the BI settings of the environment', () => {
  it('are all optional: no BI is the default', () => {
    const env = loadEnv(base);
    expect(env.BI_BASE_URL).toBeUndefined();
    expect(env.BI_API_KEY).toBeUndefined();
    expect(env.BI_ENDPOINTS).toEqual({});
    expect(env.APP_PUBLIC_URL).toBeUndefined();
    expect(loadEnv({ ...base, BI_BASE_URL: '', BI_API_KEY: '', BI_ENDPOINTS: '' }).BI_BASE_URL).toBeUndefined();
  });

  it('read the address, the key, the public address and the named endpoints (paths only)', () => {
    const env = loadEnv({ ...base, BI_BASE_URL: 'https://bi.example.org', BI_API_KEY: 'k', APP_PUBLIC_URL: 'https://ams.example.org', BI_ENDPOINTS: '{"warehouse":"/ams/collect/warehouse","web-1":"/x"}' });
    expect(env).toMatchObject({ BI_BASE_URL: 'https://bi.example.org', BI_API_KEY: 'k', APP_PUBLIC_URL: 'https://ams.example.org', BI_ENDPOINTS: { warehouse: '/ams/collect/warehouse', 'web-1': '/x' } });
  });

  it('refuse an endpoint that is an address, a path that climbs, a bad name and anything that is not a JSON object', () => {
    const bad = (BI_ENDPOINTS: string) => () => loadEnv({ ...base, BI_ENDPOINTS });
    expect(bad('{"w":"https://evil.example.org/x"}')).toThrow(/BI_ENDPOINTS .*must start with \/ and hold no address/);
    expect(bad('{"w":"//evil.example.org"}')).toThrow(/BI_ENDPOINTS/);
    expect(bad('{"w":"/a/../b"}')).toThrow(/BI_ENDPOINTS/);
    expect(bad('{"1w":"/x"}')).toThrow(/not a valid endpoint name/);
    expect(bad('["/x"]')).toThrow(/JSON object/);
    expect(bad('not json')).toThrow(/BI_ENDPOINTS/);
    expect(() => loadEnv({ ...base, BI_BASE_URL: 'not an address' })).toThrow(/BI_BASE_URL/);
  });
});

describe('the scheduler is a job of the general worker service', () => {
  it('collect_tick is a job type taken by the worker group only', () => {
    expect(JOB_TYPES).toContain('collect_tick');
    expect(QUEUE_GROUPS.worker).toContain('collect_tick');
    for (const other of ['parser', 'agent'] as const) expect(QUEUE_GROUPS[other] as readonly string[]).not.toContain('collect_tick');
  });
});
