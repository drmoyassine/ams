// Response shapes of the framework API: one definition for the OpenAPI spec, the typed client and the SPA.
import { z } from 'zod';
import { PERMISSIONS, ROLES } from './permissions.js';

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

export const FrameworkVersionSummarySchema = z.object({
  id: z.string(), edition: z.string(), status: z.enum(['draft', 'in_review', 'published', 'retired']), publishedAt: iso.nullable(), effectiveFrom: z.string().nullable(),
  supersedesId: z.string().nullable(),
  requirementCount: z.number(), assessableCount: z.number(),
  /** Assessable requirements with an approved mapping to the institution's own standards. */
  mappedCount: z.number(), engagementCount: z.number(),
});
export const FrameworkListItemSchema = z.object({
  id: z.string(), name: z.string(), scope: z.enum(['institution', 'program', 'both']), commission: z.string().nullable(), description: z.string().nullable(),
  accreditorId: z.string(), accreditorShortName: z.string(), accreditorName: z.string(), accreditorType: z.enum(['institutional', 'programmatic', 'regulatory']),
  accreditorCountry: z.string().nullable(), accreditorWebsite: z.string().nullable(),
  /** Changes whenever the logo does (for the image address); null when the accreditor has none. */
  logoVersion: z.string().nullable(),
  versions: z.array(FrameworkVersionSummarySchema),
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
  /** Set on the detail of a version of the institution's own quality framework. */
  internal: z.boolean().optional(),
});
export const QualityFrameworkSchema = z.object({
  framework: z.object({ id: z.string(), name: z.string() }).nullable(),
  versions: z.array(VersionSchema),
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
  fileName: z.string().nullable(), mime: z.string().nullable(), size: z.number().nullable(),
  /** Listing only: pages whose text is stored, and whether the original file is held. */
  storedPages: z.number().optional(), hasFile: z.boolean().optional(),
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

export const MeSchema = z.object({
  userId: z.string().nullable(), institutionId: z.string(), roles: z.array(z.enum(ROLES)), permissions: z.array(z.enum(PERMISSIONS)),
});
export type Me = z.infer<typeof MeSchema>;

// ---- Settings: institution, org chart, programs -------------------------------------------------

import { isReadableAccent } from './branding.js';

export const InstitutionSchema = z.object({
  id: z.string(), nameEn: z.string(), nameAr: z.string().nullable(), country: z.string().nullable(),
  defaultLocale: z.string(), accentColor: z.string().nullable(),
});
export type Institution = z.infer<typeof InstitutionSchema>;

export const UpdateInstitutionSchema = z.object({
  nameEn: z.string().trim().min(1).optional(),
  nameAr: z.string().trim().nullable().optional(),
  country: z.string().trim().nullable().optional(),
  defaultLocale: z.enum(['en', 'ar']).optional(),
  accentColor: z.string().nullable().optional().refine((v) => v == null || isReadableAccent(v), { message: 'choose a darker colour: white text on it must reach a contrast of 4.5 (#rrggbb)' }),
}).strict();
export type UpdateInstitution = z.infer<typeof UpdateInstitutionSchema>;

export const ORG_UNIT_TYPES = ['college', 'school', 'department', 'admin_unit', 'other'] as const;
export const OrgUnitSchema = z.object({
  id: z.string(), parentId: z.string().nullable(), type: z.enum(ORG_UNIT_TYPES), nameEn: z.string(), nameAr: z.string().nullable(), active: z.boolean(),
});
export type OrgUnit = z.infer<typeof OrgUnitSchema>;
export const CreateOrgUnitSchema = z.object({
  parentId: z.uuid().nullable().default(null), type: z.enum(ORG_UNIT_TYPES), nameEn: z.string().trim().min(1), nameAr: z.string().trim().min(1).optional(),
}).strict();
export type CreateOrgUnit = z.infer<typeof CreateOrgUnitSchema>;
export const UpdateOrgUnitSchema = z.object({
  parentId: z.uuid().nullable().optional(), type: z.enum(ORG_UNIT_TYPES).optional(), nameEn: z.string().trim().min(1).optional(),
  nameAr: z.string().trim().nullable().optional(), active: z.boolean().optional(),
}).strict();
export type UpdateOrgUnit = z.infer<typeof UpdateOrgUnitSchema>;

// ---- Glossary (DEC-016) -------------------------------------------------------------------------

export const GLOSSARY_KINDS = ['level', 'finding', 'report', 'general'] as const;
export const ALIAS_SOURCES = ['level_label', 'finding_code', 'report_template'] as const;

export const GlossaryTermSchema = z.object({
  id: z.string(), key: z.string(), kind: z.enum(GLOSSARY_KINDS), labelEn: z.string(), labelAr: z.string().nullable(),
  definitionEn: z.string().nullable(), definitionAr: z.string().nullable(), active: z.boolean(),
});
export type GlossaryTerm = z.infer<typeof GlossaryTermSchema>;

export const GlossaryAliasSchema = z.object({
  id: z.string(), termId: z.string(), frameworkId: z.string(), source: z.enum(ALIAS_SOURCES), externalTerm: z.string(),
});
export type GlossaryAlias = z.infer<typeof GlossaryAliasSchema>;

export const GlossarySchema = z.object({ terms: z.array(GlossaryTermSchema), aliases: z.array(GlossaryAliasSchema) });
export type Glossary = z.infer<typeof GlossarySchema>;

export const CreateTermSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'lower-case letters, digits and _').optional(),
  kind: z.enum(GLOSSARY_KINDS),
  labelEn: z.string().trim().min(1),
  labelAr: z.string().trim().min(1).optional(),
  definitionEn: z.string().trim().min(1).optional(),
  definitionAr: z.string().trim().min(1).optional(),
}).strict();
export type CreateTerm = z.infer<typeof CreateTermSchema>;

