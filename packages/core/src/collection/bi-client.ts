// The AMS's call to the BI (TASK-090, docs/ams-bi-contract-v0.md 3.6): `POST {BI_BASE_URL}/ams/collect`. This file is the ONE place
// the AMS speaks HTTP to the BI (DEC-011-style: one import point); everything else sees the small `BiClient` interface, and tests
// pass a fake. Nothing here reads a database, and no address is ever typed by a person: the base address and the key come from
// the server's environment and an item's `endpointKey` is only a NAME that the server resolves to a path (BI_ENDPOINTS).
import type { BiCollectRequest } from '@ams/shared';

export interface BiConfig {
  /** BI_BASE_URL, or null when the BI is not configured. */
  baseUrl: string | null;
  /** BI_API_KEY, sent as a bearer credential; null = none. */
  apiKey: string | null;
  /** BI_ENDPOINTS: endpoint name -> path on the BI. */
  endpoints: Record<string, string>;
  /** The address the BI calls back (APP_PUBLIC_URL, else APP_URL); null when unknown. */
  publicUrl: string | null;
  /** `production` forbids plain http even to localhost. */
  production: boolean;
}

export type BiCall = { url: string; apiKey: string | null; body: BiCollectRequest; timeoutMs: number };
/** 200: the BI answered with the supply itself (`body` is checked by the AMS); 202: it accepted the request and will call back. */
export type BiCallResult = { status: 200; body: unknown } | { status: 202 };

export interface BiClient {
  collect(call: BiCall): Promise<BiCallResult>;
}

/** The BI cannot be asked, or answered badly. `retryable` = trying again later may help (false for a setting that must be fixed first). */
export class BiCallError extends Error {
  constructor(message: string, readonly retryable = true) { super(message); }
}

/** What the server tells the screens and the scheduler about the BI. */
export interface BiRuntime { config: BiConfig; client: BiClient | null }

export function biConfigFromEnv(env: { BI_BASE_URL?: string | undefined; BI_API_KEY?: string | undefined; BI_ENDPOINTS?: Record<string, string> | undefined; APP_PUBLIC_URL?: string | undefined; APP_URL?: string | undefined; NODE_ENV?: string | undefined }): BiConfig {
  return {
    baseUrl: env.BI_BASE_URL?.trim() || null, apiKey: env.BI_API_KEY?.trim() || null, endpoints: env.BI_ENDPOINTS ?? {},
    publicUrl: env.APP_PUBLIC_URL?.trim() || env.APP_URL?.trim() || null, production: env.NODE_ENV === 'production',
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The address to POST to: the base address plus the path of the item's endpoint name (default `/ams/collect`). HTTPS only; plain http is
 * allowed to localhost outside production (tests, a developer's BI). A name the server does not know is refused, not guessed.
 */
export function resolveBiUrl(config: BiConfig, endpointKey: string | undefined): string {
  if (!config.baseUrl) throw new BiCallError('The BI is not configured: set BI_BASE_URL (and BI_API_KEY) on the server.', false);
  let base: URL;
  try { base = new URL(config.baseUrl); } catch { throw new BiCallError('BI_BASE_URL is not a valid address.', false); }
  const secure = base.protocol === 'https:' || (base.protocol === 'http:' && !config.production && LOOPBACK.has(base.hostname));
  if (!secure) throw new BiCallError('BI_BASE_URL must be an https address (http is allowed only to localhost, and never in production).', false);
  let path = '/ams/collect';
  if (endpointKey) {
    const p = config.endpoints[endpointKey];
    if (!p) throw new BiCallError(`The BI endpoint "${endpointKey}" is not configured on the server (BI_ENDPOINTS).`, false);
    path = p;
  }
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}${path}`;
}

/** The real client: `fetch` with a timeout. A timeout, a refusal or any non-200/202 answer is a `BiCallError` (retryable). */
export function httpBiClient(fetcher: typeof fetch = fetch): BiClient {
  return {
    async collect({ url, apiKey, body, timeoutMs }) {
      let res: Response;
      try {
        res = await fetcher(url, {
          method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        });
      } catch (e) {
        const err = e as { name?: string; message?: string };
        if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new BiCallError(`The BI did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
        throw new BiCallError(`The BI could not be reached: ${err.message ?? String(e)}`);
      }
      if (res.status === 202) return { status: 202 };
      if (res.status === 200) {
        try { return { status: 200, body: await res.json() }; } catch { throw new BiCallError('The BI answered 200 with a body that is not JSON.'); }
      }
      const text = await res.text().catch(() => '');
      throw new BiCallError(`The BI answered ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    },
  };
}

export const biRuntimeFromEnv = (env: Parameters<typeof biConfigFromEnv>[0]): BiRuntime => ({ config: biConfigFromEnv(env), client: httpBiClient() });
