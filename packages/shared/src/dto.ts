// Response shapes of the framework API: one definition for the OpenAPI spec, the typed client and the SPA.
import { z } from 'zod';
import { AnalysisBriefSchema } from './analysis.js';
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
  /** The latest analysis run of this version, when it has had one. */
  analysis: AnalysisBriefSchema.nullable(),
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
  /** What the analysis wrote into each part of the configuration, with its page and quote (step H); and which parts a person has edited since. */
  configFound: z.unknown().optional(), configEdited: z.unknown().optional(),
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
  /** A person changed this AI-made requirement: a new analysis run leaves it as it is. */
  editedByPerson: z.boolean().optional(),
});
export const NoteSchema = z.object({
  id: z.string(), requirementId: z.string(), type: z.enum(['guidance', 'evidence_expectation', 'data_request', 'quantitative_norm']),
  text: z.string(), authority: z.enum(['required', 'example', 'suggested', 'ai_suggested', 'institution_defined']), norm: z.unknown(), ...provenance,
  editedByPerson: z.boolean().optional(),
});
export const TemplateSchema = z.object({
  id: z.string(), frameworkVersionId: z.string(), key: z.string(), name: z.string(),
  kind: z.enum(['application', 'readiness', 'self_study', 'follow_up', 'annual', 'response', 'other']), language: z.string(),
  structure: z.unknown(), wordLimit: z.number().nullable(), requiresAttestation: z.boolean(), ...provenance,
  /** A person changed this AI-made template: a new analysis run leaves it as it is. */
  editedByPerson: z.boolean().optional(),
});
export const SourceDocumentSchema = z.object({
  id: z.string(), frameworkVersionId: z.string(), title: z.string(), role: z.string(), authority: z.string(), language: z.string(),
  filePath: z.string(), sha256: z.string(), pageCount: z.number().nullable(), textStatus: z.string(),
  /** Who chose the role: a person ('manual'), the analysis ('ai'), or nobody yet ('unset', the analysis proposes one). */
  roleOrigin: z.enum(['manual', 'ai', 'unset']).optional(),
  fileName: z.string().nullable(), mime: z.string().nullable(), size: z.number().nullable(),
  /** Listing only: pages whose text is stored, and whether the original file is held. */
  storedPages: z.number().optional(), hasFile: z.boolean().optional(),
  /** Listing only: stored pages that still need OCR. */
  needsOcrPages: z.number().optional(),
});
export const SourcePageSchema = z.object({
  id: z.string(), sourceDocumentId: z.string(), pageNo: z.number(), text: z.string(), method: z.enum(['pdf_text', 'ocr', 'table', 'slide', 'sheet']), reviewed: z.boolean(), needsOcr: z.boolean(), fromFile: z.boolean(),
});
/** One stored page of a source for the split-view review, with the cited quote located by the server's matcher (never the browser's). */
export const SourcePageViewSchema = z.object({
  document: z.object({
    id: z.string(), title: z.string(), role: z.string(), language: z.string(), fileName: z.string().nullable(), mime: z.string().nullable(),
    hasFile: z.boolean(), pageCount: z.number(),
  }),
  pageNos: z.array(z.number()),
  page: z.object({ pageNo: z.number(), text: z.string(), method: z.string(), needsOcr: z.boolean() }).nullable(),
  highlight: z.object({ start: z.number(), end: z.number(), score: z.number() }).nullable(),
  quoteFoundOnPage: z.number().nullable(),
  quoteGiven: z.boolean(),
});
/** Which items of a draft deserve a look first ("Needs a look"). Only items with at least one reason are listed. */
export const ReviewItemsSchema = z.object({
  requirements: z.array(z.object({ id: z.string(), quoteNotFound: z.boolean(), lowConfidence: z.boolean(), orphan: z.boolean() })),
  notes: z.array(z.object({ id: z.string(), requirementId: z.string(), quoteNotFound: z.boolean(), lowConfidence: z.boolean(), suggested: z.boolean() })),
});
/** What "Create from files" made: the browser uploads each file to its document, then starts the analysis. */
export const StandardFromFilesSchema = z.object({
  accreditor: z.object({ id: z.string(), name: z.string(), shortName: z.string(), created: z.boolean() }),
  framework: z.object({ id: z.string(), name: z.string(), scope: z.enum(['institution', 'program', 'both']) }),
  version: z.object({ id: z.string(), edition: z.string(), status: z.string() }),
  documents: z.array(z.object({ id: z.string(), title: z.string(), fileName: z.string() })),
});
export const SourceLimitsSchema = z.object({ maxFileBytes: z.number(), maxFiles: z.number() });
export const MergeResultSchema = z.object({ requirement: RequirementSchema, movedChildren: z.number(), movedNotes: z.number(), mappingsOnMergedCode: z.number() });
export const SplitResultSchema = z.object({ original: RequirementSchema, created: RequirementSchema });
export const RequirementDetailSchema = z.object({ requirement: RequirementSchema, notes: z.array(NoteSchema) });
/** ok=false lists the problems that block submitting and publishing; warnings never block (DEC-022). */
export const ValidationResultSchema = z.object({
  ok: z.boolean(), issues: z.array(z.object({ path: z.string(), message: z.string() })),
  warnings: z.array(z.object({ path: z.string(), message: z.string() })),
});
export const ImportResultSchema = z.object({
  version: VersionSchema, counts: z.object({ requirements: z.number(), documents: z.number(), templates: z.number() }),
});
export const NewVersionResultSchema = z.object({ version: VersionSchema, requirementsCopied: z.number() });
export const ErrorSchema = z.object({ error: z.string(), message: z.string().optional(), details: z.record(z.string(), z.unknown()).optional(), issues: z.array(z.object({ path: z.string(), message: z.string() })).optional() });