export const UpdateTermSchema = z.object({
  labelEn: z.string().trim().min(1).optional(),
  labelAr: z.string().trim().nullable().optional(),
  definitionEn: z.string().trim().nullable().optional(),
  definitionAr: z.string().trim().nullable().optional(),
  active: z.boolean().optional(),
}).strict();
export type UpdateTerm = z.infer<typeof UpdateTermSchema>;

/** One external term of one standard, with the internal term it is mapped to (null: not mapped yet). */
export const ExternalTermSchema = z.object({
  source: z.enum(ALIAS_SOURCES), externalTerm: z.string(), detail: z.string(),
  termId: z.string().nullable(), suggestedKey: z.string().nullable(),
});
export const ExternalStandardSchema = z.object({
  frameworkId: z.string(), accreditorShortName: z.string(), name: z.string(), edition: z.string(), terms: z.array(ExternalTermSchema),
});
export type ExternalStandard = z.infer<typeof ExternalStandardSchema>;

export const SetAliasSchema = z.object({
  frameworkId: z.uuid(), source: z.enum(ALIAS_SOURCES), externalTerm: z.string().min(1), termId: z.uuid().nullable(),
}).strict();
export type SetAlias = z.infer<typeof SetAliasSchema>;

// ---- Mappings from an external standard onto the institution's quality framework (DEC-016) ------------------------

export const MAPPING_RELATIONS = ['covers', 'partly_covers', 'related'] as const;
export const MappingSchema = z.object({
  id: z.string(),
  externalCode: z.string(), externalRequirementId: z.string().nullable(),
  internalCode: z.string(), internalRequirementId: z.string().nullable(), internalTitle: z.string().nullable(),
  relation: z.enum(MAPPING_RELATIONS), rationale: z.string().nullable(),
  origin: z.enum(['manual', 'import', 'ai']), reviewStatus: z.enum(['pending', 'approved', 'rejected']),
  /** The mapped requirement no longer exists in the version shown (a newer edition may have dropped or renumbered it). */
  stale: z.boolean(),
});
export type Mapping = z.infer<typeof MappingSchema>;
export const MappingsSchema = z.object({
  /** The version of the quality framework the choices come from: its latest published one, else its latest draft. */
  internalVersionId: z.string().nullable(),
  internalOptions: z.array(z.object({ id: z.string(), code: z.string(), title: z.string(), levelLabel: z.string(), depth: z.number() })),
  mappings: z.array(MappingSchema),
});
export type Mappings = z.infer<typeof MappingsSchema>;
export const CreateMappingSchema = z.object({
  externalRequirementId: z.uuid(), internalRequirementId: z.uuid(),
  relation: z.enum(MAPPING_RELATIONS), rationale: z.string().trim().min(1).optional(),
}).strict();
export type CreateMapping = z.infer<typeof CreateMappingSchema>;
export const UpdateMappingSchema = z.object({
  relation: z.enum(MAPPING_RELATIONS).optional(), rationale: z.string().trim().nullable().optional(),
}).strict();
export type UpdateMapping = z.infer<typeof UpdateMappingSchema>;
