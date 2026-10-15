/** Typed failures of the AI connection, so callers (and job results) can tell a spent budget from a broken provider. */

/** The per-run token or cost limit is used up. The run stops; nothing further is sent to the model. */
export class BudgetExceeded extends Error {
  constructor(readonly limit: 'tokens' | 'cost', readonly used: number, readonly max: number) {
    super(limit === 'tokens'
      ? `AI token budget for this run is used up (${used} of ${max} tokens)`
      : `AI cost budget for this run is used up (${used.toFixed(4)} of ${max} USD)`);
    this.name = 'BudgetExceeded';
  }
}

/** The institution switched AI off in Settings -> AI. */
export class AiDisabledError extends Error {
  constructor() { super('AI is switched off for this institution (Settings -> AI)'); this.name = 'AiDisabledError'; }
}

/** An administrator switched the assistant off (Settings -> AI -> Models -> Assistant). */
export class AssistantDisabledError extends Error {
  constructor() { super('The assistant is switched off for this institution (Settings -> AI)'); this.name = 'AssistantDisabledError'; }
}

/** No model or key is configured, in Settings -> AI or in the environment. */
export class AiNotConfiguredError extends Error {
  constructor(message = 'AI is not configured: set the model and API key in Settings -> AI') { super(message); this.name = 'AiNotConfiguredError'; }
}

/** An AI call was attempted outside the worker/job path (DEC-012). A bug, never a user error. */
export class AiScopeError extends Error {
  constructor() { super('AI calls run only inside a worker job (or the settings connection test)'); this.name = 'AiScopeError'; }
}

/** The provider call failed (network, auth, invalid output). The message never contains the key. */
export class AiCallError extends Error {
  /** False when trying the same call again cannot help (the model returned nothing, or ran out of time): the job then stops at once. */
  constructor(message: string, readonly retryable = true) { super(message); this.name = 'AiCallError'; }
}
