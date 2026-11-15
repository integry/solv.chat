import type { Tier } from "../models.js";
import type { EmbeddingsProviderName, KeyProvider, LlmProviderName } from "../seams/types.js";
import { parseOpenRouterModel } from "./factory.js";
import { type Embedder, openAIEmbedder, openRouterEmbedder } from "./retrieval.js";

export interface ProviderEnv {
  SOLV_LLM_PROVIDER?: string | undefined;
  SOLV_LLM_TIER?: string | undefined;
  SOLV_LLM_MODEL?: string | undefined;
  SOLV_EMBEDDINGS_PROVIDER?: string | undefined;
}

const DEFAULT_LLM_PROVIDER: LlmProviderName = "anthropic";
const DEFAULT_TIER: Tier = "fast";
const DEFAULT_EMBEDDINGS_PROVIDER: EmbeddingsProviderName = "openai";
const warnedConfigVars = new Set<string>();

function warnInvalidConfigOnce(
  name: "SOLV_LLM_PROVIDER" | "SOLV_LLM_TIER" | "SOLV_EMBEDDINGS_PROVIDER",
  fallback: string,
): void {
  if (warnedConfigVars.has(name)) return;
  warnedConfigVars.add(name);
  // Do not log or otherwise trust the unrecognised value's content.
  console.warn(`Unrecognised ${name} configuration; falling back to default (${fallback}).`);
}

export function resolveLlmProvider(raw: string | undefined): LlmProviderName {
  if (raw === undefined) return DEFAULT_LLM_PROVIDER;
  if (raw === "anthropic" || raw === "openai" || raw === "openrouter") return raw;
  warnInvalidConfigOnce("SOLV_LLM_PROVIDER", DEFAULT_LLM_PROVIDER);
  return DEFAULT_LLM_PROVIDER;
}

export function resolveTier(raw: string | undefined): Tier {
  if (raw === undefined) return DEFAULT_TIER;
  if (raw === "fast" || raw === "balanced") return raw;
  warnInvalidConfigOnce("SOLV_LLM_TIER", DEFAULT_TIER);
  return DEFAULT_TIER;
}

export function resolveEmbeddingsProvider(raw: string | undefined): EmbeddingsProviderName {
  if (raw === undefined) return DEFAULT_EMBEDDINGS_PROVIDER;
  if (raw === "openai" || raw === "openrouter") return raw;
  warnInvalidConfigOnce("SOLV_EMBEDDINGS_PROVIDER", DEFAULT_EMBEDDINGS_PROVIDER);
  return DEFAULT_EMBEDDINGS_PROVIDER;
}

export async function embedderFor(
  orgId: string,
  provider: EmbeddingsProviderName,
  keys: KeyProvider,
  fetchImpl?: typeof fetch | undefined,
): Promise<Embedder> {
  const apiKey = await keys.embeddingKey(orgId, provider);
  if (provider === "openrouter") {
    return openRouterEmbedder({ apiKey, fetchImpl });
  }
  return openAIEmbedder({ apiKey, fetchImpl });
}

/**
 * Checks whether the configured LLM provider has all required settings and
 * secrets, returning a plain-language sentence for the admin Overview if not.
 */
export async function checkLlmConfigError(
  env: ProviderEnv,
  keys: KeyProvider,
  orgId: string,
): Promise<string | null> {
  const provider = resolveLlmProvider(env.SOLV_LLM_PROVIDER);
  if (provider === "openrouter") {
    if (parseOpenRouterModel(env.SOLV_LLM_MODEL) === null) {
      return "OpenRouter is selected, but SOLV_LLM_MODEL is not set.";
    }
    try {
      await keys.modelKey(orgId, "openrouter");
    } catch {
      return "OpenRouter is selected, but SOLV_OPENROUTER_KEY is not set.";
    }
    return null;
  }

  try {
    await keys.modelKey(orgId, provider);
  } catch {
    const secretName = provider === "anthropic" ? "SOLV_ANTHROPIC_KEY" : "SOLV_OPENAI_KEY";
    const label = provider === "anthropic" ? "Anthropic" : "OpenAI";
    return `${label} is selected, but ${secretName} is not set.`;
  }
  return null;
}
