import { BudgetExceeded } from './errors.js';

export interface BudgetLimits {
  maxTokens?: number | null;
  maxCostUsd?: number | null;
  /** Prices in USD per million tokens, needed to count cost. */
  inputUsdPerMTok?: number | null;
  outputUsdPerMTok?: number | null;
}

/** Rough size of a prompt before it is sent: about 3 characters per token is deliberately on the high side. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);

/**
 * What one run (one job) may spend. Injectable: a handler builds it from the institution's limits and passes it to every
 * call; tests build their own. Checked before each call, recorded after it.
 */
export class AiBudget {
  inputTokens = 0;
  outputTokens = 0;
  costUsd = 0;
  constructor(readonly limits: BudgetLimits = {}) {}

  get totalTokens() { return this.inputTokens + this.outputTokens; }

  /** Tokens still available, or null when the run has no token limit. */
  remainingTokens(): number | null {
    return this.limits.maxTokens == null ? null : Math.max(0, this.limits.maxTokens - this.totalTokens);
  }

  costOf(inputTokens: number, outputTokens: number): number | null {
    const { inputUsdPerMTok: i, outputUsdPerMTok: o } = this.limits;
    if (i == null || o == null) return null;
    return (inputTokens * i + outputTokens * o) / 1_000_000;
  }

  /** Throws BudgetExceeded when the call about to be made (of about `estimatedInput` tokens) would not fit. */
  assertCanSpend(estimatedInput = 0): void {
    const { maxTokens, maxCostUsd } = this.limits;
    if (maxTokens != null && this.totalTokens + estimatedInput > maxTokens) throw new BudgetExceeded('tokens', this.totalTokens + estimatedInput, maxTokens);
    if (maxCostUsd != null && this.costUsd >= maxCostUsd) throw new BudgetExceeded('cost', this.costUsd, maxCostUsd);
  }

  /** `priced: false` counts the tokens but not their cost (embedding tokens are not priced like generation tokens). */
  record(inputTokens: number, outputTokens: number, priced = true): number | null {
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    const cost = priced ? this.costOf(inputTokens, outputTokens) : null;
    if (cost != null) this.costUsd += cost;
    return cost;
  }
}
