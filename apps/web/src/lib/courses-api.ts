import { hc } from 'hono/client';
import type { CourseRoutes } from '@ams/api';
import type { Course, CoursesExport, CoursesWorkbook, UpsertCoursesResult } from '@ams/shared';
import { noteResponse } from './undo';
import { unwrap } from './framework-api';

/** Courses: delete (deactivate), and the courses workbook (CourseRoutes, see the API's app.ts). List, create and update are in outcomes-api. */
export function coursesApi(fetcher: typeof fetch = fetch) {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetcher(input, { ...init, credentials: 'include' });
    noteResponse(res, fetcher, init?.method ?? 'GET');
    return res;
  }) as typeof fetch;
  const a = hc<CourseRoutes>('/', { fetch: wrapped }).api;
  return {
    remove: (id: string) => a.courses[':id'].$delete({ param: { id } }).then((r) => unwrap<Course>(r)),
    exportAll: () => a['courses-workbook'].$get().then((r) => unwrap<CoursesExport>(r)),
    upsert: (workbook: CoursesWorkbook, apply: boolean) => a['courses-workbook'].$post({ json: { workbook, apply } }).then((r) => unwrap<UpsertCoursesResult>(r)),
  };
}
export type CoursesApi = ReturnType<typeof coursesApi>;
let defaultApi: CoursesApi | null = null;
export const useCoursesApi = (override?: CoursesApi) => override ?? (defaultApi ??= coursesApi());
