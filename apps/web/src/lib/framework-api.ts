import type { z } from 'zod';
import type {
  DeletePreview, DeleteResult, MoveManyInput, AcceptCoversResult, AcceptIqfProposal, AnalysisReport, AnalysisRun, ImportResultSchema, IqfItemProposal, IqfProposals, Me, NewVersionResultSchema, Preflight, NoteSchema, RequirementDetailSchema, RequirementSchema, SourceDocumentSchema,
  SourcePageSchema, SourcePageViewSchema, ReviewItemsSchema, StandardFromFilesSchema, SourceLimitsSchema, MergeResultSchema, SplitResultSchema, TemplateSchema, QualityFrameworkSchema, MappingsSchema, MappingSchema, ValidationResultSchema, VersionSchema, FrameworkListItemSchema,
} from '@ams/shared';
import { readBytes } from './read-bytes';
import { documentsApi } from './documents-api';
import { api as defaultApi, type createApi } from './api';

export type Api = ReturnType<typeof createApi>;
export type FrameworkListItem = z.infer<typeof FrameworkListItemSchema>;
export type Version = z.infer<typeof VersionSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type Note = z.infer<typeof NoteSchema>;
export type Template = z.infer<typeof TemplateSchema>;
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
export type SourcePage = z.infer<typeof SourcePageSchema>;
export type SourcePageView = z.infer<typeof SourcePageViewSchema>;
export type ReviewItems = z.infer<typeof ReviewItemsSchema>;
export type StandardFromFiles = z.infer<typeof StandardFromFilesSchema>;
export type SourceLimits = z.infer<typeof SourceLimitsSchema>;
export type MergeResult = z.infer<typeof MergeResultSchema>;
export type SplitResult = z.infer<typeof SplitResultSchema>;
export type RequirementDetail = z.infer<typeof RequirementDetailSchema>;
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
export type ImportResult = z.infer<typeof ImportResultSchema>;
export type NewVersionResult = z.infer<typeof NewVersionResultSchema>;
export type QualityFramework = z.infer<typeof QualityFrameworkSchema>;
export type Mappings = z.infer<typeof MappingsSchema>;
export type Mapping = z.infer<typeof MappingSchema>;
export type MoveResult = { moved: number; changed: number; unchanged: boolean };
export type Issue = { path: string; message: string };
export type { AnalysisReport, AnalysisRun, Preflight, AcceptCoversResult, AcceptIqfProposal, IqfItemProposal, IqfProposals };

