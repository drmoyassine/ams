import { ApiError } from './framework-api';

/** Runs an API call and hands the rule the server cited to `onError` when it refuses; other errors still throw. */
export function useAction(onError: (message: string) => void) {
  return async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); } catch (e) {
      if (e instanceof ApiError) { onError(e.issues.length ? `${e.message}: ${e.issues.map((i) => i.message).join('; ')}` : e.message); return undefined; }
      throw e;
    }
  };
}
