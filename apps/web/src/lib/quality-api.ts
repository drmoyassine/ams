import { hc } from 'hono/client';
import type { QualityRoutes } from '@ams/api';
import type {
  DecideSubmission, OpenSubmission, QualityTabDetail, QualityTabs, RequirementQuality, SaveSubmissionEvidence, SetRequirementApproval, SetRequirementFrequency, SubmissionDetail,
} from '@ams/shared';
import { noteResponse } from './undo';
import { unwrap } from './framework-api';

/** Quality Management as the IQF in operation (DEC-048): tabs, submissions and their approval; a standard's frequency and approval steps (QualityRoutes). */
export function qualityApi(fetcher: typeof fetch = fetch) {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetcher(input, { ...init, credentials: 'include' });
    noteResponse(res, fetcher, init?.method ?? 'GET');
    return res;
  }) as typeof fetch;
  const a = hc<QualityRoutes>('/', { fetch: wrapped }).api.quality;
  return {
    tabs: () => a.tabs.$get().then((r) => unwrap<QualityTabs>(r)),
    tab: (code: string, period?: string) => a.tabs[':code'].$get({ param: { code }, query: period ? { period } : {} }).then((r) => unwrap<QualityTabDetail>(r)),
    submission: (q: OpenSubmission) => a.submission.$get({ query: { frameworkId: q.frameworkId, code: q.code, subjectKind: q.subjectKind, periodKey: q.periodKey, ...(q.subjectId ? { subjectId: q.subjectId } : {}) } }).then((r) => unwrap<SubmissionDetail>(r)),
    open: (json: OpenSubmission) => a.submissions.$post({ json }).then((r) => unwrap<SubmissionDetail>(r)),
    saveEvidence: (id: string, json: SaveSubmissionEvidence) => a.submissions[':id'].evidence.$put({ param: { id }, json }).then((r) => unwrap<SubmissionDetail>(r)),
    submit: (id: string) => a.submissions[':id'].submit.$post({ param: { id } }).then((r) => unwrap<SubmissionDetail>(r)),
    decide: (id: string, json: DecideSubmission) => a.submissions[':id'].decision.$post({ param: { id }, json }).then((r) => unwrap<SubmissionDetail>(r)),
    requirements: (versionId: string, frameworkId: string) => a.requirements.$get({ query: { versionId, frameworkId } }).then((r) => unwrap<RequirementQuality[]>(r)),
    setFrequency: (json: SetRequirementFrequency) => a.frequency.$put({ json }).then((r) => unwrap<{ ok: boolean }>(r)),
    setApproval: (json: SetRequirementApproval) => a.approval.$put({ json }).then((r) => unwrap<{ ok: boolean }>(r)),
    office: () => a.office.$get().then((r) => unwrap<{ unitId: string | null }>(r)),
    setOffice: (unitId: string | null) => a.office.$put({ json: { unitId } }).then((r) => unwrap<{ unitId: string | null }>(r)),
  };
}
export type QualityApi = ReturnType<typeof qualityApi>;
let defaultApi: QualityApi | null = null;
export const useQualityApi = (override?: QualityApi) => override ?? (defaultApi ??= qualityApi());
