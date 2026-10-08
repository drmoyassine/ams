import type {
  CreateFormRequest, DataForm, DataResponse, PublicForm, SubmitResponse,
  DatasetData, DatasetSpec, SaveDatasetRows, SaveDatasetSpec,
  CreateEvidence, CreateEvidenceRequest, EvidenceRequest, IssuedRequest, RequestByLink, EvidenceDetail, EvidenceItem, EvidenceLink, EvidenceSuggestion, EvidenceVersion, LinkEvidence, ReviewLink, UpdateEvidence,
} from '@ams/shared';
import { api as defaultApi } from './api';
import { unwrap, type Api } from './framework-api';
import { readBytes } from './read-bytes';

/** Evidence calls through the typed client; the file itself goes up as the request body. */
export function evidenceApi(api: Api = defaultApi, fetcher: typeof fetch = fetch) {
  const ev = api.api.evidence;
  return {
    /** Archived items are left out unless `includeArchived`. */
    list: (q?: string, opts: { includeArchived?: boolean } = {}) => ev.$get({ query: { ...(q ? { q } : {}), ...(opts.includeArchived ? { includeArchived: 'true' as const } : {}) } })
      .then((r) => unwrap<EvidenceItem[]>(r)),
    create: (json: CreateEvidence) => ev.$post({ json }).then((r) => unwrap<EvidenceItem>(r)),
    get: (id: string) => ev[':id'].$get({ param: { id } }).then((r) => unwrap<EvidenceDetail>(r)),
    update: (id: string, json: UpdateEvidence) => ev[':id'].$patch({ param: { id }, json }).then((r) => unwrap<EvidenceItem>(r)),
    upload: async (id: string, file: File, extra: { asOfDate?: string; notes?: string } = {}) => {
      const query = new URLSearchParams({ fileName: file.name, ...extra });
      const body = await readBytes(file);
      return fetcher(`/api/evidence/${id}/files?${query}`, { method: 'POST', body, headers: { 'content-type': file.type || 'application/octet-stream' }, credentials: 'include' })
        .then((r) => unwrap<EvidenceVersion>(r));
    },
    addUrl: (id: string, json: { url: string }) => ev[':id']['links-to-documents'].$post({ param: { id }, json }).then((r) => unwrap<EvidenceVersion>(r)),
    /** Where a stored version is served (inline for PDFs and images, a download otherwise). */
    fileUrl: (versionId: string) => `/api/evidence-versions/${versionId}/file`,

    internalLinks: (requirementId: string) => api.api.requirements[':id']['evidence-links'].$get({ param: { id: requirementId } }).then((r) => unwrap<EvidenceLink[]>(r)),
    linkInternal: (requirementId: string, json: LinkEvidence) => api.api.requirements[':id']['evidence-links'].$post({ param: { id: requirementId }, json }).then((r) => unwrap<EvidenceLink>(r)),
    requirementLinks: (erId: string) => api.api['engagement-requirements'][':id']['evidence-links'].$get({ param: { id: erId } }).then((r) => unwrap<EvidenceLink[]>(r)),
    linkRequirement: (erId: string, json: LinkEvidence) => api.api['engagement-requirements'][':id']['evidence-links'].$post({ param: { id: erId }, json }).then((r) => unwrap<EvidenceLink>(r)),
    suggestions: (erId: string) => api.api['engagement-requirements'][':id']['evidence-suggestions'].$get({ param: { id: erId } }).then((r) => unwrap<EvidenceSuggestion[]>(r)),
    review: (linkId: string, json: ReviewLink) => api.api['evidence-links'][':id'].review.$post({ param: { id: linkId }, json }).then((r) => unwrap<EvidenceLink>(r)),
    remove: (linkId: string) => api.api['evidence-links'][':id'].$delete({ param: { id: linkId } }).then((r) => unwrap<void>(r)),

    // Data (PRD 9.4)
    dataDefinition: (id: string) => ev[':id']['data-definition'].$get({ param: { id } }).then((r) => unwrap<DatasetSpec>(r)),
    saveDataDefinition: (id: string, json: SaveDatasetSpec) => ev[':id']['data-definition'].$put({ param: { id }, json }).then((r) => unwrap<DatasetSpec>(r)),
    saveData: (id: string, json: SaveDatasetRows) => ev[':id'].data.$post({ param: { id }, json }).then((r) => unwrap<EvidenceVersion>(r)),
    versionData: (versionId: string) => api.api['evidence-versions'][':id'].data.$get({ param: { id: versionId } }).then((r) => unwrap<DatasetData>(r)),

    // Forms (DEC-020)
    form: (id: string) => ev[':id'].form.$get({ param: { id } }).then((r) => unwrap<DataForm>(r)),
    setFormOpen: (id: string, open: boolean) => ev[':id'].form.open.$put({ param: { id }, json: { open } }).then((r) => unwrap<DataForm>(r)),
    newFormLink: (id: string) => ev[':id'].form.link.$post({ param: { id } }).then((r) => unwrap<DataForm>(r)),
    removeFormLink: (id: string) => ev[':id'].form.link.$delete({ param: { id } }).then((r) => unwrap<DataForm>(r)),
    formQuestions: (id: string) => ev[':id'].form.questions.$get({ param: { id } }).then((r) => unwrap<PublicForm>(r)),
    submitResponse: (id: string, json: SubmitResponse) => ev[':id'].form.responses.$post({ param: { id }, json }).then((r) => unwrap<void>(r)),
    responses: (id: string) => ev[':id'].responses.$get({ param: { id } }).then((r) => unwrap<DataResponse[]>(r)),
    addResponsesToData: (id: string) => ev[':id'].responses['add-to-data'].$post({ param: { id } }).then((r) => unwrap<EvidenceVersion>(r)),
    /** Public form link: no account, so plain fetch against the link's own routes. */
    formByLink: (token: string) => fetcher(`/api/form-links/${encodeURIComponent(token)}`).then((r) => unwrap<PublicForm>(r)),
    submitByFormLink: (token: string, json: SubmitResponse) => fetcher(`/api/form-links/${encodeURIComponent(token)}/responses`, {
      method: 'POST', body: JSON.stringify(json), headers: { 'content-type': 'application/json' },
    }).then((r) => unwrap<void>(r)),

    // Requests (DEC-018)
    internalRequests: (requirementId: string) => api.api.requirements[':id']['evidence-requests'].$get({ param: { id: requirementId } }).then((r) => unwrap<EvidenceRequest[]>(r)),
    request: (requirementId: string, json: CreateEvidenceRequest) => api.api.requirements[':id']['evidence-requests'].$post({ param: { id: requirementId }, json }).then((r) => unwrap<IssuedRequest>(r)),
    requests: (mine: boolean) => api.api['evidence-requests'].$get({ query: mine ? { mine: 'true' } : {} }).then((r) => unwrap<EvidenceRequest[]>(r)),
    cancelRequest: (id: string) => api.api['evidence-requests'][':id'].cancel.$post({ param: { id } }).then((r) => unwrap<EvidenceRequest>(r)),
    newRequestLink: (id: string) => api.api['evidence-requests'][':id']['new-link'].$post({ param: { id } }).then((r) => unwrap<IssuedRequest>(r)),
    answerRequest: async (id: string, file: File, note?: string) => {
      const query = new URLSearchParams({ fileName: file.name, ...(note ? { note } : {}) });
      return fetcher(`/api/evidence-requests/${id}/answer?${query}`, { method: 'POST', body: await readBytes(file), headers: { 'content-type': file.type || 'application/octet-stream' }, credentials: 'include' })
        .then((r) => unwrap<EvidenceRequest>(r));
    },
    formRequests: (dataItemId: string) => ev[':id'].form.requests.$get({ param: { id: dataItemId } }).then((r) => unwrap<EvidenceRequest[]>(r)),
    requestForm: (dataItemId: string, json: CreateFormRequest) => ev[':id'].form.requests.$post({ param: { id: dataItemId }, json }).then((r) => unwrap<IssuedRequest[]>(r)),
    formOfRequest: (id: string) => api.api['evidence-requests'][':id'].form.$get({ param: { id } }).then((r) => unwrap<PublicForm>(r)),
    answerWithForm: (id: string, json: SubmitResponse) => api.api['evidence-requests'][':id']['form-answer'].$post({ param: { id }, json }).then((r) => unwrap<EvidenceRequest>(r)),
    /** One-time link page: no account, so plain fetch against the link's own routes. */
    answerFormByLink: (token: string, json: SubmitResponse) => fetcher(`/api/response-links/${encodeURIComponent(token)}/form-answer`, {
      method: 'POST', body: JSON.stringify(json), headers: { 'content-type': 'application/json' },
    }).then((r) => unwrap<void>(r)),
    requestByLink: (token: string) => fetcher(`/api/response-links/${encodeURIComponent(token)}`).then((r) => unwrap<RequestByLink>(r)),
    answerByLink: async (token: string, file: File, note?: string) => {
      const query = new URLSearchParams({ fileName: file.name, ...(note ? { note } : {}) });
      return fetcher(`/api/response-links/${encodeURIComponent(token)}/answer?${query}`, { method: 'POST', body: await readBytes(file), headers: { 'content-type': file.type || 'application/octet-stream' } })
        .then((r) => unwrap<void>(r));
    },
  };
}
export type EvidenceApi = ReturnType<typeof evidenceApi>;
export const defaultEvidenceApi = evidenceApi();
export const useEvidenceApi = (override?: EvidenceApi) => override ?? defaultEvidenceApi;
