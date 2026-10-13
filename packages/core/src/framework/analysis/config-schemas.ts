// What the model must answer at each configuration stage of the framework analysis (step H; PRD 15.1 step 4, Appendix B).
// aiExtract validates every answer against these. Shapes are loose where a model may be unsure (nullish) and strict about
// what the verification needs: every item has a page and a quote. Turning an answer into the version's configuration
// (and refusing what does not fit its schemas) is config-merge.ts.
import { BLOCK_TYPES, ENGAGEMENT_KINDS, MILESTONE_TYPES, OUTCOMES, PHASE_TYPES, REPLY_KINDS, TEMPLATE_KINDS } from '@ams/shared';
import { z } from 'zod';

/** Prompt versions of the configuration stages; recorded on the run next to the others (ANALYSIS_PROMPTS). */
export const CONFIG_PROMPTS = { config_survey: 'v1', lifecycle: 'v1', vocab: 'v1', template: 'v1' } as const;

/** Roles whose documents the configuration stages read. A report_template document is read for a template only. */
export const CONFIG_ROLES = new Set(['policy_procedure', 'report_template', 'guidance']);

const part = z.object({ present: z.boolean(), pages: z.array(z.number().int()).default([]) });
/** config_survey: which of the three targets a document holds, and on which pages. */
export const ConfigSurveySchema = z.object({
  lifecycle: part,
  vocab: part,
  template: part.extend({ name: z.string().nullish(), kind: z.enum(TEMPLATE_KINDS).nullish() }),
  note: z.string().nullish(),
});
export type ConfigSurvey = z.infer<typeof ConfigSurveySchema>;

const source = z.object({ page: z.number().int(), quote: z.string() });
const common = {
  temp_id: z.string(),
  /** The sentence(s) the item comes from, copied. */
  text: z.string().nullish(),
  source,
  confidence: z.number().min(0).max(1).nullish(),
  flags: z.array(z.string()).default([]),
};

export const LifecycleItemSchema = z.object({
  kind: z.enum(['phase', 'milestone']),
  phase_temp_id: z.string().nullish(),
  phase_type: z.enum(PHASE_TYPES).nullish(),
  name: z.string(),
  milestone_type: z.enum(MILESTONE_TYPES).nullish(),
  applies_to: z.array(z.enum(ENGAGEMENT_KINDS)).nullish(),
  required: z.boolean().nullish(),
  due_text: z.string().nullish(),
  repeat_text: z.string().nullish(),
  deliverable_name: z.string().nullish(),
  ...common,
});
export type LifecycleItem = z.infer<typeof LifecycleItemSchema>;
export const LifecycleExtractSchema = z.object({ items: z.array(LifecycleItemSchema) });

export const VocabItemSchema = z.object({
  kind: z.enum(['decision', 'finding_severity', 'response_type', 'rating_method']),
  label: z.string(),
  printed_code: z.string().nullish(),
  outcome: z.enum(OUTCOMES).nullish(),
  term_years: z.number().int().nullish(),
  term_options: z.array(z.number().int()).nullish(),
  requires_action: z.boolean().nullish(),
  reply_required: z.boolean().nullish(),
  reply_window_days: z.number().int().nullish(),
  reply_kind: z.enum(REPLY_KINDS).nullish(),
  is_decision: z.boolean().nullish(),
  scale: z.array(z.number()).nullish(),
  labels: z.array(z.string()).nullish(),
  rated_level: z.string().nullish(),
  aggregate: z.string().nullish(),
  ...common,
});
export type VocabItem = z.infer<typeof VocabItemSchema>;
export const VocabExtractSchema = z.object({ items: z.array(VocabItemSchema) });

export const TemplateItemSchema = z.object({
  kind: z.literal('report_section'),
  parent_temp_id: z.string().nullish(),
  number: z.string().nullish(),
  parent_number: z.string().nullish(),
  title: z.string(),
  prompt: z.string().nullish(),
  block_type: z.enum(BLOCK_TYPES),
  word_limit: z.number().int().nullish(),
  columns: z.array(z.object({ label: z.string(), type: z.enum(['text', 'number', 'date', 'enum']), options: z.array(z.string()).nullish() })).nullish(),
  ...common,
});
export type TemplateItem = z.infer<typeof TemplateItemSchema>;
export const TemplateExtractSchema = z.object({ items: z.array(TemplateItemSchema) });

/** The extraction_item kind each answer kind is logged under (Appendix B); a phase and a rating method are "metadata". */
export const CONFIG_ITEM_KIND = {
  phase: 'metadata', milestone: 'milestone', decision: 'decision', finding_severity: 'finding_severity', response_type: 'response_type',
  rating_method: 'metadata', report_section: 'report_section',
} as const;
export const CONFIG_LOG_KINDS = ['metadata', 'milestone', 'decision', 'finding_severity', 'response_type', 'report_section'] as const;
