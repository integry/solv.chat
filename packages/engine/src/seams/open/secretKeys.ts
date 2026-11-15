import { getProviderKeyCiphertext } from "../../db/providerSettings.js";
import { openSecret } from "../../security/secretBox.js";
import { type KeyProvider, type LlmProviderName, StoredKeyError } from "../types.js";

export interface SecretKeyEnv {
  SOLV_ANTHROPIC_KEY?: string | undefined;
  SOLV_OPENAI_KEY?: string | undefined;
  SOLV_OPENROUTER_KEY?: string | undefined;
  SOLV_SECRET_KEY?: string | undefined;
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required secret: ${name}`);
  }
  return value;
}

function envSecretFor(env: SecretKeyEnv, provider: LlmProviderName): string {
  if (provider === "anthropic") {
    return requireSecret(env.SOLV_ANTHROPIC_KEY, "SOLV_ANTHROPIC_KEY");
  }
  if (provider === "openrouter") {
    return requireSecret(env.SOLV_OPENROUTER_KEY, "SOLV_OPENROUTER_KEY");
  }
  return requireSecret(env.SOLV_OPENAI_KEY, "SOLV_OPENAI_KEY");
}

async function resolveKey(
  env: SecretKeyEnv,
  db: D1Database | undefined,
  orgId: string,
  provider: LlmProviderName,
): Promise<string> {
  if (db) {
    const ciphertext = await getProviderKeyCiphertext(db, orgId, provider);
    if (ciphertext !== null) {
      if (!env.SOLV_SECRET_KEY) {
        throw new StoredKeyError(provider, "SOLV_SECRET_KEY is not set");
      }
      try {
        return await openSecret(env.SOLV_SECRET_KEY, ciphertext);
      } catch {
        // Never fall back to the Worker secret when a stored key exists but
        // cannot be opened: the owner must know to re-enter it.
        throw new StoredKeyError(provider);
      }
    }
  }
  return envSecretFor(env, provider);
}

/** Reads model and embedding provider keys from D1 (sealed) or Worker secrets. */
export function secretKeys(env: SecretKeyEnv, db?: D1Database): KeyProvider {
  return {
    modelKey(orgId, provider) {
      return resolveKey(env, db, orgId, provider);
    },
    embeddingKey(orgId, provider = "openai") {
      return resolveKey(env, db, orgId, provider);
    },
  };
}
