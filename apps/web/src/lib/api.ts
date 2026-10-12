import { hc } from 'hono/client';
import type { ApiRoutes } from '@ams/api';
import { noteResponse } from './undo';

/**
 * Typed RPC client: paths, inputs and outputs are inferred from the API's route definitions. Every response passes through
 * the undo bus: a mutation that can be taken back says how in its `X-Undo` header (DEC-026), which becomes the "Undo" toast.
 */
export const createApi = (fetcher: typeof fetch = fetch) => {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetcher(input, { ...init, credentials: 'include' });
    noteResponse(res, fetcher, init?.method ?? (input instanceof Request ? input.method : 'GET'));
    return res;
  }) as typeof fetch;
  return hc<ApiRoutes>('/', { fetch: wrapped });
};

export const api = createApi();
