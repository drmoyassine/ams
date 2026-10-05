import { hc } from 'hono/client';
import type { ApiRoutes } from '@ams/api';

/** Typed RPC client: paths, inputs and outputs are inferred from the API's route definitions. */
export const createApi = (fetcher: typeof fetch = fetch) =>
  hc<ApiRoutes>('/', { fetch: ((input: RequestInfo | URL, init?: RequestInit) => fetcher(input, { ...init, credentials: 'include' })) as typeof fetch });

export const api = createApi();
