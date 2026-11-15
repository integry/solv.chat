import type { Tier } from "../models.js";
import type { EmbeddingsProviderName, LlmProviderName } from "../seams/types.js";

export interface StoredProviderSettings {
  llmProvider: LlmProviderName | null;
  llmTier: Tier | null;
  llmModel: string | null;
  embeddingsProvider: EmbeddingsProviderName | null;
  updatedAt: number;
}

export interface ProviderSettingsPatch {
  llmProvider?: LlmProviderName | null | undefined;
  llmTier?: Tier | null | undefined;
  llmModel?: string | null | undefined;
  embeddingsProvider?: EmbeddingsProviderName | null | undefined;
}

export interface StoredProviderKeyMeta {
  provider: LlmProviderName;
  updatedAt: number;
}

interface SettingsRow {
  llm_provider: LlmProviderName | null;
  llm_tier: Tier | null;
  llm_model: string | null;
  embeddings_provider: EmbeddingsProviderName | null;
  updated_at: number;
}

interface KeyMetaRow {
  provider: LlmProviderName;
  updated_at: number;
}

function toSettings(row: SettingsRow): StoredProviderSettings {
  return {
    llmProvider: row.llm_provider,
    llmTier: row.llm_tier,
    llmModel: row.llm_model,
    embeddingsProvider: row.embeddings_provider,
    updatedAt: row.updated_at,
  };
}

/** Reads the org's stored provider settings in a single D1 query. */
export async function getProviderSettings(
  db: D1Database,
  orgId: string,
): Promise<StoredProviderSettings | null> {
  const row = await db
    .prepare(
      `SELECT llm_provider, llm_tier, llm_model, embeddings_provider, updated_at
       FROM org_provider_settings
       WHERE org_id = ?1`,
    )
    .bind(orgId)
    .first<SettingsRow>();
  return row ? toSettings(row) : null;
}

/** Reads the sealed ciphertext for one provider key in one org. */
export async function getProviderKeyCiphertext(
  db: D1Database,
  orgId: string,
  provider: LlmProviderName,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT secret_ciphertext
       FROM org_provider_keys
       WHERE org_id = ?1 AND provider = ?2`,
    )
    .bind(orgId, provider)
    .first<{ secret_ciphertext: string }>();
  return row ? row.secret_ciphertext : null;
}

/** Tenant-bound accessor for per-org provider settings and sealed API keys. */
export function providerSettingsFor(db: D1Database, orgId: string) {
  return {
    get(): Promise<StoredProviderSettings | null> {
      return getProviderSettings(db, orgId);
    },

    async upsert(
      patch: ProviderSettingsPatch,
      now = Date.now(),
    ): Promise<StoredProviderSettings> {
      const existing = await getProviderSettings(db, orgId);
      const next: StoredProviderSettings = {
        llmProvider:
          patch.llmProvider !== undefined ? patch.llmProvider : (existing?.llmProvider ?? null),
        llmTier: patch.llmTier !== undefined ? patch.llmTier : (existing?.llmTier ?? null),
        llmModel: patch.llmModel !== undefined ? patch.llmModel : (existing?.llmModel ?? null),
        embeddingsProvider:
          patch.embeddingsProvider !== undefined
            ? patch.embeddingsProvider
            : (existing?.embeddingsProvider ?? null),
        updatedAt: now,
      };
      await db
        .prepare(
          `INSERT INTO org_provider_settings (
             org_id, llm_provider, llm_tier, llm_model, embeddings_provider, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(org_id) DO UPDATE SET
             llm_provider = excluded.llm_provider,
             llm_tier = excluded.llm_tier,
             llm_model = excluded.llm_model,
             embeddings_provider = excluded.embeddings_provider,
             updated_at = excluded.updated_at`,
        )
        .bind(
          orgId,
          next.llmProvider,
          next.llmTier,
          next.llmModel,
          next.embeddingsProvider,
          next.updatedAt,
        )
        .run();
      return next;
    },

    async listKeys(): Promise<StoredProviderKeyMeta[]> {
      const result = await db
        .prepare(
          `SELECT provider, updated_at
           FROM org_provider_keys
           WHERE org_id = ?1`,
        )
        .bind(orgId)
        .all<KeyMetaRow>();
      return result.results.map((r) => ({ provider: r.provider, updatedAt: r.updated_at }));
    },

    async setKey(
      provider: LlmProviderName,
      secretCiphertext: string,
      now = Date.now(),
    ): Promise<void> {
      await db
        .prepare(
          `INSERT INTO org_provider_keys (org_id, provider, secret_ciphertext, updated_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(org_id, provider) DO UPDATE SET
             secret_ciphertext = excluded.secret_ciphertext,
             updated_at = excluded.updated_at`,
        )
        .bind(orgId, provider, secretCiphertext, now)
        .run();
    },

    async deleteKey(provider: LlmProviderName): Promise<boolean> {
      const res = await db
        .prepare("DELETE FROM org_provider_keys WHERE org_id = ?1 AND provider = ?2")
        .bind(orgId, provider)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async checkKeyTestRateLimit(now = Date.now()): Promise<boolean> {
      const windowMs = 60_000;
      const maxPerWindow = 10;
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const row = await db
        .prepare(
          `INSERT INTO rate_counters (org_id, assistant_id, ip, window_start, hits)
           VALUES (?1, '_admin', 'key_test', ?2, 1)
           ON CONFLICT(org_id, assistant_id, ip, window_start) DO UPDATE SET hits = hits + 1
           RETURNING hits`,
        )
        .bind(orgId, windowStart)
        .first<{ hits: number }>();
      if (row?.hits === 1) {
        await db
          .prepare(
            "DELETE FROM rate_counters WHERE org_id = ?1 AND assistant_id = '_admin' AND window_start < ?2",
          )
          .bind(orgId, windowStart)
          .run();
      }
      return (row?.hits ?? 0) <= maxPerWindow;
    },
  };
}
