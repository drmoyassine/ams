import { sql } from 'drizzle-orm';
import {
  ANALYSIS_STAGES, ANALYSIS_STATUSES, ENGAGEMENT_KINDS, type AnalysisProgress, type AnalysisUsage, ENGAGEMENT_REQUIREMENT_STATUSES, ENGAGEMENT_STATUSES, ENGAGEMENT_SUBJECT_TYPES, MILESTONE_ORIGINS, MILESTONE_STATUSES,
  MILESTONE_TYPES, PHASE_TYPES, ROLES,
} from '@ams/shared';
import {
  boolean, check, date, index, integer, jsonb, numeric, pgTable, real, text, timestamp, uniqueIndex, uuid, type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/** Drizzle's `enum` option is type-only; this makes the database enforce the value set too. */
const oneOf = (name: string, col: AnyPgColumn, values: readonly string[]) =>
  check(name, sql`${col} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`);

/** Columns every table carries (PRD §6): id, tenant key, created/updated by/at. */
const base = () => ({
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references((): AnyPgColumn => appUser.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references((): AnyPgColumn => appUser.id),
});
const tenant = () => ({
  institutionId: uuid('institution_id').notNull().references(() => institution.id),
});

// ---- 6.1 Organization & access --------------------------------------------------------------

// For `institution` the tenant key is its own id (see TASK-004 RLS), so it has no institution_id column.
export const institution = pgTable('institution', {
  ...base(),
  nameEn: text('name_en').notNull(),
  nameAr: text('name_ar'),
  country: text('country'),
  defaultLocale: text('default_locale').notNull().default('en'),
  /** Branding: the colour of primary buttons and highlights, `#rrggbb`; null keeps the built-in one. */
  accentColor: text('accent_color'),
}, (t) => [check('institution_accent_color_check', sql`${t.accentColor} is null or ${t.accentColor} ~ '^#[0-9a-fA-F]{6}$'`)]);

/**
 * The institution's AI connection (Settings -> AI, DEC-021): one row per institution. The provider key is stored
 * encrypted (AES-256-GCM, key derived from APP_SECRET); `api_key_last4` is all the client ever sees of it.
 * Limits apply per run (one job). The worker reads this row; only an admin writes it.
 */
export const aiSetting = pgTable('ai_setting', {
  ...base(), ...tenant(),
  provider: text('provider').notNull().default('anthropic'),
  /** Server address of an OpenAI-compatible provider (http(s), no credentials); null for the other providers. */
  baseUrl: text('base_url'),
  model: text('model'),
  apiKeyEnc: text('api_key_enc'),
  apiKeyLast4: text('api_key_last4'),
  maxTokensPerRun: integer('max_tokens_per_run'),
  maxCostUsdPerRun: numeric('max_cost_usd_per_run', { precision: 12, scale: 4 }),
  inputUsdPerMTok: numeric('input_usd_per_mtok', { precision: 12, scale: 4 }),
  outputUsdPerMTok: numeric('output_usd_per_mtok', { precision: 12, scale: 4 }),
  /** Check-and-recover rounds after a framework analysis's extraction (step D); 0 switches them off. */
  maxRecoveryRounds: integer('max_recovery_rounds').notNull().default(2),
  enabled: boolean('enabled').notNull().default(false),
  // Embeddings (DEC-023): a separate OpenAI-compatible endpoint, off by default. The key is encrypted like the one above.
  embedEnabled: boolean('embed_enabled').notNull().default(false),
  embedBaseUrl: text('embed_base_url'),
  embedModel: text('embed_model'),
  embedApiKeyEnc: text('embed_api_key_enc'),
  embedApiKeyLast4: text('embed_api_key_last4'),
  embedDimension: integer('embed_dimension'),
}, (t) => [
  uniqueIndex('ai_setting_institution_idx').on(t.institutionId),
  oneOf('ai_setting_provider_check', t.provider, ['anthropic', 'openai', 'google', 'openai_compatible']),
  check('ai_setting_base_url_check', sql`${t.baseUrl} is null or ${t.provider} = 'openai_compatible'`),
  check('ai_setting_limits_check', sql`(${t.maxTokensPerRun} is null or ${t.maxTokensPerRun} > 0) and (${t.maxCostUsdPerRun} is null or ${t.maxCostUsdPerRun} > 0)`),
  check('ai_setting_recovery_rounds_check', sql`${t.maxRecoveryRounds} between 0 and 5`),
]);

/** The only things that may be embedded (DEC-023): framework text. Evidence, datasets, responses, requests and letters never are. */
export const EMBEDDING_OWNER_TYPES = ['requirement'] as const;

/**
 * Derived data: the vector of a requirement's text, for ranking candidates by similarity (DEC-023). Rebuildable, and
 * deliberately outside the frozen-version triggers. Plain real[] (no extension); similarity is computed in packages/core.
 */
export const embedding = pgTable('embedding', {
  ...base(), ...tenant(),
  ownerType: text('owner_type').notNull(),
  ownerId: uuid('owner_id').notNull(),
  model: text('model').notNull(),
  dimension: integer('dimension').notNull(),
  textHash: text('text_hash').notNull(),
  vector: real('vector').array().notNull(),
}, (t) => [
  uniqueIndex('embedding_owner_model_idx').on(t.ownerType, t.ownerId, t.model),
  index('embedding_institution_idx').on(t.institutionId),
  oneOf('embedding_owner_type_check', t.ownerType, EMBEDDING_OWNER_TYPES),
  check('embedding_dimension_check', sql`${t.dimension} > 0 and cardinality(${t.vector}) = ${t.dimension}`),
]);

const ORG_UNIT_TYPES = ['college', 'school', 'department', 'admin_unit', 'other'] as const;
export const orgUnit = pgTable('org_unit', {
  ...base(), ...tenant(),
  parentId: uuid('parent_id').references((): AnyPgColumn => orgUnit.id),
  type: text('type', { enum: ORG_UNIT_TYPES }).notNull(),
  nameEn: text('name_en').notNull(),
  nameAr: text('name_ar'),
  active: boolean('active').notNull().default(true),
}, (t) => [index('org_unit_parent_idx').on(t.parentId), oneOf('org_unit_type_check', t.type, ORG_UNIT_TYPES)]);

const DEGREE_LEVELS = ['associate', 'bachelor', 'master', 'doctorate', 'diploma', 'certificate'] as const;
export const program = pgTable('program', {
  ...base(), ...tenant(),
  orgUnitId: uuid('org_unit_id').notNull().references(() => orgUnit.id),
  nameEn: text('name_en').notNull(),
  nameAr: text('name_ar'),
  degreeLevel: text('degree_level', { enum: DEGREE_LEVELS }).notNull(),
  discipline: text('discipline'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  active: boolean('active').notNull().default(true),
}, (t) => [index('program_org_unit_idx').on(t.orgUnitId), oneOf('program_degree_level_check', t.degreeLevel, DEGREE_LEVELS)]);

export const appUser = pgTable('app_user', {
  ...base(), ...tenant(),
  authUserId: text('auth_user_id'),
  fullName: text('full_name').notNull(),
  email: text('email').notNull(),
  locale: text('locale').notNull().default('en'),
  active: boolean('active').notNull().default(true),
}, (t) => [
  uniqueIndex('app_user_email_idx').on(t.institutionId, sql`lower(${t.email})`),
  uniqueIndex('app_user_auth_user_idx').on(t.authUserId),
]);

export const SCOPE_TYPES = ['institution', 'org_unit', 'program', 'engagement'] as const;

// scope_id is polymorphic (institution / org_unit / program / engagement) and so carries no foreign key.
export const roleAssignment = pgTable('role_assignment', {
  ...base(), ...tenant(),
  userId: uuid('user_id').notNull().references(() => appUser.id),
  role: text('role', { enum: ROLES }).notNull(),
  scopeType: text('scope_type', { enum: SCOPE_TYPES }).notNull(),
  scopeId: uuid('scope_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, (t) => [
  index('role_assignment_user_idx').on(t.userId),
  index('role_assignment_scope_idx').on(t.scopeType, t.scopeId),
  oneOf('role_assignment_role_check', t.role, ROLES),
  oneOf('role_assignment_scope_type_check', t.scopeType, SCOPE_TYPES),
  check('role_assignment_engagement_roles', sql`${t.role} not in ('engagement_lead', 'co_lead') or ${t.scopeType} = 'engagement'`),
  check('role_assignment_external_reviewer_expires', sql`${t.role} <> 'external_reviewer' or ${t.expiresAt} is not null`),
]);

// ---- 6.8 Shared -----------------------------------------------------------------------------

export const comment = pgTable('comment', {
  ...base(), ...tenant(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  body: text('body').notNull(),
  authorId: uuid('author_id').notNull().references(() => appUser.id),
  resolved: boolean('resolved').notNull().default(false),
}, (t) => [index('comment_target_idx').on(t.targetType, t.targetId)]);

// Append-only (TASK-004). `at` is the event time; created_*/updated_* columns are kept for uniformity.
const ACTOR_TYPES = ['user', 'system', 'ai'] as const;
export const auditEvent = pgTable('audit_event', {
  ...base(), ...tenant(),
  actorId: uuid('actor_id'),
  actorType: text('actor_type', { enum: ACTOR_TYPES }).notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('audit_event_target_idx').on(t.targetType, t.targetId), index('audit_event_at_idx').on(t.at), oneOf('audit_event_actor_type_check', t.actorType, ACTOR_TYPES)]);

export const JOB_TYPES = ['extract_text', 'ocr', 'ai_extract', 'export', 'notify', 'analyse'] as const;
const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export const job = pgTable('job', {
  ...base(), ...tenant(),
  type: text('type', { enum: JOB_TYPES }).notNull(),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  status: text('status', { enum: JOB_STATUSES }).notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  result: jsonb('result'),
}, (t) => [oneOf('job_type_check', t.type, JOB_TYPES), oneOf('job_status_check', t.status, JOB_STATUSES)]);

export const EXTRACTION_KINDS = [
  'requirement', 'note', 'report_section', 'milestone', 'decision', 'finding_severity', 'response_type', 'metadata',
] as const;
const EXTRACTION_STATUSES = ['pending', 'accepted', 'edited', 'rejected'] as const;
export const extractionItem = pgTable('extraction_item', {
  ...base(), ...tenant(),
  frameworkVersionId: uuid('framework_version_id').notNull().references(() => frameworkVersion.id),
  jobId: uuid('job_id').references(() => job.id),
  /** The analysis run that proposed this item (its raw output, kept for the record). */
  analysisRunId: uuid('analysis_run_id').references((): AnyPgColumn => analysisRun.id),
  kind: text('kind', { enum: EXTRACTION_KINDS }).notNull(),
  payload: jsonb('payload').notNull(),
  sourceDocumentId: uuid('source_document_id').references(() => sourceDocument.id),
  sourcePage: integer('source_page'),
  sourceQuote: text('source_quote'),
  quoteVerified: boolean('quote_verified').notNull().default(false),
  confidence: real('confidence'),
  flags: text('flags').array().notNull().default(sql`'{}'::text[]`),
  status: text('status', { enum: EXTRACTION_STATUSES }).notNull().default('pending'),
  reviewedBy: uuid('reviewed_by').references(() => appUser.id),
}, (t) => [
  index('extraction_item_version_idx').on(t.frameworkVersionId, t.status),
  index('extraction_item_run_idx').on(t.analysisRunId),
  oneOf('extraction_item_kind_check', t.kind, EXTRACTION_KINDS),
  oneOf('extraction_item_status_check', t.status, EXTRACTION_STATUSES),
]);

// ---- 6.2 Framework library ------------------------------------------------------------------

const ACCREDITOR_TYPES = ['institutional', 'programmatic', 'regulatory'] as const;
export const accreditor = pgTable('accreditor', {
  ...base(), ...tenant(),
  name: text('name').notNull(),
  shortName: text('short_name').notNull(),
  type: text('type', { enum: ACCREDITOR_TYPES }).notNull(),
  country: text('country'),
  website: text('website'),
  /** The accreditor's logo: a small PNG, JPEG or WebP in the object store. `logoUpdatedAt` busts browser caches. */
  logoPath: text('logo_path'),
  logoMime: text('logo_mime'),
  logoUpdatedAt: timestamp('logo_updated_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('accreditor_short_name_idx').on(t.institutionId, t.shortName),
  oneOf('accreditor_type_check', t.type, ACCREDITOR_TYPES),
]);

const FRAMEWORK_SCOPES = ['institution', 'program', 'both'] as const;
export const framework = pgTable('framework', {
  ...base(), ...tenant(),
  accreditorId: uuid('accreditor_id').notNull().references(() => accreditor.id),
  name: text('name').notNull(),
  commission: text('commission'),
  scope: text('scope', { enum: FRAMEWORK_SCOPES }).notNull(),
  description: text('description'),
  /** The institution's own quality framework (DEC-016): at most one per institution, never the basis of an engagement. */
  internal: boolean('internal').notNull().default(false),
}, (t) => [
  index('framework_accreditor_idx').on(t.accreditorId),
  uniqueIndex('framework_one_internal_idx').on(t.institutionId).where(sql`${t.internal}`),
  oneOf('framework_scope_check', t.scope, FRAMEWORK_SCOPES),
]);

export const FRAMEWORK_VERSION_STATUSES = ['draft', 'in_review', 'published', 'retired'] as const;
export const frameworkVersion = pgTable('framework_version', {
  ...base(), ...tenant(),
  frameworkId: uuid('framework_id').notNull().references(() => framework.id),
  edition: text('edition').notNull(),
  effectiveFrom: date('effective_from'),
  effectiveTo: date('effective_to'),
  status: text('status', { enum: FRAMEWORK_VERSION_STATUSES }).notNull().default('draft'),
  levelLabels: jsonb('level_labels').notNull().default(sql`'[]'::jsonb`),
  lifecycleTemplate: jsonb('lifecycle_template').notNull().default(sql`'{}'::jsonb`),
  decisionVocab: jsonb('decision_vocab').notNull().default(sql`'[]'::jsonb`),
  findingVocab: jsonb('finding_vocab').notNull().default(sql`'[]'::jsonb`),
  responseVocab: jsonb('response_vocab').notNull().default(sql`'[]'::jsonb`),
  ratingMethod: jsonb('rating_method'),
  changeSummary: text('change_summary'),
  publishedBy: uuid('published_by').references((): AnyPgColumn => appUser.id),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  supersedesId: uuid('supersedes_id').references((): AnyPgColumn => frameworkVersion.id),
}, (t) => [
  uniqueIndex('framework_version_edition_idx').on(t.frameworkId, t.edition),
  oneOf('framework_version_status_check', t.status, FRAMEWORK_VERSION_STATUSES),
  check('framework_version_published_fields', sql`${t.status} not in ('published', 'retired') or (${t.publishedAt} is not null and ${t.publishedBy} is not null)`),
]);

const DOCUMENT_ROLES = [
  'standards', 'policy_procedure', 'guidance', 'report_template', 'evidence_guidance', 'amendment', 'sample_report', 'correspondence', 'other',
] as const;
const DOCUMENT_AUTHORITIES = ['binding', 'interpretive', 'informational'] as const;
export const ROLE_ORIGINS = ['manual', 'ai', 'unset'] as const;
const TEXT_STATUSES = ['pending', 'queued', 'extracted', 'ocr_needed', 'ocr_done', 'failed'] as const;
export const sourceDocument = pgTable('source_document', {
  ...base(), ...tenant(),
  frameworkVersionId: uuid('framework_version_id').notNull().references(() => frameworkVersion.id),
  title: text('title').notNull(),
  role: text('role', { enum: DOCUMENT_ROLES }).notNull(),
  authority: text('authority', { enum: DOCUMENT_AUTHORITIES }).notNull(),
  language: text('language').notNull().default('en'),
  filePath: text('file_path').notNull(),
  sha256: text('sha256').notNull(),
  pageCount: integer('page_count'),
  textStatus: text('text_status', { enum: TEXT_STATUSES }).notNull().default('pending'),
  /** The uploaded original, when there is one (`filePath` then names it in the object store). */
  fileName: text('file_name'),
  mime: text('mime'),
  size: integer('size'),
  /** Who chose `role`: a person, the analysis (which may revise its own choice), or nobody yet (the analysis proposes one). */
  roleOrigin: text('role_origin', { enum: ROLE_ORIGINS }).notNull().default('manual'),
}, (t) => [
  index('source_document_version_idx').on(t.frameworkVersionId),
  oneOf('source_document_role_origin_check', t.roleOrigin, ROLE_ORIGINS),
  oneOf('source_document_role_check', t.role, DOCUMENT_ROLES),
  oneOf('source_document_authority_check', t.authority, DOCUMENT_AUTHORITIES),
  oneOf('source_document_text_status_check', t.textStatus, TEXT_STATUSES),
  check('source_document_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
]);

export const PAGE_METHODS = ['pdf_text', 'ocr', 'table', 'slide', 'sheet'] as const;
export const sourcePage = pgTable('source_page', {
  ...base(), ...tenant(),
  sourceDocumentId: uuid('source_document_id').notNull().references(() => sourceDocument.id),
  pageNo: integer('page_no').notNull(),
  text: text('text').notNull(),
  method: text('method', { enum: PAGE_METHODS }).notNull(),
  reviewed: boolean('reviewed').notNull().default(false),
  /** Reading the file found no usable text layer on this page: it should be read by OCR. */
  needsOcr: boolean('needs_ocr').notNull().default(false),
  /** The text was written by reading the file and nobody has touched it since: only such a page is replaced when the file is read again. */
  fromFile: boolean('from_file').notNull().default(false),
}, (t) => [
  uniqueIndex('source_page_doc_page_idx').on(t.sourceDocumentId, t.pageNo),
  oneOf('source_page_method_check', t.method, PAGE_METHODS),
  check('source_page_no_check', sql`${t.pageNo} >= 1`),
]);

/** Provenance fields carried by requirement, requirement_note and report_template (PRD 6.2). */
export const ORIGINS = ['manual', 'import', 'ai'] as const;
export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
const provenance = () => ({
  origin: text('origin', { enum: ORIGINS }).notNull().default('manual'),
  sourceDocumentId: uuid('source_document_id').references(() => sourceDocument.id),
  sourcePage: integer('source_page'),
  sourceQuote: text('source_quote'),
  quoteVerified: boolean('quote_verified').notNull().default(false),
  reviewStatus: text('review_status', { enum: REVIEW_STATUSES }).notNull().default('pending'),
  reviewedBy: uuid('reviewed_by').references((): AnyPgColumn => appUser.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
});
/**
 * On requirement and requirement_note: a person changed this row after the analysis wrote it. Set by the database
 * (trigger mark_person_edit) on any update that is not the worker's, so every edit path counts. A re-run of the analysis
 * never overwrites, re-parents or deletes such a row.
 */
const editedByPerson = () => ({ editedByPerson: boolean('edited_by_person').notNull().default(false) });
const provenanceChecks = (name: string, t: { origin: AnyPgColumn; reviewStatus: AnyPgColumn; quoteVerified: AnyPgColumn; sourceQuote: AnyPgColumn }) => [
  oneOf(`${name}_origin_check`, t.origin, ORIGINS),
  oneOf(`${name}_review_status_check`, t.reviewStatus, REVIEW_STATUSES),
  check(`${name}_verified_quote_check`, sql`not ${t.quoteVerified} or ${t.sourceQuote} is not null`),
];

export const requirement = pgTable('requirement', {
  ...base(), ...tenant(),
  frameworkVersionId: uuid('framework_version_id').notNull().references(() => frameworkVersion.id),
  parentId: uuid('parent_id').references((): AnyPgColumn => requirement.id),
  code: text('code').notNull(),
  levelLabel: text('level_label').notNull(),
  title: text('title').notNull(),
  officialText: text('official_text'),
  language: text('language').notNull().default('en'),
  translationEn: text('translation_en'),
  isAssessable: boolean('is_assessable').notNull().default(true),
  appliesWhen: jsonb('applies_when'),
  displayOrder: integer('display_order').notNull().default(0),
  weight: numeric('weight'),
  ...provenance(),
  ...editedByPerson(),
}, (t) => [
  uniqueIndex('requirement_version_code_idx').on(t.frameworkVersionId, t.code),
  index('requirement_parent_idx').on(t.parentId),
  ...provenanceChecks('requirement', t),
]);

const NOTE_TYPES = ['guidance', 'evidence_expectation', 'data_request', 'quantitative_norm'] as const;
export const NOTE_AUTHORITIES = ['required', 'example', 'suggested', 'ai_suggested', 'institution_defined'] as const;
export const requirementNote = pgTable('requirement_note', {
  ...base(), ...tenant(),
  requirementId: uuid('requirement_id').notNull().references(() => requirement.id),
  type: text('type', { enum: NOTE_TYPES }).notNull(),
  text: text('text').notNull(),
  authority: text('authority', { enum: NOTE_AUTHORITIES }).notNull(),
  norm: jsonb('norm'),
  ...provenance(),
  ...editedByPerson(),
}, (t) => [
  index('requirement_note_requirement_idx').on(t.requirementId),
  oneOf('requirement_note_type_check', t.type, NOTE_TYPES),
  oneOf('requirement_note_authority_check', t.authority, NOTE_AUTHORITIES),
  ...provenanceChecks('requirement_note', t),
]);

const TEMPLATE_KINDS = ['application', 'readiness', 'self_study', 'follow_up', 'annual', 'response', 'other'] as const;
export const reportTemplate = pgTable('report_template', {
  ...base(), ...tenant(),
  frameworkVersionId: uuid('framework_version_id').notNull().references(() => frameworkVersion.id),
  key: text('key').notNull(),
  name: text('name').notNull(),
  kind: text('kind', { enum: TEMPLATE_KINDS }).notNull(),
  language: text('language').notNull().default('en'),
  structure: jsonb('structure').notNull().default(sql`'{}'::jsonb`),
  wordLimit: integer('word_limit'),
  requiresAttestation: boolean('requires_attestation').notNull().default(false),
  ...provenance(),
}, (t) => [
  uniqueIndex('report_template_version_key_idx').on(t.frameworkVersionId, t.key),
  oneOf('report_template_kind_check', t.kind, TEMPLATE_KINDS),
  ...provenanceChecks('report_template', t),
]);

/**
 * One framework analysis (PRD 15, step C) of a draft version's sources. Each stage runs as its own job; `progress` holds
 * the stage and the position inside it so a retried job resumes there. `usage` is the run's AI spend across all its jobs
 * (the per-run budget of Settings -> AI applies to the total). At most one run per version is queued or running.
 */
export const analysisRun = pgTable('analysis_run', {
  ...base(), ...tenant(),
  frameworkVersionId: uuid('framework_version_id').notNull().references(() => frameworkVersion.id),
  status: text('status', { enum: ANALYSIS_STATUSES }).notNull().default('queued'),
  stage: text('stage', { enum: ANALYSIS_STAGES }),
  progress: jsonb('progress').$type<AnalysisProgress>().notNull().default(sql`'{}'::jsonb`),
  model: text('model'),
  promptVersions: jsonb('prompt_versions').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  usage: jsonb('usage').$type<AnalysisUsage>().notNull().default(sql`'{"inputTokens":0,"outputTokens":0,"costUsd":null,"calls":0}'::jsonb`),
  error: text('error'),
  startedBy: uuid('started_by').references((): AnyPgColumn => appUser.id),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  report: jsonb('report').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
}, (t) => [
  index('analysis_run_version_idx').on(t.frameworkVersionId, t.createdAt),
  uniqueIndex('analysis_run_one_active_idx').on(t.frameworkVersionId).where(sql`${t.status} in ('queued', 'running')`),
  oneOf('analysis_run_status_check', t.status, ANALYSIS_STATUSES),
  check('analysis_run_stage_check', sql`${t.stage} is null or ${t.stage} in (${sql.raw(ANALYSIS_STAGES.map((v) => `'${v}'`).join(', '))})`),
]);

export const DISMISSAL_KINDS = ['requirement', 'note'] as const;
/**
 * A requirement or note the analysis made and a person deleted (step D): a later run must not add it back. Written only
 * by the database (trigger `record_ai_dismissal` on DELETE of an AI row by anyone but the worker), keyed by version and
 * code, plus the note's text for a note (its fingerprint is computed in packages/core, which owns text normalisation).
 */
export const analysisDismissal = pgTable('analysis_dismissal', {
  ...base(), ...tenant(),
  frameworkVersionId: uuid('framework_version_id').notNull().references(() => frameworkVersion.id),
  kind: text('kind', { enum: DISMISSAL_KINDS }).notNull(),
  code: text('code').notNull(),
  noteText: text('note_text'),
}, (t) => [
  index('analysis_dismissal_version_idx').on(t.frameworkVersionId),
  oneOf('analysis_dismissal_kind_check', t.kind, DISMISSAL_KINDS),
  check('analysis_dismissal_note_text_check', sql`(${t.kind} = 'note') = (${t.noteText} is not null)`),
]);

// ---- 6.4 Engagements & roadmap --------------------------------------------------------------


export const engagement = pgTable('engagement', {
  ...base(), ...tenant(),
  frameworkVersionId: uuid('framework_version_id').notNull().references(() => frameworkVersion.id),
  subjectType: text('subject_type', { enum: ENGAGEMENT_SUBJECT_TYPES }).notNull(),
  // The institution or program id; polymorphic, so no foreign key (validated by the service).
  subjectId: uuid('subject_id').notNull(),
  kind: text('kind', { enum: ENGAGEMENT_KINDS }).notNull(),
  title: text('title').notNull(),
  reviewYear: integer('review_year').notNull(),
  keyDates: jsonb('key_dates').notNull().default(sql`'{}'::jsonb`),
  currentPhase: text('current_phase', { enum: PHASE_TYPES }),
  status: text('status', { enum: ENGAGEMENT_STATUSES }).notNull().default('active'),
  withdrawnReason: text('withdrawn_reason'),
  leadUserId: uuid('lead_user_id').notNull().references(() => appUser.id),
  previousEngagementId: uuid('previous_engagement_id').references((): AnyPgColumn => engagement.id),
  templateSyncedVersionId: uuid('template_synced_version_id').references(() => frameworkVersion.id),
}, (t) => [
  index('engagement_subject_idx').on(t.subjectType, t.subjectId),
  index('engagement_version_idx').on(t.frameworkVersionId),
  index('engagement_lead_idx').on(t.leadUserId),
  oneOf('engagement_subject_type_check', t.subjectType, ENGAGEMENT_SUBJECT_TYPES),
  oneOf('engagement_kind_check', t.kind, ENGAGEMENT_KINDS),
  oneOf('engagement_status_check', t.status, ENGAGEMENT_STATUSES),
  check('engagement_current_phase_check', sql`${t.currentPhase} is null or ${t.currentPhase} in ('eligibility', 'self_study', 'review', 'decision', 'maintenance')`),
  check('engagement_review_year_check', sql`${t.reviewYear} between 1990 and 2200`),
  check('engagement_withdrawn_reason', sql`${t.status} <> 'withdrawn' or length(trim(coalesce(${t.withdrawnReason}, ''))) > 0`),
]);

export const milestone = pgTable('milestone', {
  ...base(), ...tenant(),
  engagementId: uuid('engagement_id').notNull().references(() => engagement.id),
  // Key of the template milestone this was generated from; null for local, decision and response milestones.
  templateKey: text('template_key'),
  phase: text('phase', { enum: PHASE_TYPES }).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  type: text('type', { enum: MILESTONE_TYPES }).notNull(),
  dueDate: date('due_date'),
  dueRule: jsonb('due_rule'),
  dateNeeded: boolean('date_needed').notNull().default(false),
  ownerId: uuid('owner_id').references(() => appUser.id),
  status: text('status', { enum: MILESTONE_STATUSES }).notNull().default('not_started'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  // The report this milestone produces (M4). `deliverable` holds {report_template_key} from the template.
  reportId: uuid('report_id'),
  deliverable: jsonb('deliverable'),
  sourceRef: jsonb('source_ref'),
  recurrence: jsonb('recurrence'),
  displayOrder: integer('display_order').notNull().default(0),
  origin: text('origin', { enum: MILESTONE_ORIGINS }).notNull().default('template'),
  locked: boolean('locked').notNull().default(false),
  required: boolean('required').notNull().default(true),
  skipReason: text('skip_reason'),
}, (t) => [
  index('milestone_engagement_idx').on(t.engagementId, t.phase, t.displayOrder),
  uniqueIndex('milestone_engagement_template_key_idx').on(t.engagementId, t.templateKey).where(sql`${t.templateKey} is not null and ${t.recurrence} is null`),
  oneOf('milestone_phase_check', t.phase, PHASE_TYPES),
  oneOf('milestone_type_check', t.type, MILESTONE_TYPES),
  oneOf('milestone_status_check', t.status, MILESTONE_STATUSES),
  oneOf('milestone_origin_check', t.origin, MILESTONE_ORIGINS),
  check('milestone_skip_reason', sql`${t.status} <> 'skipped' or ${t.required} = false or length(trim(coalesce(${t.skipReason}, ''))) > 0`),
  check('milestone_done_completed_at', sql`${t.status} <> 'done' or ${t.completedAt} is not null`),
]);

export const engagementRequirement = pgTable('engagement_requirement', {
  ...base(), ...tenant(),
  engagementId: uuid('engagement_id').notNull().references(() => engagement.id),
  requirementId: uuid('requirement_id').notNull().references(() => requirement.id),
  applicable: boolean('applicable').notNull().default(true),
  naReason: text('na_reason'),
  ownerId: uuid('owner_id').references(() => appUser.id),
  reviewerId: uuid('reviewer_id').references(() => appUser.id),
  status: text('status', { enum: ENGAGEMENT_REQUIREMENT_STATUSES }).notNull().default('not_started'),
  workingNotes: text('working_notes'),
  selfRating: real('self_rating'),
  dueDate: date('due_date'),
}, (t) => [
  uniqueIndex('engagement_requirement_unique_idx').on(t.engagementId, t.requirementId),
  index('engagement_requirement_owner_idx').on(t.ownerId),
  oneOf('engagement_requirement_status_check', t.status, ENGAGEMENT_REQUIREMENT_STATUSES),
]);

// ---- Glossary: the institution's own terms and the external terms they stand for (DEC-016) -----------------------

export const GLOSSARY_KINDS = ['level', 'finding', 'report', 'general'] as const;
export const ALIAS_SOURCES = ['level_label', 'finding_code', 'report_template'] as const;

/** An internal term: one shared word for what each accreditor calls differently. Owned by the institution, so it can change without touching a published standard. */
export const glossaryTerm = pgTable('glossary_term', {
  ...base(), ...tenant(),
  key: text('key').notNull(),
  kind: text('kind', { enum: GLOSSARY_KINDS }).notNull(),
  labelEn: text('label_en').notNull(),
  labelAr: text('label_ar'),
  definitionEn: text('definition_en'),
  definitionAr: text('definition_ar'),
  active: boolean('active').notNull().default(true),
}, (t) => [
  uniqueIndex('glossary_term_key_idx').on(t.institutionId, t.key),
  oneOf('glossary_term_kind_check', t.kind, GLOSSARY_KINDS),
  check('glossary_term_key_format', sql`${t.key} ~ '^[a-z][a-z0-9_]*$'`),
]);

/** What an external standard calls it: a level label ("CFR"), a finding code ("deficiency") or a report template key, mapped to an internal term. Keyed by the standard (framework), not a version. */
export const glossaryAlias = pgTable('glossary_alias', {
  ...base(), ...tenant(),
  termId: uuid('term_id').notNull().references(() => glossaryTerm.id),
  frameworkId: uuid('framework_id').notNull().references(() => framework.id),
  source: text('source', { enum: ALIAS_SOURCES }).notNull(),
  externalTerm: text('external_term').notNull(),
}, (t) => [
  uniqueIndex('glossary_alias_unique_idx').on(t.frameworkId, t.source, t.externalTerm),
  index('glossary_alias_term_idx').on(t.termId),
  oneOf('glossary_alias_source_check', t.source, ALIAS_SOURCES),
]);

export const MAPPING_RELATIONS = ['covers', 'partly_covers', 'related'] as const;
/**
 * An external requirement mapped onto an item of the institution's own quality framework (DEC-016). Owned by the
 * institution and keyed by requirement codes within each framework, not by version, so a mapping carries over to a new
 * version of either side. Never "equivalent": the relation says how much of the external requirement the internal item
 * answers. Proposed by a person or the AI; only a person approves.
 */
export const requirementMapping = pgTable('requirement_mapping', {
  ...base(), ...tenant(),
  frameworkId: uuid('framework_id').notNull().references(() => framework.id),
  externalCode: text('external_code').notNull(),
  internalFrameworkId: uuid('internal_framework_id').notNull().references(() => framework.id),
  internalCode: text('internal_code').notNull(),
  relation: text('relation', { enum: MAPPING_RELATIONS }).notNull(),
  rationale: text('rationale'),
  origin: text('origin', { enum: ORIGINS }).notNull().default('manual'),
  reviewStatus: text('review_status', { enum: REVIEW_STATUSES }).notNull().default('pending'),
  reviewedBy: uuid('reviewed_by').references((): AnyPgColumn => appUser.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  /** A person changed a link the analysis proposed (set by the database): a later run leaves it alone. */
  ...editedByPerson(),
}, (t) => [
  uniqueIndex('requirement_mapping_unique_idx').on(t.frameworkId, t.externalCode, t.internalCode),
  index('requirement_mapping_internal_idx').on(t.internalFrameworkId, t.internalCode),
  oneOf('requirement_mapping_relation_check', t.relation, MAPPING_RELATIONS),
  oneOf('requirement_mapping_origin_check', t.origin, ORIGINS),
  oneOf('requirement_mapping_review_status_check', t.reviewStatus, REVIEW_STATUSES),
]);

export const IQF_PROPOSAL_STATUSES = ['pending', 'accepted', 'dismissed', 'superseded'] as const;
/**
 * A NEW item of the institution's quality framework (IQF) the analysis suggests because nothing in it fits some external
 * requirements (step E, DEC-021/022/023). Only a proposal: nothing is in the IQF until a person accepts it, which creates
 * the item in the IQF's draft and the links (accepted). The wording is the model's, in the IQF's own terms. The external
 * requirements are named by code within the standard (like requirement_mapping), `links` holds each one's relation and the
 * model's reason. Dismissed and accepted proposals are remembered, so a re-run does not propose the same need again.
 */
export const iqfItemProposal = pgTable('iqf_item_proposal', {
  ...base(), ...tenant(),
  frameworkId: uuid('framework_id').notNull().references(() => framework.id),
  frameworkVersionId: uuid('framework_version_id').notNull().references(() => frameworkVersion.id),
  internalFrameworkId: uuid('internal_framework_id').notNull().references(() => framework.id),
  analysisRunId: uuid('analysis_run_id').references(() => analysisRun.id),
  status: text('status', { enum: IQF_PROPOSAL_STATUSES }).notNull().default('pending'),
  /** The IQF item it would sit under, by code; null for a top-level item. */
  parentCode: text('parent_code'),
  levelLabel: text('level_label').notNull(),
  code: text('code').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  reason: text('reason'),
  links: jsonb('links').$type<{ externalCode: string; relation: string; reason: string | null }[]>().notNull().default(sql`'[]'::jsonb`),
  decidedBy: uuid('decided_by').references((): AnyPgColumn => appUser.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  acceptedRequirementId: uuid('accepted_requirement_id').references((): AnyPgColumn => requirement.id, { onDelete: 'set null' }),
}, (t) => [
  index('iqf_item_proposal_version_idx').on(t.frameworkVersionId, t.status),
  oneOf('iqf_item_proposal_status_check', t.status, IQF_PROPOSAL_STATUSES),
  check('iqf_item_proposal_links_check', sql`jsonb_typeof(${t.links}) = 'array'`),
]);

// ---- 6.5 Evidence (M3) ----------------------------------------------------------------------------------------

/** Kept simple for now: a document (a file people read) or data (figures the system reads). Kinds come later as sub-types. */
export const EVIDENCE_TYPES = ['document', 'data'] as const;
export const CONFIDENTIALITY = ['public', 'internal', 'restricted'] as const;
/** A piece of evidence owned by the institution, not by an engagement: stored once, linked many times. */
export const evidenceItem = pgTable('evidence_item', {
  ...base(), ...tenant(),
  title: text('title').notNull(),
  description: text('description'),
  type: text('type', { enum: EVIDENCE_TYPES }).notNull(),
  /** The kind within the type (policy, minutes, report …): kept for the sub-types to come, not shown yet. */
  subtype: text('subtype'),
  ownerUnitId: uuid('owner_unit_id').references(() => orgUnit.id),
  ownerUserId: uuid('owner_user_id').references(() => appUser.id),
  periodLabel: text('period_label'),
  confidentiality: text('confidentiality', { enum: CONFIDENTIALITY }).notNull().default('internal'),
  containsStudentData: boolean('contains_student_data').notNull().default(false),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
}, (t) => [
  oneOf('evidence_item_type_check', t.type, EVIDENCE_TYPES),
  oneOf('evidence_item_confidentiality_check', t.confidentiality, CONFIDENTIALITY),
  oneOf('evidence_item_status_check', t.status, ['active', 'archived']),
]);

/** One upload (or registered link) of an evidence item. New upload → new version; versions are never changed. */
export const evidenceVersion = pgTable('evidence_version', {
  ...base(), ...tenant(),
  evidenceItemId: uuid('evidence_item_id').notNull().references(() => evidenceItem.id),
  versionNo: integer('version_no').notNull(),
  filePath: text('file_path'),
  url: text('url'),
  sha256: text('sha256'),
  fileName: text('file_name'),
  mime: text('mime'),
  size: integer('size'),
  asOfDate: date('as_of_date'),
  notes: text('notes'),
  data: jsonb('data'),
  lineage: jsonb('lineage'),
}, (t) => [
  uniqueIndex('evidence_version_no_idx').on(t.evidenceItemId, t.versionNo),
  check('evidence_version_content', sql`(${t.filePath} is not null and ${t.sha256} is not null) or ${t.url} is not null or ${t.data} is not null`),
]);

export const LINK_REVIEW = ['proposed', 'approved', 'rejected'] as const;
/**
 * Evidence version → what it supports, with the reason (required). The target is either a requirement of an
 * engagement (what goes to the accreditor) or an item of the institution's own framework, keyed by code within that
 * framework so it carries over to new versions of it (DEC-016). Exactly one target.
 */
export const evidenceLink = pgTable('evidence_link', {
  ...base(), ...tenant(),
  evidenceVersionId: uuid('evidence_version_id').notNull().references(() => evidenceVersion.id),
  engagementRequirementId: uuid('engagement_requirement_id').references(() => engagementRequirement.id),
  internalFrameworkId: uuid('internal_framework_id').references(() => framework.id),
  internalCode: text('internal_code'),
  rationale: text('rationale').notNull(),
  linkedBy: uuid('linked_by').references(() => appUser.id),
  reviewStatus: text('review_status', { enum: LINK_REVIEW }).notNull().default('proposed'),
  reviewedBy: uuid('reviewed_by').references(() => appUser.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewComment: text('review_comment'),
}, (t) => [
  index('evidence_link_version_idx').on(t.evidenceVersionId),
  index('evidence_link_er_idx').on(t.engagementRequirementId),
  index('evidence_link_internal_idx').on(t.internalFrameworkId, t.internalCode),
  oneOf('evidence_link_review_check', t.reviewStatus, LINK_REVIEW),
  check('evidence_link_rationale', sql`length(trim(${t.rationale})) > 0`),
  check('evidence_link_one_target', sql`(${t.engagementRequirementId} is not null) <> (${t.internalFrameworkId} is not null and ${t.internalCode} is not null)`),
]);

export const REQUEST_STATUSES = ['open', 'supplied', 'cancelled'] as const;
/**
 * A request for evidence on an item of the internal framework, sent to a person by email address (DEC-018). An AMS
 * user answers from their requests; anyone else through a one-time link, kept here only as a hash. The response becomes
 * evidence with a proposed link (`evidenceLinkId`) that a reviewer approves or rejects.
 */
export const evidenceRequest = pgTable('evidence_request', {
  ...base(), ...tenant(),
  internalFrameworkId: uuid('internal_framework_id').references(() => framework.id),
  internalCode: text('internal_code'),
  /** A request to fill in this data item's form; null for a request for a file. */
  dataItemId: uuid('data_item_id').references(() => evidenceItem.id),
  title: text('title').notNull(),
  message: text('message'),
  assigneeEmail: text('assignee_email').notNull(),
  assigneeUserId: uuid('assignee_user_id').references(() => appUser.id),
  dueDate: date('due_date'),
  status: text('status', { enum: REQUEST_STATUSES }).notNull().default('open'),
  requestedBy: uuid('requested_by').references(() => appUser.id),
  tokenHash: text('token_hash'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  suppliedAt: timestamp('supplied_at', { withTimezone: true }),
  suppliedNote: text('supplied_note'),
  evidenceLinkId: uuid('evidence_link_id').references(() => evidenceLink.id, { onDelete: 'set null' }),
  /** For a form request: the response it was answered with. */
  responseId: uuid('response_id').references((): AnyPgColumn => datasetResponse.id),
}, (t) => [
  check('evidence_request_target', sql`(${t.internalFrameworkId} is not null and ${t.internalCode} is not null) or ${t.dataItemId} is not null`),
  index('evidence_request_data_item_idx').on(t.dataItemId),
  index('evidence_request_internal_idx').on(t.internalFrameworkId, t.internalCode),
  index('evidence_request_assignee_idx').on(t.assigneeUserId),
  uniqueIndex('evidence_request_token_idx').on(t.tokenHash),
  oneOf('evidence_request_status_check', t.status, REQUEST_STATUSES),
  check('evidence_request_title', sql`length(trim(${t.title})) > 0`),
]);

export const DATASET_SOURCE_KINDS = ['manual_upload', 'governed_metric'] as const;
/**
 * The definition of a data item (PRD 9.4): what it means, its grain, its columns. One per data item. Each saved version
 * keeps its own copy of the columns, so changing the definition never changes data already saved.
 */
export const datasetSpec = pgTable('dataset_spec', {
  ...base(), ...tenant(),
  evidenceItemId: uuid('evidence_item_id').notNull().references(() => evidenceItem.id),
  definition: text('definition'),
  grain: text('grain'),
  columns: jsonb('columns').notNull().default(sql`'[]'::jsonb`),
  sourceKind: text('source_kind', { enum: DATASET_SOURCE_KINDS }).notNull().default('manual_upload'),
  sourceConfig: jsonb('source_config'),
  /** The form (DEC-020): whether it takes responses, and the public link's secret when there is one. */
  formOpen: boolean('form_open').notNull().default(false),
  formLinkToken: text('form_link_token'),
}, (t) => [
  uniqueIndex('dataset_spec_item_idx').on(t.evidenceItemId),
  uniqueIndex('dataset_spec_form_link_idx').on(t.formLinkToken),
  oneOf('dataset_spec_source_check', t.sourceKind, DATASET_SOURCE_KINDS),
]);

export const RESPONSE_VIA = ['ams', 'link'] as const;
/**
 * One answer to a data item's form (DEC-020): a row, checked against the columns when it was given. It joins the data
 * when someone adds it, which saves the next version (`includedInVersionId`); its answers never change.
 */
export const datasetResponse = pgTable('dataset_response', {
  ...base(), ...tenant(),
  evidenceItemId: uuid('evidence_item_id').notNull().references(() => evidenceItem.id),
  answers: jsonb('answers').notNull(),
  via: text('via', { enum: RESPONSE_VIA }).notNull(),
  submittedBy: uuid('submitted_by').references(() => appUser.id),
  includedInVersionId: uuid('included_in_version_id').references(() => evidenceVersion.id),
}, (t) => [
  index('dataset_response_item_idx').on(t.evidenceItemId),
  oneOf('dataset_response_via_check', t.via, RESPONSE_VIA),
]);
