import { describe, expect, it } from 'vitest';
import { loadEnv } from './config.js';

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
});
