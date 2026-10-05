// Response shapes of the framework API: one definition for the OpenAPI spec, the typed client and the SPA.
import { z } from 'zod';

const iso = z.string();
const provenance = {
  origin: z.enum(['manual', 'import', 'ai']),
  sourceDocumentId: z.string().nullable(),
  sourcePage: z.number().nullable(),
  sourceQuote: z.string().nullable(),
  quoteVerified: z.boolean(),
  reviewStatus: z.enum(['pending', 'approved', 'rejected']),
  reviewedBy: z.string().nullable(),
  reviewedAt: iso.nullable(),
};

export const FrameworkListItemSchema = z.object({
  id: z.string(), name: z.string(), scope: z.enum(['institution', 'program', 'both']), commission: z.string().nullable(),
  accreditorId: z.string(), accreditorShortName: z.string(),
});
export const AccreditorSchema = z.object({
  id: z.string(), name: z.string(), shortName: z.string(), type: z.enum(['institutional', 'programmatic', 'regulatory']),
  country: z.string().nullable(), website: z.string().nullable(),
});
export const FrameworkSchema = z.object({
  id: z.string(), accreditorId: z.string(), name: z.string(), commission: z.string().nullable(),
  scope: z.enum(['institution', 'program', 'both']), description: z.string().nullable(),
});
export const VersionSchema = z.object({
  id: z.string(), frameworkId: z.string(), edition: z.string(), effectiveFrom: z.string().nullable(), effectiveTo: z.string().nullable(),
  status: z.enum(['draft', 'in_review', 'published', 'retired']),
  levelLabels: z.unknown(), lifecycleTemplate: z.unknown(), decisionVocab: z.unknown(), findingVocab: z.unknown(), responseVocab: z.unknown(), ratingMethod: z.unknown(),
  changeSummary: z.string().nullable(), publishedBy: z.string().nullable(), publishedAt: iso.nullable(), supersedesId: z.string().nullable(),
});
export const RequirementSchema = z.object({
  id: z.string(), frameworkVersionId: z.string(), parentId: z.string().nullable(), code: z.string(), levelLabel: z.string(), title: z.string(),
  officialText: z.string().nullable(), language: z.string(), translationEn: z.string().nullable(), isAssessable: z.boolean(),
  appliesWhen: z.unknown(), displayOrder: z.number(), weight: z.string().nullable(), depth: z.number().optional(), ...provenance,
});
export const NoteSchema = z.object({
  id: z.string(), requirementId: z.string(), type: z.enum(['guidance', 'evidence_expectation', 'data_request', 'quantitative_norm']),
  text: z.string(), authority: z.enum(['required', 'example', 'suggested', 'ai_suggested', 'institution_defined']), norm: z.unknown(), ...provenance,
});
export const TemplateSchema = z.object({
  id: z.string(), frameworkVersionId: z.string(), key: z.string(), name: z.string(),
  kind: z.enum(['application', 'readiness', 'self_study', 'follow_up', 'annual', 'response', 'other']), language: z.string(),
  structure: z.unknown(), wordLimit: z.number().nullable(), requiresAttestation: z.boolean(), ...provenance,
});
export const SourceDocumentSchema = z.object({
  id: z.string(), frameworkVersionId: z.string(), title: z.string(), role: z.string(), authority: z.string(), language: z.string(),
  filePath: z.string(), sha256: z.string(), pageCount: z.number().nullable(), textStatus: z.string(),
});
export const SourcePageSchema = z.object({
  id: z.string(), sourceDocumentId: z.string(), pageNo: z.number(), text: z.string(), method: z.enum(['pdf_text', 'ocr']), reviewed: z.boolean(),
});
export const RequirementDetailSchema = z.object({ requirement: RequirementSchema, notes: z.array(NoteSchema) });
export const ValidationResultSchema = z.object({
  ok: z.boolean(), issues: z.array(z.object({ path: z.string(), message: z.string() })),
});
export const ImportResultSchema = z.object({
  version: VersionSchema, counts: z.object({ requirements: z.number(), documents: z.number(), templates: z.number() }),
});
export const NewVersionResultSchema = z.object({ version: VersionSchema, requirementsCopied: z.number() });
export const ErrorSchema = z.object({ error: z.string(), message: z.string().optional(), issues: z.array(z.object({ path: z.string(), message: z.string() })).optional() });

/** Serialises a service result to its wire shape and checks it against the contract. */
export function toDto<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}
