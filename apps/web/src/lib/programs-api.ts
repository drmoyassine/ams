import { hc } from 'hono/client';
import type { ProgramRoutes } from '@ams/api';
import type { Program, ProgramsWorkbook, UpsertProgramsResult } from '@ams/shared';
import { noteResponse } from './undo';
import { unwrap } from './framework-api';

/** Programs: one, delete (deactivate), export and import (ProgramRoutes, see the API's app.ts). List, create and update are in settings-api. */
export function programsApi(fetcher: typeof fetch = fetch) {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetcher(input, { ...init, credentials: 'include' });
    noteResponse(res, fetcher, init?.method ?? 'GET');
    return res;
  }) as typeof fetch;
  const a = hc<ProgramRoutes>('/', { fetch: wrapped }).api.programs;
  return {
    get: (id: string) => a[':id'].$get({ param: { id } }).then((r) => unwrap<Program>(r)),
    exportAll: () => a.export.$get().then((r) => unwrap<ProgramsWorkbook>(r)),
    upsert: (workbook: ProgramsWorkbook, apply: boolean) => a.upsert.$post({ json: { workbook, apply } }).then((r) => unwrap<UpsertProgramsResult>(r)),
  };
}
export type ProgramsApi = ReturnType<typeof programsApi>;
let defaultApi: ProgramsApi | null = null;
export const useProgramsApi = (override?: ProgramsApi) => override ?? (defaultApi ??= programsApi());
