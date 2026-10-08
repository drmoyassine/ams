// Zod schemas for everything a framework version configures (PRD 7.1-7.6, 10.2). One schema set, reused by the
// API, the SPA editors, the importer and the worker. Nothing here may branch on an accreditor's identity (DEC-002).
import { z } from 'zod';

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'letters, digits, _ . - only');
const monthDay = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/, 'MM-DD').refine((v) => {
  const [m, d] = v.split('-').map(Number) as [number, number];
  return d <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}, 'not a real calendar date');

export const KEY_DATES = ['submission_date', 'visit_date', 'decision_date', 'expiry_date'] as const;
export const ENGAGEMENT_KINDS = ['initial', 'reaffirmation'] as const;
export const PHASE_TYPES = ['eligibility', 'self_study', 'review', 'decision', 'maintenance'] as const;
export const MILESTONE_TYPES = ['task', 'deliverable', 'submission', 'external_event', 'decision_point'] as const;
export const OUTCOMES = [
  'eligible', 'candidate', 'accredited', 'accredited_with_conditions', 'deferred', 'sanctioned', 'not_accredited', 'withdrawn',
] as const;
export const REPLY_KINDS = ['report', 'revision', 'report_and_revision', 'letter', 'none'] as const;
export const BLOCK_TYPES = ['narrative', 'data_table', 'compliance_matrix', 'evidence_index', 'feedback_response', 'attestation', 'appendix'] as const;
export const TEMPLATE_KINDS = ['application', 'readiness', 'self_study', 'follow_up', 'annual', 'response', 'other'] as const;

// ---- 7.1, 7.3 ---------------------------------------------------------------------------------

export const LevelLabelsSchema = z.array(z.string().min(1)).min(1);

export const AppliesWhenSchema = z.object({
  scope: z.array(z.enum(['institution', 'program'])).optional(),
  degree_level: z.array(z.string().min(1)).optional(),
  program_tags: z.array(z.string().min(1)).optional(),
  engagement_kind: z.array(z.enum(ENGAGEMENT_KINDS)).optional(),
}).strict().nullable();

// ---- 7.4 ----------------------------------------------------------------------------------------

/** Exactly one form, or null for "set manually". */
export const DueRuleSchema = z.union([
  z.object({ fixed: monthDay, year_offset: z.number().int() }).strict(),
  z.object({ anchor: z.enum(KEY_DATES), offset_days: z.number().int() }).strict(),
  z.object({ after: key, offset_days: z.number().int() }).strict(),
]).nullable();
export type DueRule = z.infer<typeof DueRuleSchema>;

export const RecurrenceSchema = z.object({ every: z.literal('year'), month_day: monthDay }).strict();
export const SourceRefSchema = z.object({ doc: z.string().min(1), page: z.number().int().min(1) }).strict();

export const MilestoneTemplateSchema = z.object({
  key,
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(MILESTONE_TYPES),
  deliverable: z.object({ report_template_key: key }).strict().optional(),
  due: DueRuleSchema.optional(),
  recurrence: RecurrenceSchema.optional(),
  applies_to: z.array(z.enum(ENGAGEMENT_KINDS)).min(1).optional(),
  required: z.boolean().default(true),
  source_ref: SourceRefSchema.optional(),
}).strict();

export const PhaseTemplateSchema = z.object({
  type: z.enum(PHASE_TYPES),
  name: z.string().min(1),
  applies_to: z.array(z.enum(ENGAGEMENT_KINDS)).min(1),
  milestones: z.array(MilestoneTemplateSchema),
}).strict();

export const LifecycleTemplateSchema = z.object({
  phases: z.array(PhaseTemplateSchema).min(1),
  next_cycle: z.object({ start_offset_days_before_expiry: z.number().int().positive() }).strict().optional(),
}).strict();
export type LifecycleTemplate = z.infer<typeof LifecycleTemplateSchema>;

// ---- 7.5 ----------------------------------------------------------------------------------------

