import { isPlainObject } from "@solvchat/core";
import type { ProviderSettingsPatch } from "../db/providerSettings.js";
import type { Tenant } from "../db/tenant.js";
import type { EffectiveProviderSettings, SettingSource } from "../providers/config.js";
import { parseOpenRouterModel } from "../providers/factory.js";
import { OPENROUTER_DEFAULT_REFERER, OPENROUTER_DEFAULT_TITLE } from "../providers/openrouter.js";
import { type KeyProvider, type LlmProviderName, StoredKeyError } from "../seams/types.js";
import { MAX_SECRET_LENGTH, sealSecret } from "../security/secretBox.js";
import { BadRequest, Conflict, NotFound } from "./errors.js";

const PROVIDERS: readonly LlmProviderName[] = ["anthropic", "openai", "openrouter"];
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";
const ANTHROPIC_VERSION = "2026-10-21";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const OPENROUTER_AUTH_KEY_URL = "https://openrouter.ai/api/v1/auth/key";

const ALLOWED_SETTINGS_KEYS = new Set([
  "llmProvider",
  "llmTier",
  "llmModel",
  "embeddingsProvider",
]);

export interface ProviderKeyStatus {
  source: SettingSource;
  updatedAt: number | null;
  unreadable: boolean;
}

export interface ProviderSettingsView {
  settings: EffectiveProviderSettings;
  keysManaged: boolean;
  keys: Record<LlmProviderName, ProviderKeyStatus>;
  configError: string | null;
}

export interface ProviderAdminDeps {
  tenant: Tenant;
  orgId: string;
  keys: KeyProvider;
  secretKey: string;
  envSecretPresence: Record<LlmProviderName, boolean>;
  fetchImpl?: typeof fetch | undefined;
  resolveSettings: () => Promise<EffectiveProviderSettings>;
  checkConfigError: (resolved?: EffectiveProviderSettings) => Promise<string | null>;
}

export function parseProviderName(raw: string | undefined): LlmProviderName | null {
  if (raw === "anthropic" || raw === "openai" || raw === "openrouter") return raw;
  return null;
}

async function keyStatusFor(
  deps: ProviderAdminDeps,
  provider: LlmProviderName,
  storedUpdatedAt: number | undefined,
): Promise<ProviderKeyStatus> {
  if (storedUpdatedAt !== undefined) {
    let unreadable = false;
    try {
      // Check decryptability only; never retain or return the plaintext.
      await deps.keys.modelKey(deps.orgId, provider);
    } catch (err) {
      if (err instanceof StoredKeyError) {
        unreadable = true;
      }
    }
    return { source: "stored", updatedAt: storedUpdatedAt, unreadable };
  }
  if (deps.envSecretPresence[provider]) {
    return { source: "environment", updatedAt: null, unreadable: false };
  }
  return { source: "none", updatedAt: null, unreadable: false };
}

export async function getProviderSettingsView(
  deps: ProviderAdminDeps,
): Promise<ProviderSettingsView> {
  const settings = await deps.resolveSettings();
  const keysManaged = deps.keys.managed === true;
  const configError = await deps.checkConfigError(settings);

  if (keysManaged) {
    return {
      settings,
      keysManaged: true,
      keys: {
        anthropic: { source: "none", updatedAt: null, unreadable: false },
        openai: { source: "none", updatedAt: null, unreadable: false },
        openrouter: { source: "none", updatedAt: null, unreadable: false },
      },
      configError,
    };
  }

  const storedKeys = await deps.tenant.providerSettings.listKeys();
  const storedByProvider = new Map(storedKeys.map((k) => [k.provider, k.updatedAt]));
  const [anthropic, openai, openrouter] = await Promise.all(
    PROVIDERS.map((p) => keyStatusFor(deps, p, storedByProvider.get(p))),
  );

  return {
    settings,
    keysManaged: false,
    keys: {
      anthropic: anthropic ?? { source: "none", updatedAt: null, unreadable: false },
      openai: openai ?? { source: "none", updatedAt: null, unreadable: false },
      openrouter: openrouter ?? { source: "none", updatedAt: null, unreadable: false },
    },
    configError,
  };
}