/** An API refusal with its rule message and, for validation, every issue the server found. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly issues: Issue[] = [], readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export async function unwrap<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) as { error?: string; message?: string; issues?: Issue[]; details?: Record<string, unknown> } : null;
  if (!res.ok) throw new ApiError(res.status, body?.message ?? body?.error ?? `HTTP ${res.status}`, body?.issues ?? [], body?.details);
  return body as T;
}

/** All framework-library calls, through the typed client. */
export function frameworkApi(api: Api = defaultApi, fetcher: typeof fetch = fetch) {
  const v = api.api['framework-versions'];
  return {
    /** Documents and AI import (the Docs tab, TASK-075), through the same client. */
    docs: documentsApi(api, fetcher),
    me: () => api.api.me.$get().then((r) => unwrap<Me>(r)),
    /** Where an accreditor's logo is served; `version` changes when the logo does, so the browser fetches the new one. */
    logoUrl: (accreditorId: string, version: string) => `/api/accreditors/${accreditorId}/logo?v=${version}`,
    uploadLogo: async (accreditorId: string, file: File) => {
      const body = await readBytes(file);
      return fetcher(`/api/accreditors/${accreditorId}/logo`, { method: 'PUT', body, headers: { 'content-type': file.type || 'application/octet-stream' }, credentials: 'include' }).then((r) => unwrap<void>(r));
    },
    removeLogo: (accreditorId: string) => api.api.accreditors[':id'].logo.$delete({ param: { id: accreditorId } }).then((r) => unwrap<void>(r)),
    framework: (id: string) => api.api.frameworks[':id'].$get({ param: { id } }).then((r) => unwrap<FrameworkListItem>(r)),
    updateFramework: (id: string, json: { name?: string; scope?: 'institution' | 'program' | 'both'; description?: string | null }) =>
      api.api.frameworks[':id'].$patch({ param: { id }, json }).then((r) => unwrap<FrameworkListItem>(r)),
    updateAccreditor: (id: string, json: { name?: string; shortName?: string; type?: 'institutional' | 'programmatic' | 'regulatory'; country?: string | null; website?: string | null }) =>
      api.api.accreditors[':id'].$patch({ param: { id }, json }).then((r) => unwrap<unknown>(r)),
    frameworks: () => api.api.frameworks.$get().then((r) => unwrap<FrameworkListItem[]>(r)),
    versions: (frameworkId: string) => api.api.frameworks[':id'].versions.$get({ param: { id: frameworkId } }).then((r) => unwrap<Version[]>(r)),
    createAccreditor: (json: { name: string; shortName: string; type: 'institutional' | 'programmatic' | 'regulatory' }) =>
      api.api.accreditors.$post({ json }).then((r) => unwrap<{ id: string }>(r)),
    createFramework: (json: { accreditorId: string; name: string; scope: 'institution' | 'program' | 'both' }) =>
      api.api.frameworks.$post({ json }).then((r) => unwrap<{ id: string }>(r)),
    createVersion: (frameworkId: string, json: { edition: string; changeSummary?: string }) =>
      api.api.frameworks[':id'].versions.$post({ param: { id: frameworkId }, json }).then((r) => unwrap<Version>(r)),
    /** "Create from files": the accreditor (new or existing), the standard, its draft and one source per file, in one request. The files are uploaded next, one by one. */
    createStandardFromFiles: (json: {
      accreditorId?: string; accreditor?: { name: string; shortName: string; type?: 'institutional' | 'programmatic' | 'regulatory'; country?: string };
      name: string; scope: 'institution' | 'program' | 'both'; edition: string; files: { name: string; size?: number }[];
    }) => v['from-files'].$post({ json }).then((r) => unwrap<StandardFromFiles>(r)),
    sourceLimits: () => api.api['source-limits'].$get().then((r) => unwrap<SourceLimits>(r)),
    qualityFramework: () => api.api['quality-framework'].$get().then((r) => unwrap<QualityFramework>(r)),
    addQualityItem: (versionId: string, json: { code: string; title: string; description?: string }) =>
      v[':id']['quality-items'].$post({ param: { id: versionId }, json }).then((r) => unwrap<Requirement>(r)),
    editQualityItem: (id: string, json: { code: string; title: string; description?: string }) =>
      api.api['quality-items'][':id'].$patch({ param: { id }, json }).then((r) => unwrap<Requirement>(r)),
    publishQuality: (versionId: string) => v[':id']['publish-quality'].$post({ param: { id: versionId } }).then((r) => unwrap<Version>(r)),
    newQualityVersion: () => api.api['quality-framework'].versions.$post().then((r) => unwrap<Version>(r)),
    applyQualityTemplate: (versionId: string) => v[':id']['quality-template'].$post({ param: { id: versionId } }).then((r) => unwrap<Requirement[]>(r)),
    setUpQualityFramework: (json: { name?: string; levelLabels?: string[]; template?: boolean }) =>
      api.api['quality-framework'].$post({ json }).then((r) => unwrap<QualityFramework>(r)),
    mappings: (versionId: string) => v[':id'].mappings.$get({ param: { id: versionId } }).then((r) => unwrap<Mappings>(r)),
    createMapping: (versionId: string, json: { externalRequirementId: string; internalRequirementId: string; relation: Mapping['relation']; rationale?: string }) =>
      v[':id'].mappings.$post({ param: { id: versionId }, json }).then((r) => unwrap<Mapping>(r)),
    updateMapping: (id: string, json: { relation?: Mapping['relation']; rationale?: string | null }) =>
      api.api.mappings[':id'].$patch({ param: { id }, json }).then((r) => unwrap<Mapping>(r)),
    reviewMapping: (id: string, decision: 'approved' | 'rejected') =>
      api.api.mappings[':id'].review.$post({ param: { id }, json: { decision } }).then((r) => unwrap<Mapping>(r)),
    /** Step E: suggested new quality framework items, accepting them, dismissing them, and accepting every suggested "covers" link of a list. */
    iqfProposals: (versionId: string) => v[':id']['iqf-proposals'].$get({ param: { id: versionId } }).then((r) => unwrap<IqfProposals>(r)),
    acceptIqfProposal: (id: string, json: AcceptIqfProposal) => api.api['iqf-proposals'][':id'].accept.$post({ param: { id }, json }).then((r) => unwrap<IqfItemProposal>(r)),
    dismissIqfProposal: (id: string) => api.api['iqf-proposals'][':id'].dismiss.$post({ param: { id } }).then((r) => unwrap<IqfItemProposal>(r)),
    acceptCovers: (versionId: string, ids: string[]) => v[':id'].mappings['accept-covers'].$post({ param: { id: versionId }, json: { ids } }).then((r) => unwrap<AcceptCoversResult>(r)),
    deleteMapping: (id: string) => api.api.mappings[':id'].$delete({ param: { id } }).then((r) => unwrap<void>(r)),
    setQualityLevels: (levelLabels: string[]) => api.api['quality-framework'].levels.$put({ json: { levelLabels } }).then((r) => unwrap<QualityFramework>(r)),
    importFile: (json: { file: unknown; edition?: string }) =>
      v.import.$post({ json }).then((r) => unwrap<ImportResult>(r)),
    version: (id: string) => v[':id'].$get({ param: { id } }).then((r) => unwrap<Version>(r)),
    validation: (id: string) => v[':id'].validation.$get({ param: { id } }).then((r) => unwrap<ValidationResult>(r)),
    patchConfig: (id: string, json: Record<string, unknown>) => v[':id'].config.$patch({ param: { id }, json }).then((r) => unwrap<Version>(r)),
    submit: (id: string) => v[':id'].submit.$post({ param: { id } }).then((r) => unwrap<Version>(r)),
    returnToDraft: (id: string) => v[':id']['return-to-draft'].$post({ param: { id } }).then((r) => unwrap<Version>(r)),
    publish: (id: string) => v[':id'].publish.$post({ param: { id } }).then((r) => unwrap<Version>(r)),
    retire: (id: string) => v[':id'].retire.$post({ param: { id } }).then((r) => unwrap<Version>(r)),
    newVersion: (id: string, json: { edition: string; changeSummary?: string }) =>
      v[':id']['new-version'].$post({ param: { id }, json }).then((r) => unwrap<NewVersionResult>(r)),
    exportFile: (id: string) => v[':id'].export.$get({ param: { id } }).then((r) => unwrap<Record<string, unknown>>(r)),

    requirements: (versionId: string) => v[':id'].requirements.$get({ param: { id: versionId } }).then((r) => unwrap<Requirement[]>(r)),
    createRequirement: (versionId: string, json: { code: string; levelLabel: string; title: string; parentId?: string | null; officialText?: string; isAssessable?: boolean; displayOrder?: number; language?: string }) =>
      v[':id'].requirements.$post({ param: { id: versionId }, json }).then((r) => unwrap<Requirement>(r)),
    requirement: (id: string) => api.api.requirements[':id'].$get({ param: { id } }).then((r) => unwrap<RequirementDetail>(r)),
    patchRequirement: (id: string, json: { code?: string; levelLabel?: string; title?: string; officialText?: string; translationEn?: string; isAssessable?: boolean; language?: string }) =>
      api.api.requirements[':id'].$patch({ param: { id }, json }).then((r) => unwrap<Requirement>(r)),
    moveRequirement: (id: string, json: { parentId: string | null; displayOrder?: number }) =>
      api.api.requirements[':id'].move.$post({ param: { id }, json }).then((r) => unwrap<Requirement>(r)),
    indentRequirement: (id: string) => api.api.requirements[':id'].indent.$post({ param: { id } }).then((r) => unwrap<Requirement>(r)),
    outdentRequirement: (id: string) => api.api.requirements[':id'].outdent.$post({ param: { id } }).then((r) => unwrap<Requirement>(r)),
    /** Several requirements in one action (drag and drop, "Move to…"): atomic, one Undo. Positions count the parent's list with every moved item taken out. */
    moveMany: (versionId: string, json: MoveManyInput) => v[':id'].requirements['move-many'].$post({ param: { id: versionId }, json }).then((r) => unwrap<MoveResult>(r)),
    deleteRequirement: (id: string) => api.api.requirements[':id'].$delete({ param: { id } }).then((r) => unwrap<void>(r)),
    /** Delete with everything under it (one or many, in one action; they go to the Trash). The question to ask first, and the delete itself. */
    previewDelete: (ids: string[]) => api.api.requirements['delete-preview'].$post({ json: { ids } }).then((r) => unwrap<DeletePreview>(r)),
    deleteMany: (ids: string[]) => api.api.requirements.delete.$post({ json: { ids } }).then((r) => unwrap<DeleteResult>(r)),
    deleteAllRequirements: (versionId: string) => v[':id'].requirements['delete-all'].$post({ param: { id: versionId } }).then((r) => unwrap<DeleteResult>(r)),
    deleteVersion: (versionId: string) => v[':id'].$delete({ param: { id: versionId } }).then((r) => unwrap<DeleteResult>(r)),
    deleteFramework: (frameworkId: string) => api.api.frameworks[':id'].$delete({ param: { id: frameworkId } }).then((r) => unwrap<DeleteResult>(r)),
    reviewRequirement: (id: string, decision: 'approved' | 'rejected') =>
      api.api.requirements[':id'].review.$post({ param: { id }, json: { decision } }).then((r) => unwrap<Requirement>(r)),

    addNote: (requirementId: string, json: { type: Note['type']; text: string; authority: 'required' | 'example' | 'suggested' | 'institution_defined'; source?: { documentId: string; page: number; quote: string } }) =>
      api.api.requirements[':id'].notes.$post({ param: { id: requirementId }, json }).then((r) => unwrap<Note>(r)),
    patchNote: (id: string, json: { text?: string; source?: { documentId: string; page: number; quote: string } | null }) =>
      api.api.notes[':id'].$patch({ param: { id }, json }).then((r) => unwrap<Note>(r)),
    setAuthority: (id: string, authority: 'required' | 'example' | 'suggested' | 'institution_defined') =>
      api.api.notes[':id'].authority.$post({ param: { id }, json: { authority } }).then((r) => unwrap<Note>(r)),
    reviewNote: (id: string, decision: 'approved' | 'rejected') =>
      api.api.notes[':id'].review.$post({ param: { id }, json: { decision } }).then((r) => unwrap<Note>(r)),
    deleteNote: (id: string) => api.api.notes[':id'].$delete({ param: { id } }).then((r) => unwrap<void>(r)),

    templates: (versionId: string) => v[':id']['report-templates'].$get({ param: { id: versionId } }).then((r) => unwrap<Template[]>(r)),
    putTemplate: (versionId: string, key: string, json: { name: string; kind: Template['kind']; language?: string; structure: unknown; requires_attestation?: boolean; word_limit?: number | null }) =>
      v[':id']['report-templates'][':key'].$put({ param: { id: versionId, key }, json }).then((r) => unwrap<Template>(r)),
    deleteTemplate: (versionId: string, key: string) => v[':id']['report-templates'][':key'].$delete({ param: { id: versionId, key } }).then((r) => unwrap<void>(r)),
    reviewTemplate: (versionId: string, key: string, decision: 'approved' | 'rejected') =>
      v[':id']['report-templates'][':key'].review.$post({ param: { id: versionId, key }, json: { decision } }).then((r) => unwrap<Template>(r)),

    documents: (versionId: string) => v[':id']['source-documents'].$get({ param: { id: versionId } }).then((r) => unwrap<SourceDocument[]>(r)),
    addDocument: (versionId: string, json: { title: string; role?: SourceRole; authority: SourceAuthority; filePath?: string; sha256?: string; language?: string }) =>
      v[':id']['source-documents'].$post({ param: { id: versionId }, json }).then((r) => unwrap<SourceDocument>(r)),
    updateDocument: (id: string, json: { title?: string; role?: SourceRole; authority?: SourceAuthority; language?: string }) =>
      api.api['source-documents'][':id'].$patch({ param: { id }, json }).then((r) => unwrap<SourceDocument>(r)),
    deleteDocument: (id: string) => api.api['source-documents'][':id'].$delete({ param: { id } }).then((r) => unwrap<void>(r)),
    /** Where a source's original is served (inline for PDFs and images). */
    sourceFileUrl: (id: string) => `/api/source-documents/${id}/file`,
    uploadSourceFile: async (id: string, file: File) => fetcher(`/api/source-documents/${id}/file?${new URLSearchParams({ fileName: file.name })}`, {
      method: 'PUT', body: await readBytes(file), headers: { 'content-type': file.type || 'application/octet-stream' }, credentials: 'include',
    }).then((r) => unwrap<SourceDocument>(r)),
    /** Queues reading the stored file into page text. */
    readFile: (id: string) => api.api['source-documents'][':id'].read.$post({ param: { id } }).then((r) => unwrap<{ jobId: string; textStatus: 'queued' }>(r)),
    pages: (id: string) => api.api['source-documents'][':id'].pages.$get({ param: { id } }).then((r) => unwrap<SourcePage[]>(r)),
    setPage: (id: string, pageNo: number, text: string) =>
      api.api['source-documents'][':id'].pages[':pageNo'].$put({ param: { id, pageNo: String(pageNo) }, json: { text } }).then((r) => unwrap<SourcePage>(r)),
    /** One page for the split view, with the stretch the quote matches (found on the server by the verifier's matcher). */
    pageView: (id: string, pageNo: number, quote?: string) =>
      api.api['source-documents'][':id'].pages[':pageNo'].view.$get({ param: { id, pageNo: String(pageNo) }, query: quote ? { quote } : {} }).then((r) => unwrap<SourcePageView>(r)),
    reviewItems: (versionId: string) => v[':id']['review-items'].$get({ param: { id: versionId } }).then((r) => unwrap<ReviewItems>(r)),
    mergeRequirement: (id: string, json: { intoId: string; useMergedWording?: boolean }) =>
      api.api.requirements[':id'].merge.$post({ param: { id }, json }).then((r) => unwrap<MergeResult>(r)),
    splitRequirement: (id: string, json: { part: string; code: string; title?: string }) =>
      api.api.requirements[':id'].split.$post({ param: { id }, json }).then((r) => unwrap<SplitResult>(r)),
    deletePage: (id: string, pageNo: number) => api.api['source-documents'][':id'].pages[':pageNo'].$delete({ param: { id, pageNo: String(pageNo) } }).then((r) => unwrap<void>(r)),
    /** Framework analysis (step C): runs over the draft's sources, newest first; start; one run; cancel. */
    analysisRuns: (versionId: string) => v[':id'].analysis.$get({ param: { id: versionId } }).then((r) => unwrap<AnalysisRun[]>(r)),
    startAnalysis: (versionId: string) => v[':id'].analysis.$post({ param: { id: versionId } }).then((r) => unwrap<AnalysisRun>(r)),
    analysisRun: (id: string) => api.api.analysis[':id'].$get({ param: { id } }).then((r) => unwrap<AnalysisRun>(r)),
    /** The intelligence report of one run, and of the version's latest finished run (null: none yet). */
    analysisReport: (id: string) => api.api.analysis[':id'].report.$get({ param: { id } }).then((r) => unwrap<AnalysisReport>(r)),
    latestAnalysisReport: (versionId: string) => v[':id'].analysis['latest-report'].$get({ param: { id: versionId } }).then((r) => unwrap<AnalysisReport | null>(r)),
    /** Can an analysis start now? The checks, and the first blocking reason. */
    analysisPreflight: (versionId: string) => v[':id'].analysis.preflight.$get({ param: { id: versionId } }).then((r) => unwrap<Preflight>(r)),
    cancelAnalysis: (id: string) => api.api.analysis[':id'].cancel.$post({ param: { id } }).then((r) => unwrap<AnalysisRun>(r)),
    addPage: (documentId: string, json: { pageNo: number; text: string; method: 'pdf_text' | 'ocr' }) =>
      api.api['source-documents'][':id'].pages.$post({ param: { id: documentId }, json }).then((r) => unwrap<SourcePage>(r)),
  };
}
export type FrameworkApi = ReturnType<typeof frameworkApi>;
export type SourceRole = 'standards' | 'policy_procedure' | 'guidance' | 'report_template' | 'evidence_guidance' | 'amendment' | 'sample_report' | 'correspondence' | 'other';
export type SourceAuthority = 'binding' | 'interpretive' | 'informational';
