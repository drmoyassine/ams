import type { Identity, Tx } from '@ams/db';

/** Passed to every service function: the caller's transaction and identity. Services never open connections. */
export interface Ctx {
  tx: Tx;
  caller: Identity;
}

export class ForbiddenError extends Error {
  readonly status = 403;
}
export class NotFoundError extends Error {
  readonly status = 404;
}