function readSettingsPatch(body: unknown): ProviderSettingsPatch {
  if (!isPlainObject(body)) {
    throw new BadRequest(["body: must be a JSON object"]);
  }
  const errors: string[] = [];
  for (const key of Object.keys(body)) {
    if (!ALLOWED_SETTINGS_KEYS.has(key)) {
      errors.push(`${key}: unknown field`);
    }
  }
  const patch: ProviderSettingsPatch = {};

  if (body.llmProvider !== undefined) {
    if (
      body.llmProvider === null ||
      body.llmProvider === "anthropic" ||
      body.llmProvider === "openai" ||
      body.llmProvider === "openrouter"
    ) {
      patch.llmProvider = body.llmProvider;
    } else {
      errors.push('llmProvider: must be "anthropic", "openai", "openrouter", or null');
    }
  }

  if (body.llmTier !== undefined) {
    if (body.llmTier === null || body.llmTier === "fast" || body.llmTier === "balanced") {
      patch.llmTier = body.llmTier;
    } else {
      errors.push('llmTier: must be "fast", "balanced", or null');
    }
  }

  if (body.llmModel !== undefined) {
    if (body.llmModel === null) {
      patch.llmModel = null;
    } else if (typeof body.llmModel === "string") {
      const parsed = parseOpenRouterModel(body.llmModel);
      if (parsed === null) {
        errors.push("llmModel: must be 1 to 256 characters");
      } else {
        patch.llmModel = parsed;
      }
    } else {
      errors.push("llmModel: must be a string or null");
    }
  }

  if (body.embeddingsProvider !== undefined) {
    if (
      body.embeddingsProvider === null ||
      body.embeddingsProvider === "openai" ||
      body.embeddingsProvider === "openrouter"
    ) {
      patch.embeddingsProvider = body.embeddingsProvider;
    } else {
      errors.push('embeddingsProvider: must be "openai", "openrouter", or null');
    }
  }

  if (errors.length > 0) throw new BadRequest(errors);
  return patch;
}

export async function updateProviderSettings(
  deps: ProviderAdminDeps,
  body: unknown,
): Promise<ProviderSettingsView> {
  const patch = readSettingsPatch(body);
  await deps.tenant.providerSettings.upsert(patch);
  return getProviderSettingsView(deps);
}

export async function setProviderKey(
  deps: ProviderAdminDeps,
  provider: LlmProviderName,
  body: unknown,
): Promise<{ ok: true; provider: LlmProviderName; status: ProviderKeyStatus }> {
  if (deps.keys.managed === true) throw new NotFound();
  if (!isPlainObject(body) || typeof body.key !== "string") {
    throw new BadRequest(["key: must be a non-empty API key"]);
  }
  const trimmed = body.key.trim();
  if (trimmed.length === 0) {
    throw new BadRequest(["key: must not be empty"]);
  }
  if (trimmed.length > MAX_SECRET_LENGTH) {
    throw new BadRequest([`key: must be at most ${MAX_SECRET_LENGTH} characters`]);
  }
  if (!deps.secretKey) {
    throw new Conflict("SOLV_SECRET_KEY must be set before storing API keys.");
  }

  const now = Date.now();
  const ciphertext = await sealSecret(deps.secretKey, trimmed);
  await deps.tenant.providerSettings.setKey(provider, ciphertext, now);
  return {
    ok: true,
    provider,
    status: { source: "stored", updatedAt: now, unreadable: false },
  };
}

export async function removeProviderKey(
  deps: ProviderAdminDeps,
  provider: LlmProviderName,
): Promise<{ ok: true; provider: LlmProviderName; status: ProviderKeyStatus }> {
  if (deps.keys.managed === true) throw new NotFound();
  await deps.tenant.providerSettings.deleteKey(provider);
  return {
    ok: true,
    provider,
    status: {
      source: deps.envSecretPresence[provider] ? "environment" : "none",
      updatedAt: null,
      unreadable: false,
    },
  };
}

export async function testProviderKey(
  deps: ProviderAdminDeps,
  provider: LlmProviderName,
): Promise<Response> {
  if (deps.keys.managed === true) throw new NotFound();

  const allowed = await deps.tenant.providerSettings.checkKeyTestRateLimit();
  if (!allowed) {
    return Response.json(
      { error: "Too many key tests. Wait a moment and try again." },
      { status: 429 },
    );
  }

  let apiKey: string;
  try {
    apiKey = await deps.keys.modelKey(deps.orgId, provider);
  } catch (err) {
    if (err instanceof StoredKeyError) {
      return Response.json({
        ok: false,
        category: "unreadable",
        message: "The stored API key could not be read. Re-enter it.",
      });
    }
    return Response.json({
      ok: false,
      category: "missing",
      message: "No API key is set for this provider.",
    });
  }

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    if (provider === "anthropic") {
      response = await doFetch(ANTHROPIC_MODELS_URL, {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
      });
    } else if (provider === "openai") {
      response = await doFetch(OPENAI_MODELS_URL, {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });
    } else {
      response = await doFetch(OPENROUTER_AUTH_KEY_URL, {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "http-referer": OPENROUTER_DEFAULT_REFERER,
          "x-title": OPENROUTER_DEFAULT_TITLE,
        },
      });
    }
  } catch {
    return Response.json({
      ok: false,
      category: "unreachable",
      message: "Could not reach the provider.",
    });
  }

  // Never read or forward the provider's response body.
  await response.body?.cancel().catch(() => {});

  if (response.ok) {
    return Response.json({
      ok: true,
      category: "ok",
      message: "Key is valid.",
    });
  }
  if (response.status === 401 || response.status === 403) {
    return Response.json({
      ok: false,
      category: "unauthorised",
      message: "The API key was rejected (unauthorised).",
    });
  }
  if (response.status === 429) {
    return Response.json({
      ok: false,
      category: "rate_limited",
      message: "The provider rate-limited this check. Try again shortly.",
    });
  }
  return Response.json({
    ok: false,
    category: "unreachable",
    message: "Could not reach the provider.",
  });
}
