import { hc } from 'hono/client';
import type { SyllabusRoutes } from '@ams/api';
import type {
  CourseStaff, ResolveSuggestion, SaveSyllabus, Suggest, SyllabusContent, SyllabusListRow, SyllabusOverview, SyllabusSettings, SyllabusSuggestion, SyllabusVersion, UpsertSyllabus,
} from '@ams/shared';
import { noteResponse } from './undo';
import { unwrap } from './framework-api';

/** The course syllabus (DEC-038): a typed client of its own (SyllabusRoutes, see the API's app.ts). */
export function syllabusApi(fetcher: typeof fetch = fetch) {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetcher(input, { ...init, credentials: 'include' });
    noteResponse(res, fetcher, init?.method ?? 'GET');
    return res;
  }) as typeof fetch;
  const a = hc<SyllabusRoutes>('/', { fetch: wrapped }).api;
  return {
    overview: (courseId: string) => a.courses[':id'].syllabus.$get({ param: { id: courseId } }).then((r) => unwrap<SyllabusOverview>(r)),
    starting: (courseId: string) => a.courses[':id'].syllabus.starting.$get({ param: { id: courseId } }).then((r) => unwrap<SyllabusContent>(r)),
    save: (courseId: string, json: SaveSyllabus) => a.courses[':id'].syllabus.$put({ param: { id: courseId }, json }).then((r) => unwrap<SyllabusVersion>(r)),
    discard: (courseId: string) => a.courses[':id'].syllabus.draft.$delete({ param: { id: courseId } }).then((r) => unwrap<{ deleted: boolean }>(r)),
    upsert: (json: UpsertSyllabus) => a.syllabi.upsert.$post({ json }).then((r) => unwrap<SyllabusVersion>(r)),
    setStaff: (courseId: string, json: CourseStaff) => a.courses[':id'].staff.$put({ param: { id: courseId }, json }).then((r) => unwrap<CourseStaff>(r)),
    list: (opts: { flagged?: boolean; mine?: boolean } = {}) => a.syllabi.$get({ query: { ...(opts.flagged ? { flagged: 'true' as const } : {}), ...(opts.mine ? { mine: 'true' as const } : {}) } }).then((r) => unwrap<SyllabusListRow[]>(r)),
    escalate: () => a.syllabi.escalate.$post().then((r) => unwrap<{ notified: number }>(r)),
    suggest: (versionId: string, json: Suggest) => a['syllabus-versions'][':id'].suggestions.$post({ param: { id: versionId }, json }).then((r) => unwrap<SyllabusSuggestion>(r)),
    resolve: (suggestionId: string, json: ResolveSuggestion) => a['syllabus-suggestions'][':id'].resolve.$post({ param: { id: suggestionId }, json }).then((r) => unwrap<{ id: string; status: 'accepted' | 'declined' }>(r)),
    submit: (versionId: string) => a['syllabus-versions'][':id'].submit.$post({ param: { id: versionId } }).then((r) => unwrap<SyllabusVersion>(r)),
    return: (versionId: string, note?: string) => a['syllabus-versions'][':id'].return.$post({ param: { id: versionId }, json: { ...(note ? { note } : {}) } }).then((r) => unwrap<SyllabusVersion>(r)),
    endorse: (versionId: string) => a['syllabus-versions'][':id'].endorse.$post({ param: { id: versionId } }).then((r) => unwrap<SyllabusVersion>(r)),
    approve: (versionId: string, effectiveFrom?: string) => a['syllabus-versions'][':id'].approve.$post({ param: { id: versionId }, json: { ...(effectiveFrom ? { effectiveFrom } : {}) } }).then((r) => unwrap<SyllabusVersion>(r)),
    settings: () => a.settings.syllabus.$get().then((r) => unwrap<SyllabusSettings>(r)),
    setSettings: (json: SyllabusSettings) => a.settings.syllabus.$put({ json }).then((r) => unwrap<SyllabusSettings>(r)),
  };
}
export type SyllabusApi = ReturnType<typeof syllabusApi>;
let defaultSyllabusApi: SyllabusApi | null = null;
export const useSyllabusApi = (override?: SyllabusApi) => override ?? (defaultSyllabusApi ??= syllabusApi());
