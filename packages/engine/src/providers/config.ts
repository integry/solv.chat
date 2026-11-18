import { getProviderSettings } from "../db/providerSettings.js";
import type { Tier } from "../models.js";
import {
  type EmbeddingsProviderName,
  type KeyProvider,
  type LlmProviderName,
  StoredKeyError,
} from "../seams/types.js";
import { parseOpenRouterModel } from "./factory.js";
import { type Embedder, openAIEmbedder, openRouterEmbedder } from "./retrieval.js";

export interface ProviderEnv {
  SOLV_LLM_PROVIDER?: string | undefined;
  SOLV_LLM_TIER?: string | undefined;
  SOLV_LLM_MODEL?: string | undefined;
  SOLV_EMBEDDINGS_PROVIDER?: string | undefined;
}

export type SettingSource = "stored" | "environment" | "none";

export interface ResolvedSetting<T> {
  value: T;
  source: SettingSource;
}

export interface EffectiveProviderSettings {
  llmProvider: ResolvedSetting<LlmProviderName>;
  llmTier: ResolvedSetting<Tier>;
  llmModel: ResolvedSetting<string | null>;
  embeddingsProvider: ResolvedSetting<EmbeddingsProviderName>;
  /**
   * "Review answers" (Settings → Providers): stored, or on by default. There
   * is no environment variable for it.
   */
  reviewAnswers: ResolvedSetting<boolean>;
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

/**
 * Resolves effective provider settings for an org in a single D1 read.
 * Precedence for every setting: stored (D1) > environment > built-in default.
 */
export async function resolveProviderSettings(
  db: D1Database,
  env: ProviderEnv,
  orgId: string,
): Promise<EffectiveProviderSettings> {
  const stored = await getProviderSettings(db, orgId);

  let llmProvider: ResolvedSetting<LlmProviderName>;
  if (
    stored?.llmProvider === "anthropic" ||
    stored?.llmProvider === "openai" ||
    stored?.llmProvider === "openrouter"
  ) {
    llmProvider = { value: stored.llmProvider, source: "stored" };
  } else if (
    env.SOLV_LLM_PROVIDER === "anthropic" ||
    env.SOLV_LLM_PROVIDER === "openai" ||
    env.SOLV_LLM_PROVIDER === "openrouter"
  ) {
    llmProvider = { value: env.SOLV_LLM_PROVIDER, source: "environment" };
  } else {
    if (env.SOLV_LLM_PROVIDER !== undefined) {
      warnInvalidConfigOnce("SOLV_LLM_PROVIDER", DEFAULT_LLM_PROVIDER);
    }
    llmProvider = { value: DEFAULT_LLM_PROVIDER, source: "none" };
  }

  let llmTier: ResolvedSetting<Tier>;
  if (stored?.llmTier === "fast" || stored?.llmTier === "balanced") {
    llmTier = { value: stored.llmTier, source: "stored" };
  } else if (env.SOLV_LLM_TIER === "fast" || env.SOLV_LLM_TIER === "balanced") {
    llmTier = { value: env.SOLV_LLM_TIER, source: "environment" };
  } else {
    if (env.SOLV_LLM_TIER !== undefined) {
      warnInvalidConfigOnce("SOLV_LLM_TIER", DEFAULT_TIER);
    }
    llmTier = { value: DEFAULT_TIER, source: "none" };
  }

  const storedModel = stored?.llmModel ? parseOpenRouterModel(stored.llmModel) : null;
  const envModel = parseOpenRouterModel(env.SOLV_LLM_MODEL);
  let llmModel: ResolvedSetting<string | null>;
  if (storedModel !== null) {
    llmModel = { value: storedModel, source: "stored" };
  } else if (envModel !== null) {
    llmModel = { value: envModel, source: "environment" };
  } else {
    llmModel = { value: null, source: "none" };
  }

  let embeddingsProvider: ResolvedSetting<EmbeddingsProviderName>;
  if (stored?.embeddingsProvider === "openai" || stored?.embeddingsProvider === "openrouter") {
    embeddingsProvider = { value: stored.embeddingsProvider, source: "stored" };
  } else if (
    env.SOLV_EMBEDDINGS_PROVIDER === "openai" ||
    env.SOLV_EMBEDDINGS_PROVIDER === "openrouter"
  ) {
    embeddingsProvider = { value: env.SOLV_EMBEDDINGS_PROVIDER, source: "environment" };
  } else {
    if (env.SOLV_EMBEDDINGS_PROVIDER !== undefined) {
      warnInvalidConfigOnce("SOLV_EMBEDDINGS_PROVIDER", DEFAULT_EMBEDDINGS_PROVIDER);
    }
    embeddingsProvider = { value: DEFAULT_EMBEDDINGS_PROVIDER, source: "none" };
  }

  const reviewAnswers: ResolvedSetting<boolean> =
    typeof stored?.reviewAnswers === "boolean"
      ? { value: stored.reviewAnswers, source: "stored" }
      : { value: true, source: "none" };

  return { llmProvider, llmTier, llmModel, embeddingsProvider, reviewAnswers };
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

function providerLabel(provider: LlmProviderName): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "openai") return "OpenAI";
  return "OpenRouter";
}

function secretEnvName(provider: LlmProviderName): string {
  if (provider === "anthropic") return "SOLV_ANTHROPIC_KEY";
  if (provider === "openai") return "SOLV_OPENAI_KEY";
  return "SOLV_OPENROUTER_KEY";
}

/**
 * Checks whether the configured LLM provider has all required settings and
 * secrets, returning a plain-language sentence for the admin Overview if not.
 */
export async function checkLlmConfigError(
  db: D1Database,
  env: ProviderEnv,
  keys: KeyProvider,
  orgId: string,
  resolved?: EffectiveProviderSettings,
): Promise<string | null> {
  const settings = resolved ?? (await resolveProviderSettings(db, env, orgId));
  const provider = settings.llmProvider.value;

  if (provider === "openrouter" && settings.llmModel.value === null) {
    return "OpenRouter is selected, but no model is set. Set one in Settings → Providers or via SOLV_LLM_MODEL.";
  }

  try {
    await keys.modelKey(orgId, provider);
  } catch (err) {
    const label = providerLabel(provider);
    if (err instanceof StoredKeyError) {
      return `The stored ${label} API key could not be read (SOLV_SECRET_KEY may have changed). Re-enter it in Settings → Providers.`;
    }
    return `${label} is selected, but no API key is set. Add one in Settings → Providers or set ${secretEnvName(provider)}.`;
  }

  const embeddingsProvider = settings.embeddingsProvider.value;
  try {
    await keys.embeddingKey(orgId, embeddingsProvider);
  } catch (err) {
    const label = providerLabel(embeddingsProvider);
    if (err instanceof StoredKeyError) {
      return `The stored ${label} API key could not be read (SOLV_SECRET_KEY may have changed). Re-enter it in Settings → Providers.`;
    }
    return `${label} is selected for embeddings, but no API key is set. Add one in Settings → Providers or set ${secretEnvName(embeddingsProvider)}.`;
  }

  return null;
}
