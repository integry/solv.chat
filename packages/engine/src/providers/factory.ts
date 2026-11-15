import { ANTHROPIC_MODELS, OPENAI_MODELS, type Tier } from "../models.js";
import type { KeyProvider, LlmProviderName } from "../seams/types.js";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";
import { openrouterProvider } from "./openrouter.js";
import type { LlmProvider } from "./types.js";

const MAX_MODEL_ID_LENGTH = 256;

/**
 * Validates `SOLV_LLM_MODEL` for OpenRouter: any non-empty string of sane
 * length is passed through unchanged because OpenRouter's catalogue changes.
 */
export function parseOpenRouterModel(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MODEL_ID_LENGTH) return null;
  return trimmed;
}

export interface LlmConfig {
  orgId: string;
  provider: LlmProviderName;
  tier: Tier;
  model?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** Chooses the LLM provider and model tier from instance configuration. */
export async function llmProviderFor(config: LlmConfig, keys: KeyProvider): Promise<LlmProvider> {
  if (config.provider === "openrouter") {
    const model = parseOpenRouterModel(config.model);
    if (model === null) {
      throw new Error("Missing required configuration: SOLV_LLM_MODEL");
    }
    const apiKey = await keys.modelKey(config.orgId, "openrouter");
    return openrouterProvider({
      apiKey,
      model,
      fetchImpl: config.fetchImpl,
    });
  }
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