/** Serialises a service result to its wire shape and checks it against the contract. */
export function toDto<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

import { LanguageStateSchema } from './languages.js';

export const MeSchema = z.object({
  userId: z.string().nullable(), institutionId: z.string(), roles: z.array(z.enum(ROLES)), permissions: z.array(z.enum(PERMISSIONS)),
  /** The language setting that applies to this person (TASK-070). */
  language: LanguageStateSchema.optional(),
});
export type Me = z.infer<typeof MeSchema>;

// ---- Settings: institution, org chart, programs -------------------------------------------------

import { isReadableAccent } from './branding.js';

export const InstitutionSchema = z.object({
  id: z.string(), nameEn: z.string(), nameAr: z.string().nullable(), country: z.string().nullable(),
  /** The interface language for people who have not chosen one: `en` or the secondary language. */
  defaultLocale: z.string(), accentColor: z.string().nullable(),
  /** The one secondary language (a registry code), or null. */
  secondaryLanguage: z.string().nullable(),
  /** Changes whenever the logo does (used in the logo URL to refresh browser caches); null when there is no logo. */
  logoVersion: z.string().nullable(),
});
export type Institution = z.infer<typeof InstitutionSchema>;

/**
 * The only thing served without signing in (the sign-in page): the institution's display name, accent colour and the
 * address of its logo. Nothing else about the institution is public. Every field is null when the deployment has no single
 * institution to show.
 */
export const PublicBrandingSchema = z.object({
  name: z.string().nullable(), accentColor: z.string().nullable(), logoUrl: z.string().nullable(),
});
export type PublicBranding = z.infer<typeof PublicBrandingSchema>;

export const UpdateInstitutionSchema = z.object({
  nameEn: z.string().trim().min(1).optional(),
  nameAr: z.string().trim().nullable().optional(),
  country: z.string().trim().nullable().optional(),
  defaultLocale: z.string().optional(),
  secondaryLanguage: z.string().nullable().optional(),
  accentColor: z.string().nullable().optional().refine((v) => v == null || isReadableAccent(v), { message: 'choose a darker colour: white text on it must reach a contrast of 4.5 (#rrggbb)' }),
}).strict();
export type UpdateInstitution = z.infer<typeof UpdateInstitutionSchema>;

// ---- Org chart (TASK-072, docs/organization-plan.md E.1) ----------------------------------------------------------------

/** Where a unit came from. Imports and directory sync only ever touch units they made, and never an edited or locked one. */
export const ORG_UNIT_SOURCES = ['manual', 'image', 'directory'] as const;
export type OrgUnitSource = (typeof ORG_UNIT_SOURCES)[number];

/** How deep the org chart may go (a university, its colleges, departments, sections ... ). */
export const ORG_MAX_DEPTH = 12;

/** The unit types a new institution starts with (the database seeds the same five; they are ordinary rows afterwards). */
export const DEFAULT_ORG_UNIT_TYPES = [
  { key: 'college', labelEn: 'College', labelAr: 'كلية' },
  { key: 'school', labelEn: 'School', labelAr: 'مدرسة' },
  { key: 'department', labelEn: 'Department', labelAr: 'قسم' },
  { key: 'admin_unit', labelEn: 'Administrative unit', labelAr: 'وحدة إدارية' },
  { key: 'other', labelEn: 'Other', labelAr: 'أخرى' },
] as const;

/** A kind of unit (college, school ...) of one institution: configurable, in an order. `key` is stable; units refer to it. */
export const OrgUnitTypeSchema = z.object({
  id: z.string(), key: z.string(), labelEn: z.string(), labelAr: z.string().nullable(), displayOrder: z.number(),
  /** How many units use it (a type can be removed only when none does). */
  unitCount: z.number(),
});
export type OrgUnitType = z.infer<typeof OrgUnitTypeSchema>;
export const CreateOrgUnitTypeSchema = z.object({
  /** Lower-case letters, digits and _; made from the English label when left out. */
  key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, 'lower-case letters, digits and _').optional(),
  labelEn: z.string().trim().min(1).max(80), labelAr: z.string().trim().min(1).max(80).optional(),
  /** Where it goes in the list (default: last). */
  index: z.number().int().min(0).optional(),
}).strict();
export type CreateOrgUnitType = z.infer<typeof CreateOrgUnitTypeSchema>;
export const UpdateOrgUnitTypeSchema = z.object({
  labelEn: z.string().trim().min(1).max(80).optional(), labelAr: z.string().trim().max(80).nullable().optional(),
}).strict();
export type UpdateOrgUnitType = z.infer<typeof UpdateOrgUnitTypeSchema>;
export const ReorderOrgUnitTypesSchema = z.object({ ids: z.array(z.uuid()).min(1).max(200) }).strict();
export type ReorderOrgUnitTypes = z.infer<typeof ReorderOrgUnitTypesSchema>;

