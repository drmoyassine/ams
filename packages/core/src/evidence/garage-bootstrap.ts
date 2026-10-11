// Prepares a single-node Garage for the app: assign the layout, import the S3 key the app is configured with, create the
// bucket and grant the key access (Garage admin API v1, the version pinned in compose.yaml). Idempotent: every step first
// checks whether it is already done, so it is safe on every start and redeploy. It runs in the API's startup, before it
// serves, and only when GARAGE_ADMIN_URL is set (any other S3 host is left alone). DEC-008: plain HTTP + env, no SDK.
import type { Env } from '@ams/shared';

export class GarageBootstrapError extends Error {
  override readonly name = 'GarageBootstrapError';
}

export interface GarageBootstrapOptions {
  adminUrl: string;
  adminToken: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** How many times to ask for the node's status while Garage starts (default 60). */
  attempts?: number;
  /** Pause between those attempts, and between retries of a call that got no answer (default 2000 ms). */
  delayMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface GarageBootstrapResult {
  layout: 'applied' | 'present';
  key: 'imported' | 'present';
  bucket: 'created' | 'present';
}

interface Answer { status: number; json: unknown; text: string }
const NETWORK_RETRIES = 5;

export async function bootstrapGarage(opts: GarageBootstrapOptions): Promise<GarageBootstrapResult> {
  const { adminUrl, adminToken, accessKeyId: keyId, secretAccessKey: secret, bucket } = opts;
  const attempts = opts.attempts ?? 60;
  const delayMs = opts.delayMs ?? 2000;
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => undefined);
  const base = adminUrl.replace(/\/+$/, '');

  if (!/^GK[0-9a-f]{24}$/.test(keyId) || !/^[0-9a-f]{64}$/.test(secret)) {
    throw new GarageBootstrapError(
      'Garage keys must look like GK + 24 hex characters (S3_ACCESS_KEY_ID) and 64 hex characters (S3_SECRET_ACCESS_KEY); see .env.example',
    );
  }

  const safeJson = (t: string): unknown => { try { return JSON.parse(t); } catch { return t; } };
  /** One admin API call. Returns whatever Garage answered; throws only when there was no answer. */
  async function raw(method: string, path: string, body?: unknown): Promise<Answer> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? safeJson(text) : null, text };
  }
  /** Like raw, but a status outside `ok` is an error showing what Garage answered; no answer at all is retried. */
  async function call(method: string, path: string, body?: unknown, ok: number[] = [200]): Promise<Answer> {
    let last: unknown;
    for (let attempt = 1; attempt <= NETWORK_RETRIES; attempt++) {
      let r: Answer;
      try {
        r = await raw(method, path, body);
      } catch (e) {
        last = e;
        log(`${method} ${path} failed (${(e as Error).message}); retry ${attempt}/${NETWORK_RETRIES}`);
        await sleep(delayMs);
        continue;
      }
      if (!ok.includes(r.status)) throw new GarageBootstrapError(`Garage refused ${method} ${path}: ${r.status} ${r.text}`);
      return r;
    }
    throw new GarageBootstrapError(`Garage did not answer ${method} ${path}: ${(last as Error | undefined)?.message ?? 'no answer'}`);
  }

  let status: { node: string } | undefined;
  for (let i = 0; i < attempts && !status; i++) {
    try {
      const r = await raw('GET', '/v1/status');
      if (r.status === 200) status = r.json as { node: string };
      else if (r.status === 401 || r.status === 403) throw new GarageBootstrapError(`Garage refused the admin token (GARAGE_ADMIN_TOKEN): ${r.status} ${r.text}`);
      else log(`status -> ${r.status}: ${r.text}`);
    } catch (e) {
      if (e instanceof GarageBootstrapError) throw e;
      log(`waiting for the Garage admin API: ${(e as Error).message}`);
    }
    if (!status && i + 1 < attempts) await sleep(delayMs);
  }
  if (!status) throw new GarageBootstrapError(`The Garage admin API at ${base} did not become ready after ${attempts} attempts`);

  const layout = (await call('GET', '/v1/layout')).json as { version?: number; roles?: unknown[] };
  log(`connected to node ${status.node}, layout version ${layout.version ?? 0}, ${layout.roles?.length ?? 0} role(s)`);
  const result: GarageBootstrapResult = { layout: 'present', key: 'present', bucket: 'present' };

  if (!layout.roles?.length) {
    await call('POST', '/v1/layout', [{ id: status.node, zone: 'dc1', capacity: 1073741824, tags: [] }]);
    await call('POST', '/v1/layout/apply', { version: (layout.version ?? 0) + 1 });
    result.layout = 'applied';
    log('layout applied');
  }

  if ((await raw('GET', `/v1/key?id=${encodeURIComponent(keyId)}`)).status !== 200) {
    await call('POST', '/v1/key/import', { accessKeyId: keyId, secretAccessKey: secret, name: 'ams' });
    result.key = 'imported';
    log('access key imported');
  }

  let info = await raw('GET', `/v1/bucket?globalAlias=${encodeURIComponent(bucket)}`);
  if (info.status !== 200) {
    info = await call('POST', '/v1/bucket', { globalAlias: bucket });
    result.bucket = 'created';
    log('bucket created');
  }
  // Granting is repeatable; it makes the key's rights right even if the bucket was made by hand.
  await call('POST', '/v1/bucket/allow', {
    bucketId: (info.json as { id: string }).id, accessKeyId: keyId, permissions: { read: true, write: true, owner: true },
  });
  log(`garage ready: bucket ${bucket}`);
  return result;
}

/**
 * The app's startup step: bootstraps Garage when GARAGE_ADMIN_URL is set, does nothing otherwise. A configured but failing
 * bootstrap throws, so the app does not start half-configured.
 */
export async function bootstrapGarageFromEnv(
  env: Pick<Env, 'GARAGE_ADMIN_URL' | 'GARAGE_ADMIN_TOKEN' | 'GARAGE_BOOTSTRAP_ATTEMPTS' | 'GARAGE_BOOTSTRAP_DELAY_MS' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_BUCKET'>,
  deps: Pick<GarageBootstrapOptions, 'fetch' | 'sleep' | 'log'> = {},
): Promise<GarageBootstrapResult | null> {
  if (!env.GARAGE_ADMIN_URL) return null;
  if (!env.GARAGE_ADMIN_TOKEN) throw new GarageBootstrapError('GARAGE_ADMIN_URL is set, so GARAGE_ADMIN_TOKEN is required');
  return bootstrapGarage({
    adminUrl: env.GARAGE_ADMIN_URL, adminToken: env.GARAGE_ADMIN_TOKEN,
    accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, bucket: env.S3_BUCKET,
    attempts: env.GARAGE_BOOTSTRAP_ATTEMPTS, delayMs: env.GARAGE_BOOTSTRAP_DELAY_MS, ...deps,
  });
}
