import type { JobType } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { extractText } from '../framework/reading.js';

export type JobHandler = (ctx: Ctx, payload: Record<string, unknown>) => Promise<unknown>;

/**
 * Handlers by job type. M0 ships one example so the path (service -> queue -> worker -> RLS-scoped write) is proven;
 * ocr, ai_extract and export arrive with the milestones that need them.
 */
export const handlers: Partial<Record<JobType, JobHandler>> = {
  extract_text: (ctx, payload) => extractText(ctx, payload),
  notify: async (_ctx, payload) => ({ delivered: false, echoed: payload.message ?? null }),
};
