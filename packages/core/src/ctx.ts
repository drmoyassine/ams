import type { Identity, Tx } from '@ams/db';
import type { JobEnvelope, JobType } from '@ams/shared';

/** Where services hand work to the background worker. The pg-boss implementation lives in jobs/pgboss-queue.ts. */
export interface JobQueue {
  send(type: JobType, envelope: JobEnvelope): Promise<void>;
}

/** Passed to every service function: the caller's transaction and identity. Services never open connections. */
export interface Ctx {
  tx: Tx;
  caller: Identity;
  queue: JobQueue;
  /** Runs after the transaction commits (and not at all if it rolls back), e.g. to publish to the queue. */
  afterCommit(fn: () => Promise<void>): void;
}

export class ForbiddenError extends Error {
  readonly status = 403;
}
export class NotFoundError extends Error {
  readonly status = 404;
}
