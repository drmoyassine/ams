import type { z } from 'zod';
import type {
  ImportResultSchema, Me, NewVersionResultSchema, NoteSchema, RequirementDetailSchema, RequirementSchema, SourceDocumentSchema,
  SourcePageSchema, TemplateSchema, ValidationResultSchema, VersionSchema, FrameworkListItemSchema,
} from '@ams/shared';
import { api as defaultApi, type createApi } from './api';

export type Api = ReturnType<typeof createApi>;
export type FrameworkListItem = z.infer<typeof FrameworkListItemSchema>;
export type Version = z.infer<typeof VersionSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type Note = z.infer<typeof NoteSchema>;
export type Template = z.infer<typeof TemplateSchema>;
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
export type SourcePage = z.infer<typeof SourcePageSchema>;
export type RequirementDetail = z.infer<typeof RequirementDetailSchema>;
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
export type ImportResult = z.infer<typeof ImportResultSchema>;
export type NewVersionResult = z.infer<typeof NewVersionResultSchema>;
export type Issue = { path: string; message: string };

/** An API refusal with its rule message and, for validation, every issue the server found. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly issues: Issue[] = []) {
    super(message);
  }
}

export async function unwrap<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) as { error?: string; message?: string; issues?: Issue[] } : null;
  if (!res.ok) throw new ApiError(res.status, body?.message ?? body?.error ?? `HTTP ${res.status}`, body?.issues ?? []);
  return body as T;
}

/** All framework-library calls, through the typed client. */
export function frameworkApi(api: Api = defaultApi) {
  const v = api.api['framework-versions'];
  return {
    me: () => api.api.me.$get().then((r) => unwrap<Me>(r)),
    frameworks: () => api.api.frameworks.$get().then((r) => unwrap<FrameworkListItem[]>(r)),
    versions: (frameworkId: string) => api.api.frameworks[':id'].versions.$get({ param: { id: frameworkId } }).then((r) => unwrap<Version[]>(r)),
    createAccreditor: (json: { name: string; shortName: string; type: 'institutional' | 'programmatic' | 'regulatory' }) =>
      api.api.accreditors.$post({ json }).then((r) => unwrap<{ id: string }>(r)),
    createFramework: (json: { accreditorId: string; name: string; scope: 'institution' | 'program' | 'both' }) =>
      api.api.frameworks.$post({ json }).then((r) => unwrap<{ id: string }>(r)),
    createVersion: (frameworkId: string, json: { edition: string; changeSummary?: string }) =>
      api.api.frameworks[':id'].versions.$post({ param: { id: frameworkId }, json }).then((r) => unwrap<Version>(r)),
    importFile: (json: { file: unknown; edition?: string; autoApprove?: boolean }) =>
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
    deleteRequirement: (id: string) => api.api.requirements[':id'].$delete({ param: { id } }).then((r) => unwrap<void>(r)),
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
    addDocument: (versionId: string, json: { title: string; role: 'standards' | 'policy_procedure' | 'guidance' | 'report_template' | 'evidence_guidance' | 'amendment' | 'sample_report' | 'correspondence' | 'other'; authority: 'binding' | 'interpretive' | 'informational'; filePath: string; sha256: string; language?: string }) =>
      v[':id']['source-documents'].$post({ param: { id: versionId }, json }).then((r) => unwrap<SourceDocument>(r)),
    addPage: (documentId: string, json: { pageNo: number; text: string; method: 'pdf_text' | 'ocr' }) =>
      api.api['source-documents'][':id'].pages.$post({ param: { id: documentId }, json }).then((r) => unwrap<SourcePage>(r)),
  };
}
export type FrameworkApi = ReturnType<typeof frameworkApi>;