export const FollowUpSchema = z.object({
  milestone_key: key,
  name: z.string().min(1),
  type: z.enum(MILESTONE_TYPES).optional(),
  deliverable: z.object({ report_template_key: key }).strict().optional(),
  due: DueRuleSchema,
}).strict();

export const DecisionVocabSchema = z.array(z.object({
  code: key,
  label: z.string().min(1),
  outcome: z.enum(OUTCOMES),
  term_years: z.number().int().positive().optional(),
  term_options: z.array(z.number().int().positive()).min(1).optional(),
  follow_up: z.array(FollowUpSchema).optional(),
}).strict());

export const FindingVocabSchema = z.array(z.object({
  code: key, label: z.string().min(1), requires_action: z.boolean(),
}).strict());

export const ResponseVocabSchema = z.array(z.object({
  code: key,
  label: z.string().min(1),
  reply_required: z.boolean().optional(),
  reply_window_days: z.number().int().positive().optional(),
  reply_due: DueRuleSchema.optional(),
  reply_kind: z.enum(REPLY_KINDS).optional(),
  reply_template_key: key.optional(),
  item_categories: z.array(z.string().min(1)).optional(),
  is_decision: z.boolean().optional(),
}).strict());

// ---- 7.6 ----------------------------------------------------------------------------------------

export const RatingMethodSchema = z.object({
  scale: z.array(z.number()).min(2),
  labels: z.array(z.string().min(1)),
  rated_level: z.string().min(1),
  aggregate: z.string().min(1),
}).strict().refine((r) => r.labels.length === r.scale.length, { message: 'labels and scale must have the same length' }).nullable();

// ---- 10.2 ---------------------------------------------------------------------------------------

export const ColumnSchema = z.object({
  key,
  label: z.string().min(1),
  type: z.enum(['text', 'number', 'date', 'enum']),
  options: z.array(z.string().min(1)).min(1).optional(),
}).strict().refine((c) => (c.type === 'enum') === (c.options !== undefined), { message: 'options are required for enum columns and only for them' });

export interface SectionTemplate {
  key: string;
  title: string;
  block_type: (typeof BLOCK_TYPES)[number];
  prompt?: string | undefined;
  requirement_codes?: string[] | undefined;
  word_limit?: number | null | undefined;
  columns?: z.infer<typeof ColumnSchema>[] | undefined;
  dataset_binding?: unknown;
  children?: SectionTemplate[] | undefined;
}

export const SectionTemplateSchema: z.ZodType<SectionTemplate> = z.lazy(() => z.object({
  key,
  title: z.string().min(1),
  block_type: z.enum(BLOCK_TYPES),
  prompt: z.string().optional(),
  requirement_codes: z.array(z.string().min(1)).optional(),
  word_limit: z.number().int().positive().nullable().optional(),
  columns: z.array(ColumnSchema).min(1).optional(),
  dataset_binding: z.unknown().optional(),
  children: z.array(SectionTemplateSchema).optional(),
}).strict().refine((s) => s.block_type !== 'data_table' || s.dataset_binding !== undefined || (s.columns?.length ?? 0) > 0, {
  message: 'a data_table needs columns (or a dataset_binding)',
}));

export const ReportTemplateStructureSchema = z.object({ sections: z.array(SectionTemplateSchema).min(1) }).strict();

export const ReportTemplateConfigSchema = z.object({
  key,
  name: z.string().min(1),
  kind: z.enum(TEMPLATE_KINDS),
  language: z.string().min(2).default('en'),
  structure: ReportTemplateStructureSchema,
  word_limit: z.number().int().positive().nullable().default(null),
  requires_attestation: z.boolean().default(false),
}).strict();

// ---- Whole-version validation ---------------------------------------------------------------------

export const FrameworkConfigSchema = z.object({
  level_labels: LevelLabelsSchema,
  lifecycle_template: LifecycleTemplateSchema,
  decision_vocab: DecisionVocabSchema,
  finding_vocab: FindingVocabSchema,
  response_vocab: ResponseVocabSchema,
  rating_method: RatingMethodSchema.optional(),
  report_templates: z.array(ReportTemplateConfigSchema),
}).strict();
export type FrameworkConfig = z.infer<typeof FrameworkConfigSchema>;

