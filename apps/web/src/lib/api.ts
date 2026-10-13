import { hc } from 'hono/client';
import type { ApiRoutes } from '@ams/api';
import { noteResponse } from './undo';

/**
 * Typed RPC client: paths, inputs and outputs are inferred from the API's route definitions. Every response passes through
 * the undo bus: a mutation that can be taken back says how in its `X-Undo` header (DEC-026), which becomes the "Undo" toast.
 */
const fetchers = new WeakMap<object, typeof fetch>();
/** The fetch a client was made with (so a button can send an Undo / Redo the same way the client sends everything else). */
export const fetcherOf = (client: object): typeof fetch => fetchers.get(client) ?? fetch;

/** The typed client. Named here because the route set is now too large for the compiler to write its inferred type out. */
export type ApiClient = ReturnType<typeof hc<ApiRoutes>>;

export const createApi = (fetcher: typeof fetch = fetch): ApiClient => {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetcher(input, { ...init, credentials: 'include' });
    noteResponse(res, fetcher, init?.method ?? (input instanceof Request ? input.method : 'GET'));
    return res;
  }) as typeof fetch;
  const client = hc<ApiRoutes>('/', { fetch: wrapped });
  fetchers.set(client, fetcher);
  return client;
};

export const api: ApiClient = createApi();