export const OrgUnitProgramSchema = z.object({
  id: z.string(), nameEn: z.string(), nameAr: z.string().nullable(), degreeLevel: z.string(), active: z.boolean(),
});
export type OrgUnitProgram = z.infer<typeof OrgUnitProgramSchema>;

export const OrgUnitSchema = z.object({
  id: z.string(), parentId: z.string().nullable(),
  /** The key of one of the institution's unit types. */
  type: z.string(),
  nameEn: z.string(), nameAr: z.string().nullable(), description: z.string().nullable(), active: z.boolean(),
  source: z.enum(ORG_UNIT_SOURCES), locked: z.boolean(), editedByPerson: z.boolean(),
  /** Position among its siblings, 0, 1, 2 ... */
  displayOrder: z.number(),
  /** The head: a person (with the name resolved) or free text; at most one of the two. */
  headUserId: z.string().nullable(), headName: z.string().nullable(), headUserName: z.string().nullable(),
  programCount: z.number(), memberCount: z.number(),
  programs: z.array(OrgUnitProgramSchema),
});
export type OrgUnit = z.infer<typeof OrgUnitSchema>;

/** The whole org chart: the units in tree order and the institution's unit types. */
export const OrgChartSchema = z.object({ units: z.array(OrgUnitSchema), types: z.array(OrgUnitTypeSchema) });
export type OrgChart = z.infer<typeof OrgChartSchema>;

export const CreateOrgUnitSchema = z.object({
  parentId: z.uuid().nullable().default(null), type: z.string().min(1), nameEn: z.string().trim().min(1), nameAr: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  headUserId: z.uuid().optional(), headName: z.string().trim().min(1).optional(),
  /** Where among its siblings (default: last). */
  index: z.number().int().min(0).optional(),
}).strict();
export type CreateOrgUnit = z.infer<typeof CreateOrgUnitSchema>;
/** Name, type, head, description, lock, active. Moving and reordering is `move-many`; deleting goes to the Trash. */
export const UpdateOrgUnitSchema = z.object({
  type: z.string().min(1).optional(), nameEn: z.string().trim().min(1).optional(),
  nameAr: z.string().trim().nullable().optional(), description: z.string().trim().nullable().optional(), active: z.boolean().optional(),
  locked: z.boolean().optional(),
  /** Setting one head clears the other; null for both clears the head. */
  headUserId: z.uuid().nullable().optional(), headName: z.string().trim().nullable().optional(),
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

// ---- Suggested new IQF items and bulk acceptance (step E; DEC-021/022/023) -------------------------------------------

export const IQF_PROPOSAL_STATUSES = ['pending', 'accepted', 'dismissed'] as const;
export const IqfProposalLinkSchema = z.object({
  externalCode: z.string(), externalRequirementId: z.string().nullable(), externalTitle: z.string().nullable(),
  relation: z.enum(MAPPING_RELATIONS), reason: z.string().nullable(),
});
/** A new item of the quality framework the analysis suggests. Nothing is in the framework until a person accepts it. */
export const IqfItemProposalSchema = z.object({
  id: z.string(),
  status: z.enum(IQF_PROPOSAL_STATUSES),
  parentCode: z.string().nullable(), parentTitle: z.string().nullable(),
  levelLabel: z.string(), code: z.string(), title: z.string(),
  description: z.string().nullable(), reason: z.string().nullable(),
  links: z.array(IqfProposalLinkSchema),
  /** The item that accepting created (in the quality framework's draft). */
  acceptedRequirementId: z.string().nullable(),
  createdAt: z.string(),
});
export type IqfItemProposal = z.infer<typeof IqfItemProposalSchema>;
export const IqfProposalsSchema = z.object({
  /** The quality framework's draft version: where an accepted item goes. Null when it has none (start a new version first). */
  draftVersionId: z.string().nullable(),
  proposals: z.array(IqfItemProposalSchema),
});
export type IqfProposals = z.infer<typeof IqfProposalsSchema>;
/** Changes a person makes while accepting: any of them replaces the suggested value. */
export const AcceptIqfProposalSchema = z.object({
  code: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().nullable().optional(),
  parentCode: z.string().trim().min(1).nullable().optional(),
}).strict();
export type AcceptIqfProposal = z.infer<typeof AcceptIqfProposalSchema>;
/** "Accept all in this view": the visible suggested links; only those that say "covers" are accepted. */
export const AcceptCoversSchema = z.object({ ids: z.array(z.uuid()).min(1).max(1000) }).strict();
export type AcceptCovers = z.infer<typeof AcceptCoversSchema>;
export const AcceptCoversResultSchema = z.object({ accepted: z.number().int(), skipped: z.number().int() });
export type AcceptCoversResult = z.infer<typeof AcceptCoversResultSchema>;
