import { assistantV1 } from './assistant.v1.js';
import { assistantV2 } from './assistant.v2.js';
import { assistantRewriteV1 } from './assistant-rewrite.v1.js';
import { assistantEvalV1 } from './assistant-eval.v1.js';
import { configsurveyV1 } from './configsurvey.v1.js';
import { connectionTestV1 } from './connection-test.v1.js';
import { extractV1 } from './extract.v1.js';
import { importExtractV1 } from './import-extract.v1.js';
import { importOrgChartV1 } from './import-org-chart.v1.js';
import { importProgramsV1 } from './import-programs.v1.js';
import { importProgramsV2 } from './import-programs.v2.js';
import { lifecycleV1 } from './lifecycle.v1.js';
import { mapV1 } from './map.v1.js';
import { newiqfV1 } from './newiqf.v1.js';
import { ocrV1 } from './ocr.v1.js';
import { ocrV2 } from './ocr.v2.js';
import { recoverV1 } from './recover.v1.js';
import { structureV1 } from './structure.v1.js';
import { surveyV1 } from './survey.v1.js';
import { templateV1 } from './template.v1.js';
import { translateV1 } from './translate.v1.js';
import { vocabV1 } from './vocab.v1.js';

/**
 * Prompts are versioned files in the repository (DEC-012), never built at run time. A task has one file per version
 * (`<task>.v<N>.ts`); a change to wording is a new version, so every logged call names the exact text it used.
 * Later tasks register theirs here.
 */
export const PROMPTS = {
  connection_test: { v1: connectionTestV1 },
  // v2 reads a picture of an org chart as an indented outline (TASK-073); v1 transcribes any other page.
  ocr: { v1: ocrV1, v2: ocrV2 },
  // Framework analysis (step C): survey each source, find the hierarchy, extract requirements and notes.
  survey: { v1: surveyV1 },
  structure: { v1: structureV1 },
  extract: { v1: extractV1 },
  // Document import (TASK-075): the general rules for any target; a target's own instructions travel in the message.
  import_extract: { v1: importExtractV1 },
  // Document import for Programs (TASK-076): the general rules plus what a program is.
  import_programs: { v1: importProgramsV1, v2: importProgramsV2 },
  // Document import for the org chart (TASK-073): units, their parents and heads from a picture or a PDF page.
  import_org_chart: { v1: importOrgChartV1 },
  // Step D: narrow questions about a few pages when the checks found a gap.
  recover: { v1: recoverV1 },
  // Step E: judge shortlisted IQF items for each external requirement; draft new IQF items where nothing fits.
  map: { v1: mapV1 },
  newiqf: { v1: newiqfV1 },
  // Step H: which configuration a policy / template / guidance document holds, then the lifecycle, the vocabularies and the
  // report-template outline, each from windows of pages. Proposals only; a reviewer sets date rules.
  config_survey: { v1: configsurveyV1 },
  lifecycle: { v1: lifecycleV1 },
  vocab: { v1: vocabV1 },
  template: { v1: templateV1 },
  // The generic translation job (TASK-070): English into the secondary language, in batches (interface now, content in TASK-071).
  translate: { v1: translateV1 },
  // The in-app assistant (DEC-027): a multi-step conversation turn with read-only tools (aiAgent).
  assistant: { v1: assistantV1, v2: assistantV2 },
  // Phase 2: the model writes new texts for a batch of items (draft_rewrites); the person confirms them like any other change.
  assistant_rewrite: { v1: assistantRewriteV1 },
  // Only for `pnpm assistant:eval`: instruction -> operations, over a fixture, with a real model.
  assistant_eval: { v1: assistantEvalV1 },
} as const satisfies Record<string, Record<string, string>>;

export type PromptTask = keyof typeof PROMPTS;

export function getPrompt(task: string, version: string): string {
  const versions = (PROMPTS as Record<string, Record<string, string> | undefined>)[task];
  const text = versions?.[version];
  if (text === undefined) throw new Error(`No prompt "${task}" at version "${version}"`);
  return text;
}
