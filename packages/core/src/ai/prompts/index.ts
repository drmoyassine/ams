import { assistantV1 } from './assistant.v1.js';
import { connectionTestV1 } from './connection-test.v1.js';
import { extractV1 } from './extract.v1.js';
import { mapV1 } from './map.v1.js';
import { newiqfV1 } from './newiqf.v1.js';
import { ocrV1 } from './ocr.v1.js';
import { recoverV1 } from './recover.v1.js';
import { structureV1 } from './structure.v1.js';
import { surveyV1 } from './survey.v1.js';

/**
 * Prompts are versioned files in the repository (DEC-012), never built at run time. A task has one file per version
 * (`<task>.v<N>.ts`); a change to wording is a new version, so every logged call names the exact text it used.
 * Later tasks register theirs here.
 */
export const PROMPTS = {
  connection_test: { v1: connectionTestV1 },
  ocr: { v1: ocrV1 },
  // Framework analysis (step C): survey each source, find the hierarchy, extract requirements and notes.
  survey: { v1: surveyV1 },
  structure: { v1: structureV1 },
  extract: { v1: extractV1 },
  // Step D: narrow questions about a few pages when the checks found a gap.
  recover: { v1: recoverV1 },
  // Step E: judge shortlisted IQF items for each external requirement; draft new IQF items where nothing fits.
  map: { v1: mapV1 },
  newiqf: { v1: newiqfV1 },
  // The in-app assistant (DEC-027): a multi-step conversation turn with read-only tools (aiAgent).
  assistant: { v1: assistantV1 },
} as const satisfies Record<string, Record<string, string>>;

export type PromptTask = keyof typeof PROMPTS;

export function getPrompt(task: string, version: string): string {
  const versions = (PROMPTS as Record<string, Record<string, string> | undefined>)[task];
  const text = versions?.[version];
  if (text === undefined) throw new Error(`No prompt "${task}" at version "${version}"`);
  return text;
}