export interface ConfigIssue { path: string; message: string }

const walkSections = (sections: SectionTemplate[], visit: (s: SectionTemplate) => void) => {
  for (const s of sections) { visit(s); walkSections(s.children ?? [], visit); }
};

/**
 * Checks the references between parts of a configuration that no single schema can see. Run on save and again
 * before publishing (PRD 7.4: the lifecycle must contain exactly one milestone whose deliverable is a self_study
 * template; publishing is blocked otherwise).
 */
export function checkFrameworkConfig(c: FrameworkConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  const templates = new Map(c.report_templates.map((t) => [t.key, t]));
  if (templates.size !== c.report_templates.length) add('report_templates', 'template keys must be unique');

  const milestoneKeys = new Set<string>();
  const milestones: { m: z.infer<typeof MilestoneTemplateSchema>; path: string }[] = [];
  c.lifecycle_template.phases.forEach((p, pi) => p.milestones.forEach((m, mi) => {
    const path = `lifecycle_template.phases[${pi}].milestones[${mi}]`;
    if (milestoneKeys.has(m.key)) add(path, `duplicate milestone key ${m.key}`);
    milestoneKeys.add(m.key);
    milestones.push({ m, path });
  }));
  for (const { m, path } of milestones) {
    if (m.due && 'after' in m.due && !milestoneKeys.has(m.due.after)) add(`${path}.due`, `unknown milestone ${m.due.after}`);
    const dk = m.deliverable?.report_template_key;
    if (dk && !templates.has(dk)) add(`${path}.deliverable`, `unknown report template ${dk}`);
  }

  // Every engagement kind the lifecycle serves must produce exactly one self-study report. A milestone belongs to a
  // kind when both its phase and (if it narrows it) the milestone itself apply to that kind.
  const kinds = new Set(c.lifecycle_template.phases.flatMap((p) => p.applies_to));
  for (const kind of ENGAGEMENT_KINDS.filter((k) => kinds.has(k))) {
    const deliverers = c.lifecycle_template.phases
      .filter((p) => p.applies_to.includes(kind))
      .flatMap((p) => p.milestones)
      .filter((m) => (m.applies_to ?? ENGAGEMENT_KINDS).includes(kind) && m.deliverable && templates.get(m.deliverable.report_template_key)?.kind === 'self_study');
    if (deliverers.length !== 1) {
      add('lifecycle_template', `exactly one milestone must deliver a self_study template for ${kind} engagements (found ${deliverers.length})`);
    }
  }

  c.decision_vocab.forEach((d, di) => d.follow_up?.forEach((f, fi) => {
    const dk = f.deliverable?.report_template_key;
    if (dk && !templates.has(dk)) add(`decision_vocab[${di}].follow_up[${fi}].deliverable`, `unknown report template ${dk}`);
    if (f.due && 'after' in f.due && !milestoneKeys.has(f.due.after)) add(`decision_vocab[${di}].follow_up[${fi}].due`, `unknown milestone ${f.due.after}`);
  }));
  c.response_vocab.forEach((r, ri) => {
    if (r.reply_template_key && !templates.has(r.reply_template_key)) add(`response_vocab[${ri}].reply_template_key`, `unknown report template ${r.reply_template_key}`);
    if ((r.reply_kind === 'report' || r.reply_kind === 'report_and_revision') && !r.reply_template_key) add(`response_vocab[${ri}]`, 'reply_kind report needs reply_template_key');
  });
  for (const [label, vocab] of [['decision_vocab', c.decision_vocab], ['finding_vocab', c.finding_vocab], ['response_vocab', c.response_vocab]] as const) {
    const codes = (vocab as { code: string }[]).map((v) => v.code);
    if (new Set(codes).size !== codes.length) add(label, 'codes must be unique');
  }

  for (const t of c.report_templates) {
    const seen = new Set<string>();
    walkSections(t.structure.sections, (s) => {
      if (seen.has(s.key)) add(`report_templates.${t.key}`, `duplicate section key ${s.key}`);
      seen.add(s.key);
    });
    if (t.requires_attestation && !(() => { let found = false; walkSections(t.structure.sections, (s) => { if (s.block_type === 'attestation') found = true; }); return found; })()) {
      add(`report_templates.${t.key}`, 'requires_attestation needs an attestation section');
    }
  }
  return issues;
}

