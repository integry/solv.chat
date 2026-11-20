/**
 * Every value here is copied from the provider's documentation, with the URL
 * and the date it was checked. Do not write these from memory and do not
 * update one without re-reading its source (AGENTS.md, "External facts").
 */

export interface LongPromptPricing {
  /** Input token count above which long-prompt rates apply to the whole request (`tokensIn > thresholdTokens`). */
  thresholdTokens: number;
  inputCostMicrosPerMillion: number;
  outputCostMicrosPerMillion: number;
}

export interface ModelInfo {
  id: string;
  contextTokens: number;
  inputCostMicrosPerMillion: number;
  outputCostMicrosPerMillion: number;
  /** The most output tokens (reasoning included) one request may ask for. */
  maxOutputTokens: number;
  longPrompt?: LongPromptPricing;
}

export type Tier = "fast" | "balanced";

// Max output is 128K tokens on all four ("Max output", synchronous Messages API / model details).
// Source: https://platform.claude.com/docs/en/about-claude/models/overview and
// https://developers.openai.com/api/docs/models/gpt-6-luna and .../gpt-6.1-sol — checked 2026-11-20
// Haiku 5.5 bills prompts >100,000 input tokens at $0.50/$2.50 per MTok; Sonnet 5.5 (and Opus 5.5) have no threshold.
// Source: https://platform.claude.com/docs/en/about-claude/models/overview and https://platform.claude.com/docs/en/about-claude/pricing — checked 2026-11-14
export const ANTHROPIC_MODELS: Record<Tier, ModelInfo> = {
  fast: {
    id: "claude-haiku-5-5",
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostMicrosPerMillion: 100_000,
    outputCostMicrosPerMillion: 500_000,
    longPrompt: {
      thresholdTokens: 100_000,
      inputCostMicrosPerMillion: 500_000,
      outputCostMicrosPerMillion: 2_500_000,
    },
  },
  balanced: {
    id: "claude-sonnet-5-5",
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostMicrosPerMillion: 2_000_000,
    outputCostMicrosPerMillion: 10_000_000,
  },
};

// Both models support tool calling via /v1/responses and bill prompts >272,000 input tokens at 2x input, 1.5x output.
// Source: https://developers.openai.com/api/docs/models and https://developers.openai.com/api/docs/pricing — checked 2026-11-15
export const OPENAI_MODELS: Record<Tier, ModelInfo> = {
  fast: {
    id: "gpt-6-luna",
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    inputCostMicrosPerMillion: 100_000,
    outputCostMicrosPerMillion: 500_000,
    longPrompt: {
      thresholdTokens: 272_000,
      inputCostMicrosPerMillion: 200_000,
      outputCostMicrosPerMillion: 750_000,
    },
  },
  balanced: {
    id: "gpt-6.1-sol",
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    inputCostMicrosPerMillion: 2_000_000,
    outputCostMicrosPerMillion: 10_000_000,
    longPrompt: {
      thresholdTokens: 272_000,
      inputCostMicrosPerMillion: 4_000_000,
      outputCostMicrosPerMillion: 15_000_000,
    },
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
  const rates =
    model.longPrompt && tokensIn > model.longPrompt.thresholdTokens ? model.longPrompt : model;
  return Math.round(
    (tokensIn * rates.inputCostMicrosPerMillion + tokensOut * rates.outputCostMicrosPerMillion) /
      1_000_000,
  );
}
