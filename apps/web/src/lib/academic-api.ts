import { hc } from 'hono/client';
import type { CourseRoutes } from '@ams/api';
import type { AcademicExport, AcademicWorkbook, UpsertAcademicResult } from '@ams/shared';
import { noteResponse } from './undo';
import { unwrap } from './framework-api';

/** The academic workbook (DEC-045): every program and course as one export, and one import of both (CourseRoutes, see the API's app.ts). */
export function academicApi(fetcher: typeof fetch = fetch) {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetcher(input, { ...init, credentials: 'include' });
    noteResponse(res, fetcher, init?.method ?? 'GET');
    return res;
  }) as typeof fetch;
  const a = hc<CourseRoutes>('/', { fetch: wrapped }).api;
  return {
    exportAll: () => a['academic-workbook'].$get().then((r) => unwrap<AcademicExport>(r)),
    upsert: (workbook: AcademicWorkbook, apply: boolean) => a['academic-workbook'].$post({ json: { workbook, apply } }).then((r) => unwrap<UpsertAcademicResult>(r)),
  };
}
export type AcademicApi = ReturnType<typeof academicApi>;
let defaultApi: AcademicApi | null = null;
export const useAcademicApi = (override?: AcademicApi) => override ?? (defaultApi ??= academicApi());
