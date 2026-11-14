/**
 * Every value here is copied from the provider's documentation, with the URL
 * and the date it was checked. Do not write these from memory and do not
 * update one without re-reading its source (AGENTS.md, "External facts").
 */

export interface ModelInfo {
  id: string;
  contextTokens: number;
  inputCostMicrosPerMillion: number;
  outputCostMicrosPerMillion: number;
}

export type Tier = "fast" | "balanced";

// Source: https://platform.claude.com/docs/en/about-claude/models/overview and https://platform.claude.com/docs/en/about-claude/pricing — checked 2026-11-14
export const ANTHROPIC_MODELS: Record<Tier, ModelInfo> = {
  fast: {
    id: "claude-haiku-5-5",
    contextTokens: 1_000_000,
    inputCostMicrosPerMillion: 100_000,
    outputCostMicrosPerMillion: 500_000,
  },
  balanced: {
    id: "claude-sonnet-5-5",
    contextTokens: 1_000_000,
    inputCostMicrosPerMillion: 2_000_000,
    outputCostMicrosPerMillion: 10_000_000,
  },
};

// Source: https://platform.openai.com/docs/models and https://platform.openai.com/docs/pricing — checked 2026-11-14
export const OPENAI_MODELS: Record<Tier, ModelInfo> = {
  fast: {
    id: "gpt-5-mini",
    contextTokens: 400_000,
    inputCostMicrosPerMillion: 250_000,
    outputCostMicrosPerMillion: 2_000_000,
  },
  balanced: {
    id: "gpt-5",
    contextTokens: 400_000,
    inputCostMicrosPerMillion: 1_250_000,
    outputCostMicrosPerMillion: 10_000_000,
  },
};

// Source: https://platform.openai.com/docs/guides/embeddings and https://platform.openai.com/docs/pricing — checked 2026-11-14
// `dimensions` is also the Vectorize index size in the self-hosting guide, so
// a change here is a change to a deployed index, not just a constant.
export const EMBEDDING_MODEL = {
  id: "text-embedding-3-small",
  dimensions: 1536,
  costMicrosPerMillion: 20_000,
} as const;

/**
 * Micro-dollars so `usage_daily` stays in integers: floating-point money
 * accumulated over thousands of messages drifts.
 */
export function costMicros(model: ModelInfo, tokensIn: number, tokensOut: number): number {
  return Math.round(
    (tokensIn * model.inputCostMicrosPerMillion + tokensOut * model.outputCostMicrosPerMillion) /
      1_000_000,
  );
}
