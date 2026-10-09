import { z } from 'zod';

/**
 * Framework analysis (PRD 15, step C): a background run that reads a draft version's sources and writes requirements and
 * notes into that draft in the accreditor's exact wording. Each stage is its own small job; the run records where it is.
 */
export const ANALYSIS_STAGES = ['read', 'survey', 'structure', 'extract', 'gaps', 'recover', 'write', 'finalise'] as const;
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
  /** Check-and-recover (step D): the round in progress (1-based), the most rounds allowed, and the targeted questions of this round. */
  round: z.number().int().optional(),
  maxRounds: z.number().int().optional(),
  gapsOpen: z.number().int().optional(),
  tasksTotal: z.number().int().optional(),
  tasksDone: z.number().int().optional(),
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
  // Check-and-recover (step D). Optional: runs before it have none.
  /** Gaps the recovery passes closed with a verified item. */
  gapsRecovered: z.number().int().optional(),
  /** Gaps still open when the run ended (rounds or budget used up, or the answer did not check out). */
  gapsUnresolved: z.number().int().optional(),
  /** Gaps the model confirmed are not there (for example, the numbering really skips), with its reason. */
  gapsConfirmedAbsent: z.number().int().optional(),
  /** The same code with materially different wording in two places: flagged for a person, never resolved by the AI. */
  conflicts: z.number().int().optional(),
  /** Substantive pages of a standards document that no item cites, at the end of the run. */
  uncoveredPages: z.number().int().optional(),
  /** Requirements and notes a person deleted earlier, which the run did not add back. */
  dismissedSkipped: z.number().int().optional(),
  recoveryRounds: z.number().int().optional(),
});
export type AnalysisStats = z.infer<typeof AnalysisStatsSchema>;

/** What the check-and-recover passes look for (step D). */
export const ANALYSIS_GAP_KINDS = ['numbering_gap', 'missing_parent', 'unverified_quote', 'low_confidence', 'uncovered_page', 'conflict'] as const;
export type AnalysisGapKind = (typeof ANALYSIS_GAP_KINDS)[number];
/** open: found, not yet asked about; the others are where a gap ends up. */
export const ANALYSIS_GAP_STATUSES = ['open', 'recovered', 'confirmed_absent', 'unresolved', 'conflict'] as const;
export type AnalysisGapStatus = (typeof ANALYSIS_GAP_STATUSES)[number];

/** One gap of a run, as kept in `report.gaps`. */
export const AnalysisGapSchema = z.object({
  /** Stable across rounds: what the gap is about (a code, a note, a page). */
  key: z.string(),
  kind: z.enum(ANALYSIS_GAP_KINDS),
  status: z.enum(ANALYSIS_GAP_STATUSES),
  /** The requirement code it is about, when it is about one. */
  code: z.string().nullable(),
  documentId: z.string().nullable(),
  page: z.number().int().nullable(),
  /** The round in which the gap reached its status (0: found after the extraction, not asked about yet). */
  round: z.number().int(),
  attempts: z.number().int(),
  /** What the finder saw, in words (e.g. "between 2.2 and 2.4"). */
  detail: z.string().nullable(),
  /** The model's reason when it confirmed the gap is not there. */
  reason: z.string().nullable(),
  /** Link targets: the requirement card, set when the run ends. */
  requirementId: z.string().nullable(),
});
export type AnalysisGap = z.infer<typeof AnalysisGapSchema>;

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
