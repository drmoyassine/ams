import { z } from 'zod';

/**
 * Framework analysis (PRD 15, step C): a background run that reads a draft version's sources and writes requirements and
 * notes into that draft in the accreditor's exact wording. Each stage is its own small job; the run records where it is.
 */
export const ANALYSIS_STAGES = ['read', 'survey', 'structure', 'extract', 'write', 'finalise'] as const;
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

export const ANALYSIS_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];
/** A run in one of these holds the version: no second run starts until it ends. */
export const ACTIVE_ANALYSIS_STATUSES = ['queued', 'running'] as const satisfies readonly AnalysisStatus[];

export const AnalysisProgressSchema = z.object({
  stage: z.enum(ANALYSIS_STAGES).optional(),
  /** Position inside the stage (a document or a window), so a retried job resumes where the last one stopped. */
  cursor: z.number().int().optional(),
  docsTotal: z.number().int().optional(),
  docsDone: z.number().int().optional(),
  windowsTotal: z.number().int().optional(),
  windowsDone: z.number().int().optional(),
  /** Requirement and note items proposed so far. */
  items: z.number().int().optional(),
});
export type AnalysisProgress = z.infer<typeof AnalysisProgressSchema>;

export const AnalysisUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  /** Null when no prices are set in Settings -> AI. */
  costUsd: z.number().nullable(),
  calls: z.number().int(),
});
export type AnalysisUsage = z.infer<typeof AnalysisUsageSchema>;

/** What the run found, for the progress strip and the last-runs list. The full report and review screen come later. */
export const AnalysisStatsSchema = z.object({
  pagesRead: z.number().int(),
  requirementsByLevel: z.record(z.string(), z.number().int()),
  requirements: z.number().int(),
  notes: z.number().int(),
  quoteVerified: z.number().int(),
  /** Share of written items whose quote was found on the cited (or a neighbouring) page, 0..1. */
  quoteVerifiedShare: z.number(),
  unverified: z.number().int(),
  orphans: z.number().int(),
  lowConfidence: z.number().int(),
  added: z.number().int(),
  updated: z.number().int(),
  /** Rows a person made or changed, which the run left as they were. */
  keptHumanEdits: z.number().int(),
});
export type AnalysisStats = z.infer<typeof AnalysisStatsSchema>;

export const AnalysisRunSchema = z.object({
  id: z.string(),
  frameworkVersionId: z.string(),
  status: z.enum(ANALYSIS_STATUSES),
  stage: z.enum(ANALYSIS_STAGES).nullable(),
  progress: AnalysisProgressSchema,
  model: z.string().nullable(),
  promptVersions: z.record(z.string(), z.string()),
  usage: AnalysisUsageSchema,
  error: z.string().nullable(),
  startedBy: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  /** Stats (see AnalysisStatsSchema) under `stats`, plus what the survey and structure stages proposed. */
  report: z.record(z.string(), z.unknown()),
});
export type AnalysisRun = z.infer<typeof AnalysisRunSchema>;
