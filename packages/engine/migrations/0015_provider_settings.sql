CREATE TABLE org_provider_settings (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id),
  llm_provider TEXT CHECK (llm_provider IN ('anthropic', 'openai', 'openrouter')),
  llm_tier TEXT CHECK (llm_tier IN ('fast', 'balanced')),
  llm_model TEXT,
  embeddings_provider TEXT CHECK (embeddings_provider IN ('openai', 'openrouter')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE org_provider_keys (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'openrouter')),
  secret_ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, provider)
);
