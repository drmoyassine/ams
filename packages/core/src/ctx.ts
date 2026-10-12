import type { Identity, Tx } from '@ams/db';
import type { JobEnvelope, JobType, UndoDescriptor } from '@ams/shared';

/** Where services hand work to the background worker. The pg-boss implementation lives in jobs/pgboss-queue.ts. */
export interface JobQueue {
  /** `delaySeconds` holds the job back that long (a step that is waiting for another job to finish). */
  send(type: JobType, envelope: JobEnvelope, opts?: { delaySeconds?: number }): Promise<void>;
}

/** Passed to every service function: the caller's transaction and identity. Services never open connections. */
export interface Ctx {
  tx: Tx;
  caller: Identity;
  queue: JobQueue;
  /** Runs after the transaction commits (and not at all if it rolls back), e.g. to publish to the queue. */
  afterCommit(fn: () => Promise<void>): void;
  /** Object storage for evidence files (S3 API in production, in memory in tests). Absent where files are not handled. */
  store?: ObjectStore;
  /**
   * A reversible action reports how to take it back (DEC-026). The API puts the last one reported in the `X-Undo` response
   * header; a service that calls others reports last, so the outermost action wins. Absent in jobs and tests.
   */
  undo?: (descriptor: UndoDescriptor) => void;
}

/** Stores and serves files by key. Any S3-compatible service implements it (DEC-008). */
export interface ObjectStore {
  /** Stores the bytes and reports what was stored, so the version row records exactly that. */
  put(key: string, body: Uint8Array, mime: string): Promise<{ size: number; sha256: string }>;
  get(key: string): Promise<{ body: Uint8Array; mime: string } | null>;
  /** Removes an object; removing one that is not there is not an error. Used only by the Trash purge. */
  delete(key: string): Promise<void>;
}

export class ForbiddenError extends Error {
  readonly status = 403;
}
export class NotFoundError extends Error {
  readonly status = 404;
}
export class ConflictError extends Error {
  readonly status = 409;
  /** Machine-readable detail the screen can act on (for example the choices a restore offers). */
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}
export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string, readonly issues: { path: string; message: string }[] = []) {
    super(message);
  }
}
