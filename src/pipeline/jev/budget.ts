/**
 * Jev ingests `state` plus every question in a single request with two documented
 * budgets: 64k tokens for state + all questions combined, and 32k for state + the
 * single longest question. We estimate locally to stay well inside both.
 */
export const CHARS_PER_TOKEN = 4;

export const JEV_COMBINED_TOKEN_BUDGET = 64_000;
export const JEV_SINGLE_QUESTION_TOKEN_BUDGET = 32_000;

export function estimateTokens(input: unknown): number {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface BudgetCheck {
  estimatedTokens: number;
  maxTokens: number;
  exceeded: boolean;
}

export function checkBudget(payload: unknown, maxTokens: number): BudgetCheck {
  const estimatedTokens = estimateTokens(payload);
  return { estimatedTokens, maxTokens, exceeded: estimatedTokens > maxTokens };
}
