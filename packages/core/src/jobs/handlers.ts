import type { JobType } from '@ams/shared';
import type { Ctx } from '../ctx.js';

export type JobHandler = (ctx: Ctx, payload: Record<string, unknown>) => Promise<unknown>;

/**
 * Handlers by job type. M0 ships one example so the path (service -> queue -> worker -> RLS-scoped write) is proven;
 * extract_text, ocr, ai_extract and export arrive with the milestones that need them.
 */
export const handlers: Partial<Record<JobType, JobHandler>> = {
  notify: async (_ctx, payload) => ({ delivered: false, echoed: payload.message ?? null }),
};