/** Parse then cross-check; returns every problem at once, as the editors show them. */
export function validateFrameworkConfig(input: unknown): { ok: true; config: FrameworkConfig } | { ok: false; issues: ConfigIssue[] } {
  const parsed = FrameworkConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }
  const issues = checkFrameworkConfig(parsed.data);
  return issues.length ? { ok: false, issues } : { ok: true, config: parsed.data };
}

// ---- 7.7 Import / export ----------------------------------------------------------------------------

export const FRAMEWORK_EXPORT_FORMAT = 'ams-framework';
export const FRAMEWORK_EXPORT_VERSION = 1;

const exportSource = z.object({ document: z.string().min(1), page: z.number().int().min(1), quote: z.string().min(1) }).strict();

export const ExportedNoteSchema = z.object({
  type: z.enum(['guidance', 'evidence_expectation', 'data_request', 'quantitative_norm']),
  text: z.string().min(1),
  authority: z.enum(['required', 'example', 'suggested', 'ai_suggested', 'institution_defined']),
  norm: z.record(z.string(), z.unknown()).nullable().default(null),
  source: exportSource.nullable().default(null),
}).strict();

export const ExportedRequirementSchema = z.object({
  code: z.string().min(1),
  parent_code: z.string().min(1).nullable(),
  level_label: z.string().min(1),
  title: z.string().min(1),
  official_text: z.string().nullable().default(null),
  language: z.string().min(2).default('en'),
  translation_en: z.string().nullable().default(null),
  is_assessable: z.boolean().default(true),
  applies_when: AppliesWhenSchema.default(null),
  display_order: z.number().int().default(0),
  weight: z.number().nonnegative().nullable().default(null),
  source: exportSource.nullable().default(null),
  notes: z.array(ExportedNoteSchema).default([]),
}).strict();

export const ExportedDocumentSchema = z.object({
  ref: z.string().min(1),
  title: z.string().min(1),
  role: z.enum(['standards', 'policy_procedure', 'guidance', 'report_template', 'evidence_guidance', 'amendment', 'sample_report', 'correspondence', 'other']),
  authority: z.enum(['binding', 'interpretive', 'informational']),
  language: z.string().min(2).default('en'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  /** Page text travels with the file so quotes can be re-verified; the original file does not. */
  pages: z.array(z.object({ page_no: z.number().int().min(1), text: z.string().min(1), method: z.enum(['pdf_text', 'ocr', 'table', 'slide', 'sheet']) }).strict()).default([]),
}).strict();

export const FrameworkExportSchema = z.object({
  format: z.literal(FRAMEWORK_EXPORT_FORMAT),
  format_version: z.literal(FRAMEWORK_EXPORT_VERSION),
  accreditor: z.object({
    name: z.string().min(1), short_name: z.string().min(1), type: z.enum(['institutional', 'programmatic', 'regulatory']),
    country: z.string().nullable().default(null), website: z.string().nullable().default(null),
  }).strict(),
  framework: z.object({
    name: z.string().min(1), commission: z.string().nullable().default(null), scope: z.enum(['institution', 'program', 'both']),
    description: z.string().nullable().default(null),
  }).strict(),
  version: z.object({
    edition: z.string().min(1), effective_from: z.string().nullable().default(null), effective_to: z.string().nullable().default(null),
    change_summary: z.string().nullable().default(null),
  }).strict(),
  config: FrameworkConfigSchema,
  source_documents: z.array(ExportedDocumentSchema).default([]),
  requirements: z.array(ExportedRequirementSchema).min(1),
}).strict();
export type FrameworkExport = z.infer<typeof FrameworkExportSchema>;
