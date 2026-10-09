import type { JobType } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { AiDisabledError, AiNotConfiguredError, aiOcr } from '../ai/index.js';
import { loadAiRuntime } from '../ai/settings.js';
import { extractText } from '../framework/reading.js';
import { analyseJob } from '../framework/analysis/stages.js';

export type JobHandler = (ctx: Ctx, payload: Record<string, unknown>) => Promise<unknown>;

/**
 * Handlers by job type. M0 ships one example so the path (service -> queue -> worker -> RLS-scoped write) is proven;
 * ocr, ai_extract and export arrive with the milestones that need them.
 */
export const handlers: Partial<Record<JobType, JobHandler>> = {
  extract_text: async (ctx, payload) => {
    // Scanned pages are read by the AI when Settings -> AI has it on; the page images count against the run's budget and
    // every call is recorded in the result. With AI off or not set up, those pages stay flagged needsOcr.
    const runtime = await loadAiRuntime(ctx).catch((e: unknown) => {
      if (e instanceof AiDisabledError || e instanceof AiNotConfiguredError) return null;
      throw e;
    });
    if (!runtime) return extractText(ctx, payload);
    const result = await extractText(ctx, payload, { ocrPage: async (p) => (await aiOcr({ image: p.image, lang: p.language, runtime })).text });
    return { ...result, ai: runtime.calls };
  },
  // One step of a framework analysis run; each step queues the next (framework/analysis/stages.ts).
  analyse: analyseJob,
  notify: async (_ctx, payload) => ({ delivered: false, echoed: payload.message ?? null }),
};
