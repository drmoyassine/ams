// Reports through the typed client (TASK-091/092). Reads need report:read, writes report:write, managing report:manage —
// the server decides; these calls only carry the shapes. The attestation letter goes up as the request body.
import type { CreateReport, DeleteResult, ReportDetail, ReportFilter, ReportSummary, SetSectionOwner, UpdateSectionContent } from '@ams/shared';
import { api as defaultApi } from './api';
import { unwrap, type Api } from './framework-api';
import { readBytes } from './read-bytes';

export function reportApi(api: Api = defaultApi, fetcher: typeof fetch = fetch) {
  const rp = api.api.reports;
  return {
    list: (query: ReportFilter = {}) => rp.$get({ query: query as Record<string, string> }).then((r) => unwrap<ReportSummary[]>(r)),
    create: (json: CreateReport) => rp.$post({ json }).then((r) => unwrap<ReportDetail>(r)),
    get: (id: string) => rp[':id'].$get({ param: { id } }).then((r) => unwrap<ReportDetail>(r)),
    rename: (id: string, title: string) => rp[':id'].$patch({ param: { id }, json: { title } }).then((r) => unwrap<ReportDetail>(r)),
    remove: (id: string) => rp[':id'].$delete({ param: { id } }).then((r) => unwrap<DeleteResult>(r)),
    saveContent: (id: string, sectionId: string, json: UpdateSectionContent) =>
      rp[':id'].sections[':sectionId'].content.$patch({ param: { id, sectionId }, json }).then((r) => unwrap<ReportDetail>(r)),
    setOwner: (id: string, sectionId: string, json: SetSectionOwner) =>
      rp[':id'].sections[':sectionId'].owner.$patch({ param: { id, sectionId }, json }).then((r) => unwrap<ReportDetail>(r)),
    uploadLetter: async (id: string, sectionId: string, file: File) => {
      const query = new URLSearchParams({ fileName: file.name });
      return fetcher(`/api/reports/${id}/sections/${sectionId}/attestation?${query}`, {
        method: 'POST', body: await readBytes(file), headers: { 'content-type': file.type || 'application/octet-stream' }, credentials: 'include',
      }).then((r) => unwrap<ReportDetail>(r));
    },
  };
}
export type ReportApi = ReturnType<typeof reportApi>;
export const defaultReportApi = reportApi();
export const useReportApi = (override?: ReportApi) => override ?? defaultReportApi;
