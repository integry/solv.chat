import type { KeyProvider } from "../types.js";

export interface SecretKeyEnv {
  SOLV_ANTHROPIC_KEY?: string | undefined;
  SOLV_OPENAI_KEY?: string | undefined;
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required secret: ${name}`);
  }
  return value;
}

/** Reads model and embedding provider keys from Worker secrets. */
export function secretKeys(env: SecretKeyEnv): KeyProvider {
  return {
    async modelKey(_orgId, provider) {
      if (provider === "anthropic") {
        return requireSecret(env.SOLV_ANTHROPIC_KEY, "SOLV_ANTHROPIC_KEY");
      }
      return requireSecret(env.SOLV_OPENAI_KEY, "SOLV_OPENAI_KEY");
    },
    async embeddingKey(_orgId) {
      return requireSecret(env.SOLV_OPENAI_KEY, "SOLV_OPENAI_KEY");
    },
  };
}
