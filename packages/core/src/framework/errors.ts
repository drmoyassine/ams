import { ConflictError } from '../ctx.js';

/** Turns the database's integrity triggers/constraints (SQLSTATE class 23) into a 409 with the rule's own message. */
export async function guardIntegrity<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string; constraint?: string } }).cause ?? (e as { code?: string; message?: string });
    if (typeof cause.code === 'string' && cause.code.startsWith('23')) {
      throw new ConflictError(cause.message ?? 'integrity rule violated');
    }
    throw e;
  }
}
