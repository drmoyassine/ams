import type { JobType } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { AiDisabledError, AiNotConfiguredError, aiOcr } from '../ai/index.js';
import { loadAiRuntime } from '../ai/settings.js';
import { extractText } from '../framework/reading.js';
import { extractImportText } from '../documents/reading.js';
import { importJob } from '../documents/stages.js';
import { analyseJob } from '../framework/analysis/stages.js';
import { assistantJob } from '../assistant/turn.js';

export type JobHandler = (ctx: Ctx, payload: Record<string, unknown>) => Promise<unknown>;

/**
 * Handlers by job type. M0 ships one example so the path (service -> queue -> worker -> RLS-scoped write) is proven;
 * ocr, ai_extract and export arrive with the milestones that need them.
 */
export const handlers: Partial<Record<JobType, JobHandler>> = {
  extract_text: async (ctx, payload) => {
    // Scanned pages are read by the AI when Settings -> AI has it on (the reading model, else the analysis model) and
    // "Read scanned pages with AI" is on; at most "Max AI-read pages per file" pages per file, counted against the cap and
    // recorded in the result. Off, capped, or AI not set up: those pages stay flagged needsOcr, with a warning saying why.
    // The settings are read through this job's identity-carrying transaction, like every other setting.
    // The same job reads a standards source (`sourceDocumentId`) and an upload of a Docs tab (`importDocumentId`).
    const read = 'importDocumentId' in payload ? extractImportText : extractText;
    const runtime = await loadAiRuntime(ctx).catch((e: unknown) => {
      if (e instanceof AiDisabledError || e instanceof AiNotConfiguredError) return null;
      throw e;
    });
    if (!runtime) return read(ctx, payload);
    const ocr = runtime.ocr ?? { enabled: true, maxPages: Number.MAX_SAFE_INTEGER, language: null };
    if (!ocr.enabled) return read(ctx, payload, { notes: ['scanned pages were not read by the AI: "Read scanned pages with AI" is off (Settings -> AI)'] });
    if (runtime.visionError) return read(ctx, payload, { notes: [`scanned pages were not read by the AI: ${runtime.visionError}`] });
    const result = await read(ctx, payload, {
      ocrPage: async (p) => (await aiOcr({ image: p.image, lang: p.language, runtime })).text,
      ocrMaxPages: ocr.maxPages, ocrLanguage: ocr.language,
    });
    return { ...result, ai: runtime.calls };
  },
  // One step of a framework analysis run; each step queues the next (framework/analysis/stages.ts).
  analyse: analyseJob,
  // One stage of an AI document import run (documents/stages.ts); each stage queues the next.
  import: importJob,
  // One turn of the in-app assistant, run as the person who sent the message (assistant/turn.ts).
  assistant: assistantJob,
  notify: async (_ctx, payload) => ({ delivered: false, echoed: payload.message ?? null }),
};
