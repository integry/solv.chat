import { ANTHROPIC_MODELS, OPENAI_MODELS, type Tier } from "../models.js";
import type { KeyProvider } from "../seams/types.js";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";
import type { LlmProvider } from "./types.js";

export interface LlmConfig {
  orgId: string;
  provider: "anthropic" | "openai";
  tier: Tier;
  fetchImpl?: typeof fetch | undefined;
}

/** Chooses the LLM provider and model tier from instance configuration. */
export async function llmProviderFor(config: LlmConfig, keys: KeyProvider): Promise<LlmProvider> {
  const apiKey = await keys.modelKey(config.orgId, config.provider);
  if (config.provider === "anthropic") {
    return anthropicProvider({
      apiKey,
      model: ANTHROPIC_MODELS[config.tier].id,
      fetchImpl: config.fetchImpl,
    });
  }
  return openaiProvider({
    apiKey,
    model: OPENAI_MODELS[config.tier].id,
    fetchImpl: config.fetchImpl,
  });
}
