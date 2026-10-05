import { sql } from 'drizzle-orm';
import {
  boolean, check, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid, type AnyPgColumn,
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
});

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

export const ROLES = [
  'admin', 'lead', 'engagement_lead', 'co_lead', 'contributor', 'reviewer', 'viewer', 'external_reviewer',
] as const;
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

export const JOB_TYPES = ['extract_text', 'ocr', 'ai_extract', 'export', 'notify'] as const;
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
// framework_version_id and source_document_id are plain uuids for now: their tables arrive in M1 (ROADMAP-002),
// which adds the foreign keys.
const EXTRACTION_STATUSES = ['pending', 'accepted', 'edited', 'rejected'] as const;
export const extractionItem = pgTable('extraction_item', {
  ...base(), ...tenant(),
  frameworkVersionId: uuid('framework_version_id').notNull(),
  jobId: uuid('job_id').references(() => job.id),
  kind: text('kind', { enum: EXTRACTION_KINDS }).notNull(),
  payload: jsonb('payload').notNull(),
  sourceDocumentId: uuid('source_document_id'),
  sourcePage: integer('source_page'),
  sourceQuote: text('source_quote'),
  quoteVerified: boolean('quote_verified').notNull().default(false),
  confidence: real('confidence'),
  flags: text('flags').array().notNull().default(sql`'{}'::text[]`),
  status: text('status', { enum: EXTRACTION_STATUSES }).notNull().default('pending'),
  reviewedBy: uuid('reviewed_by').references(() => appUser.id),
}, (t) => [
  index('extraction_item_version_idx').on(t.frameworkVersionId, t.status),
  oneOf('extraction_item_kind_check', t.kind, EXTRACTION_KINDS),
  oneOf('extraction_item_status_check', t.status, EXTRACTION_STATUSES),
]);
