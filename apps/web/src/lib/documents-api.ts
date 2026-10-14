import type {
  DecideProposals, DocScopeInfo, DocumentFilters, DocumentList, DocumentRow, ImportApplyPreview, ImportApplyResult, ImportPage, ImportProposal, ImportProposalList, ImportReport,
  ImportRun, ImportTargetInfo, Preflight, SourcePageViewSchema, DeleteResult, StartImport,
} from '@ams/shared';
import type { z } from 'zod';
import { api as defaultApi } from './api';
import { readBytes } from './read-bytes';
import { unwrap, type Api } from './framework-api';

export type DocumentPageView = z.infer<typeof SourcePageViewSchema>;
export type { DocScopeInfo, DocumentFilters, DocumentList, DocumentRow, ImportApplyPreview, ImportApplyResult, ImportPage, ImportProposal, ImportProposalList, ImportReport, ImportRun, ImportTargetInfo };

/** A place that has a Docs tab: its kind and, for the places that have one, its id. */
export interface DocScopeRef { kind: DocumentRow['scopeKind']; id: string | null }

const scopeQuery = (s: DocScopeRef) => ({ scopeKind: s.kind, ...(s.id ? { scopeId: s.id } : {}) });

/** Documents and AI-import calls (TASK-075), through the typed client. One set serves every Docs tab. */
export function documentsApi(api: Api = defaultApi, fetcher: typeof fetch = fetch) {
  const d = api.api.documents;
  const i = api.api.imports;
  return {
    list: (s: DocScopeRef) => d.$get({ query: scopeQuery(s) }).then((r) => unwrap<DocumentRow[]>(r)),
    scopeInfo: (s: DocScopeRef) => api.api['document-scopes'].$get({ query: scopeQuery(s) }).then((r) => unwrap<DocScopeInfo>(r)),
    /** Settings -> Documents: everything the person may see, with filters. */
    library: (filters: DocumentFilters = {}) => api.api['document-library'].$get({ query: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as DocumentFilters }).then((r) => unwrap<DocumentList>(r)),
    /** Uploads one file (the request body is the file). Resolves with the stored row; rejects with the server's reason. */
    upload: async (s: DocScopeRef, file: File, language?: string) =>
      fetcher(`/api/documents/upload?${new URLSearchParams({ scopeKind: s.kind, ...(s.id ? { scopeId: s.id } : {}), fileName: file.name, ...(language ? { language } : {}) })}`, {
        method: 'POST', body: await readBytes(file), headers: { 'content-type': file.type || 'application/octet-stream' }, credentials: 'include',
      }).then((r) => unwrap<DocumentRow>(r)),
    fileUrl: (id: string) => `/api/documents/${id}/file`,
    read: (id: string) => d[':id'].read.$post({ param: { id } }).then((r) => unwrap<{ jobId: string; status: string }>(r)),
    remove: (id: string) => d[':id'].$delete({ param: { id } }).then((r) => unwrap<DeleteResult>(r)),
    pages: (id: string) => d[':id'].pages.$get({ param: { id } }).then((r) => unwrap<ImportPage[]>(r)),
    pageView: (id: string, pageNo: number, quote?: string) =>
      d[':id'].pages[':pageNo'].view.$get({ param: { id, pageNo: String(pageNo) }, query: quote ? { quote } : {} }).then((r) => unwrap<DocumentPageView>(r)),

    targets: (s: DocScopeRef) => i.targets.$get({ query: scopeQuery(s) }).then((r) => unwrap<ImportTargetInfo[]>(r)),
    preflight: (s: DocScopeRef, targetKind: string) => i.preflight.$get({ query: { ...scopeQuery(s), targetKind } }).then((r) => unwrap<Preflight>(r)),
    runs: (s: DocScopeRef) => i.$get({ query: scopeQuery(s) }).then((r) => unwrap<ImportRun[]>(r)),
    start: (json: StartImport) => i.$post({ json }).then((r) => unwrap<ImportRun>(r)),
    run: (id: string) => i[':id'].$get({ param: { id } }).then((r) => unwrap<ImportRun>(r)),
    cancel: (id: string) => i[':id'].cancel.$post({ param: { id } }).then((r) => unwrap<ImportRun>(r)),
    report: (id: string) => i[':id'].report.$get({ param: { id } }).then((r) => unwrap<ImportReport>(r)),
    proposals: (id: string) => i[':id'].proposals.$get({ param: { id } }).then((r) => unwrap<ImportProposalList>(r)),
    decide: (id: string, json: DecideProposals) => i[':id'].proposals.decide.$post({ param: { id }, json }).then((r) => unwrap<{ changed: number }>(r)),
    editProposal: (id: string, payload: unknown) => api.api['import-proposals'][':id'].$patch({ param: { id }, json: { payload } }).then((r) => unwrap<ImportProposal>(r)),
    applyPreview: (id: string) => i[':id']['apply-preview'].$get({ param: { id } }).then((r) => unwrap<ImportApplyPreview>(r)),
    apply: (id: string) => i[':id'].apply.$post({ param: { id } }).then((r) => unwrap<ImportApplyResult>(r)),
    /** The descriptors the Undo and Redo buttons send (the same ones the toast uses). */
    undoDescriptor: (applyId: string, label: string) => ({ label, method: 'POST' as const, path: `/api/import-applies/${applyId}/undo` }),
    redoDescriptor: (applyId: string, label: string) => ({ label, method: 'POST' as const, path: `/api/import-applies/${applyId}/redo` }),
    /** The fetch this client uses, so an Undo is sent the way everything else is. */
    fetcher,
  };
}
export type DocumentsApi = ReturnType<typeof documentsApi>;

let shared: DocumentsApi | undefined;
/** The default client, made on first use (no work at import time). */
export const useDocumentsApi = (override?: DocumentsApi): DocumentsApi => override ?? (shared ??= documentsApi());
