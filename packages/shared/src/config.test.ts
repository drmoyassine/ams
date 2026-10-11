import { describe, expect, it } from 'vitest';
import { loadEnv } from './config.js';
import { JOB_TYPES, QUEUE_GROUPS, QUEUE_GROUP_NAMES, queueGroupOf } from './permissions.js';

const base = {
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://ams:ams@localhost:5432/ams',
  AUTH_SECRET: 'x'.repeat(32),
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'ams',
  S3_ACCESS_KEY_ID: 'k',
  S3_SECRET_ACCESS_KEY: 's',
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });
  it('names every missing variable', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL.*AUTH_SECRET|AUTH_SECRET.*DATABASE_URL/s);
  });
  it('treats empty optional values as unset', () => {
    const env = loadEnv({ ...base, OIDC_DISCOVERY_URL: '', ADMIN_EMAIL: '' });
    expect(env.OIDC_DISCOVERY_URL).toBeUndefined();
    expect(env.OIDC_PROVIDER_ID).toBe('oidc');
  });
  it('rejects a short auth secret', () => {
    expect(() => loadEnv({ ...base, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
  });
  it('WORKER_QUEUES: every job type when unset, a validated list when set, refused when empty or unknown', () => {
    expect(loadEnv(base).WORKER_QUEUES).toEqual([...JOB_TYPES]);
    expect(loadEnv({ ...base, WORKER_QUEUES: 'extract_text, notify' }).WORKER_QUEUES).toEqual(['extract_text', 'notify']);
    expect(() => loadEnv({ ...base, WORKER_QUEUES: '' })).toThrow(/WORKER_QUEUES is empty/);
    expect(() => loadEnv({ ...base, WORKER_QUEUES: ' , ' })).toThrow(/WORKER_QUEUES is empty/);
    expect(() => loadEnv({ ...base, WORKER_QUEUES: 'notify,analyze' })).toThrow(/unknown job type\(s\) analyze/);
  });
  it('every job type belongs to exactly one queue group', () => {
    const all = QUEUE_GROUP_NAMES.flatMap((g) => [...QUEUE_GROUPS[g]]);
    expect([...all].sort()).toEqual([...JOB_TYPES].sort());
    expect(new Set(all).size).toBe(all.length);
    for (const t of JOB_TYPES) expect(QUEUE_GROUPS[queueGroupOf(t)]).toContain(t);
  });
  it('Garage bootstrap settings are optional', () => {
    const env = loadEnv(base);
    expect(env.GARAGE_ADMIN_URL).toBeUndefined();
    expect(env.GARAGE_BOOTSTRAP_ATTEMPTS).toBe(60);
    expect(loadEnv({ ...base, GARAGE_ADMIN_URL: 'http://garage:3903' }).GARAGE_ADMIN_URL).toBe('http://garage:3903');
  });
});
