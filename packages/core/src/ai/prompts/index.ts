import { connectionTestV1 } from './connection-test.v1.js';
import { ocrV1 } from './ocr.v1.js';

/**
 * Prompts are versioned files in the repository (DEC-012), never built at run time. A task has one file per version
 * (`<task>.v<N>.ts`); a change to wording is a new version, so every logged call names the exact text it used.
 * Later tasks register theirs here.
 */
export const PROMPTS = {
  connection_test: { v1: connectionTestV1 },
  ocr: { v1: ocrV1 },
} as const satisfies Record<string, Record<string, string>>;

export type PromptTask = keyof typeof PROMPTS;

export function getPrompt(task: string, version: string): string {
  const versions = (PROMPTS as Record<string, Record<string, string> | undefined>)[task];
  const text = versions?.[version];
  if (text === undefined) throw new Error(`No prompt "${task}" at version "${version}"`);
  return text;
}
