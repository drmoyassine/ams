// What the model must answer at each AI stage of the framework analysis. aiExtract validates every answer against these.
import { z } from 'zod';

/** Prompt versions this code is written against; recorded on the run. */
export const ANALYSIS_PROMPTS = { survey: 'v1', structure: 'v1', extract: 'v1', recover: 'v1' } as const;

/** The survey's roles. "examples" is stored as the library's `sample_report` role, which never yields requirements. */
export const SURVEY_ROLES = ['standards', 'guidance', 'policy_procedure', 'report_template', 'examples', 'other'] as const;
export const SURVEY_ROLE_TO_DOCUMENT_ROLE = {
  standards: 'standards', guidance: 'guidance', policy_procedure: 'policy_procedure', report_template: 'report_template',
  examples: 'sample_report', other: 'other',
} as const satisfies Record<(typeof SURVEY_ROLES)[number], string>;

export const SurveySchema = z.object({
  role: z.enum(SURVEY_ROLES),
  language: z.string().min(2).max(12),
  outline: z.array(z.object({ heading: z.string(), page: z.number().int().nullish() })).max(200).default([]),
  confidence: z.number().min(0).max(1).nullish(),
});
export type Survey = z.infer<typeof SurveySchema>;

export const StructureSchema = z.object({
  level_labels: z.array(z.string().trim().min(1)).max(8),
  numbering: z.array(z.object({ level_label: z.string(), examples: z.array(z.string()).max(10) })).max(8).default([]),
  key_terms: z.array(z.object({ term: z.string(), meaning: z.string().nullish() })).max(60).default([]),
  scope: z.string().nullish(),
  confidence: z.number().min(0).max(1).nullish(),
});
export type Structure = z.infer<typeof StructureSchema>;

export const NOTE_TYPES = ['guidance', 'evidence_expectation', 'data_request', 'quantitative_norm'] as const;
export const AI_AUTHORITIES = ['required', 'example', 'suggested', 'ai_suggested'] as const;

/** One item of PRD Appendix B, limited to the kinds this stage writes (requirements and notes). */
export const ExtractItemSchema = z.object({
  kind: z.enum(['requirement', 'note']),
  temp_id: z.string(),
  parent_temp_id: z.string().nullish(),
  code: z.string().nullish(),
  parent_code: z.string().nullish(),
  level_label: z.string().nullish(),
  title: z.string().nullish(),
  text: z.string(),
  note_type: z.enum(NOTE_TYPES).nullish(),
  authority: z.enum(AI_AUTHORITIES).nullish(),
  is_assessable: z.boolean().nullish(),
  source: z.object({ page: z.number().int(), quote: z.string() }),
  confidence: z.number().min(0).max(1).nullish(),
  flags: z.array(z.string()).default([]),
});
export type ExtractItem = z.infer<typeof ExtractItemSchema>;

export const ExtractSchema = z.object({ items: z.array(ExtractItemSchema) });

/** Step D: one answer per question of a recovery call. */
export const RecoverSchema = z.object({
  answers: z.array(z.object({
    id: z.string(),
    found: z.boolean(),
    reason: z.string().nullish(),
    items: z.array(ExtractItemSchema).default([]),
  })),
});
export type RecoverAnswer = z.infer<typeof RecoverSchema>['answers'][number];
