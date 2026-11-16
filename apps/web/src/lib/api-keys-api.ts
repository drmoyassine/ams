import { hc } from 'hono/client';
import type { ApiKeyRoutes } from '@ams/api';
import type { ApiKey, CreateApiKey, IssuedApiKey } from '@ams/shared';
import { noteResponse } from './undo';
import { unwrap } from './framework-api';

/** API keys (DEC-040): a typed client of its own (ApiKeyRoutes, see the API's app.ts). */
export function apiKeysApi(fetcher: typeof fetch = fetch) {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetcher(input, { ...init, credentials: 'include' });
    noteResponse(res, fetcher, init?.method ?? 'GET');
    return res;
  }) as typeof fetch;
  const a = hc<ApiKeyRoutes>('/', { fetch: wrapped }).api.settings['api-keys'];
  return {
    list: () => a.$get().then((r) => unwrap<ApiKey[]>(r)),
    create: (json: CreateApiKey) => a.$post({ json }).then((r) => unwrap<IssuedApiKey>(r)),
    revoke: (id: string) => a[':id'].revoke.$post({ param: { id } }).then((r) => unwrap<ApiKey>(r)),
  };
}
export type ApiKeysApi = ReturnType<typeof apiKeysApi>;
let defaultApi: ApiKeysApi | null = null;
export const useApiKeysApi = (override?: ApiKeysApi) => override ?? (defaultApi ??= apiKeysApi());
