import type {
  CreateEvidence, CreateEvidenceRequest, EvidenceRequest, IssuedRequest, RequestByLink, EvidenceDetail, EvidenceItem, EvidenceLink, EvidenceSuggestion, EvidenceVersion, LinkEvidence, ReviewLink, UpdateEvidence,
} from '@ams/shared';
import { api as defaultApi } from './api';
import { unwrap, type Api } from './framework-api';

/** The file's bytes (the upload body). FileReader where Blob.arrayBuffer is missing. */
function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error ?? new Error('could not read the file'));
    r.readAsArrayBuffer(file);
  });
}

/** Evidence calls through the typed client; the file itself goes up as the request body. */
export function evidenceApi(api: Api = defaultApi, fetcher: typeof fetch = fetch) {
  const ev = api.api.evidence;
  return {
    list: (q?: string) => ev.$get({ query: q ? { q } : {} }).then((r) => unwrap<EvidenceItem[]>(r)),
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
    /** One-time link page: no account, so plain fetch against the link's own routes. */
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
