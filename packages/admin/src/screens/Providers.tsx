import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, deleteJson, postJson, putJson } from "../api/client.js";
import type {
  EmbeddingsProviderName,
  KeyTestResult,
  LlmProviderName,
  LlmTier,
  ProviderKeyStatus,
  ProviderSettingsView,
  SettingSource,
} from "../api/types.js";
import { useResource } from "../api/useResource.js";

const PROVIDER_LABELS: Record<LlmProviderName, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

const PROVIDERS: readonly LlmProviderName[] = ["anthropic", "openai", "openrouter"];

function SourceBadge({ source, label }: { source: SettingSource; label?: string }) {
  return (
    <span className="badge" title={label ? `${label} source: ${source}` : `source: ${source}`}>
      {source}
    </span>
  );
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function ProviderKeyCard({
  provider,
  status,
  onChanged,
}: {
  provider: LlmProviderName;
  status: ProviderKeyStatus;
  onChanged: () => void;
}) {
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<KeyTestResult | null>(null);

  const label = PROVIDER_LABELS[provider];
  const inputId = `provider-key-${provider}`;

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setTestResult(null);
    // Read once and clear state immediately so the secret does not linger in the DOM.
    const submitted = keyInput;
    setKeyInput("");
    try {
      await putJson(`/api/admin/providers/keys/${provider}`, { key: submitted });
      setNotice(`${label} key saved.`);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save key.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      await deleteJson(`/api/admin/providers/keys/${provider}`);
      setNotice(`${label} key removed.`);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove key.");
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    if (testing) return;
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await postJson<KeyTestResult>(`/api/admin/providers/keys/${provider}/test`);
      setTestResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not test key.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="source-card stack" aria-label={`${label} API key`}>
      <div className="source-row-header">
        <div>
          <h3 className="section-heading">{label}</h3>
          <p className="muted">
            {status.source === "stored" && status.updatedAt !== null
              ? `Set on ${formatDate(status.updatedAt)}`
              : status.source === "environment"
                ? "Using Worker secret (environment)."
                : "Not set."}
          </p>
        </div>
        <SourceBadge source={status.source} label={`${label} key`} />
      </div>

      {status.unreadable && (
        <p className="warning-banner" role="alert">
          The stored {label} key could not be read (SOLV_SECRET_KEY may have changed). Re-enter it
          below.
        </p>
      )}

      <form className="stack" onSubmit={(e) => void handleSave(e)}>
        <div className="field">
          <label htmlFor={inputId}>{status.source === "stored" ? "New key" : "API key"}</label>
          <input
            id={inputId}
            type="password"
            autoComplete="off"
            value={keyInput}
            disabled={busy}
            placeholder={
              status.source === "stored" ? "Enter a new key to replace" : "Paste API key"
            }
            onChange={(e) => setKeyInput(e.target.value)}
          />
        </div>

        <div className="actions">
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={busy || keyInput.trim().length === 0}
          >
            {status.source === "stored" ? "Replace" : "Save key"}
          </button>
          {status.source === "stored" && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => void handleRemove()}
            >
              Remove
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={testing || busy}
            onClick={() => void handleTest()}
          >
            {testing ? "Testing…" : "Test"}
          </button>
        </div>
      </form>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice-text" role="status">
          {notice}
        </p>
      )}
      {testResult && (
        <p
          className={testResult.ok ? "notice-text" : "error-text"}
          role={testResult.ok ? "status" : "alert"}
        >
          {testResult.message}
        </p>
      )}
    </section>
  );
}

export function Providers() {
  const res = useResource<ProviderSettingsView>("/api/admin/providers");
  const data = res.value;

  const [llmProvider, setLlmProvider] = useState<LlmProviderName>("anthropic");
  const [llmTier, setLlmTier] = useState<LlmTier>("fast");
  const [llmModel, setLlmModel] = useState("");
  const [embeddingsProvider, setEmbeddingsProvider] = useState<EmbeddingsProviderName>("openai");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const settingsDirtyRef = useRef(false);

  useEffect(() => {
    if (!data || settingsDirtyRef.current) return;
    setLlmProvider(data.settings.llmProvider.value);
    setLlmTier(data.settings.llmTier.value);
    setLlmModel(data.settings.llmModel.value ?? "");
    setEmbeddingsProvider(data.settings.embeddingsProvider.value);
  }, [data]);

  async function handleSaveSettings(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setNotice(null);
    try {
      const updated = await putJson<ProviderSettingsView>("/api/admin/providers", {
        llmProvider,
        ...(llmProvider === "openrouter"
          ? { llmModel: llmModel.trim() === "" ? null : llmModel }
          : { llmTier }),
        embeddingsProvider,
      });
      settingsDirtyRef.current = false;
      res.setValue(updated);
      setNotice("Provider settings saved.");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fields);
      } else {
        setError("Could not save provider settings.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleResetSettings() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setNotice(null);
    try {
      const updated = await putJson<ProviderSettingsView>("/api/admin/providers", {
        llmProvider: null,
        llmTier: null,
        llmModel: null,
        embeddingsProvider: null,
      });
      settingsDirtyRef.current = false;
      res.setValue(updated);
      setNotice("Reset to environment defaults.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset provider settings.");
    } finally {
      setBusy(false);
    }
  }

  const hasStoredSetting =
    data !== undefined &&
    (data.settings.llmProvider.source === "stored" ||
      data.settings.llmTier.source === "stored" ||
      data.settings.llmModel.source === "stored" ||
      data.settings.embeddingsProvider.source === "stored");

  return (
    <div className="screen">
      <div className="screen-header">
        <div>
          <h1>Providers</h1>
          <p className="muted">
            Choose the answering and embeddings providers for this organisation.
          </p>
        </div>
      </div>

      {res.status === "loading" && !data ? (
        <p className="muted">Loading provider settings…</p>
      ) : res.status === "error" ? (
        <p className="error-text" role="alert">
          {res.error}
        </p>
      ) : data ? (
        <div className="stack">
          {data.configError && (
            <div className="warning-banner" role="alert">
              {data.configError}
            </div>
          )}

          <form className="source-card stack" onSubmit={(e) => void handleSaveSettings(e)}>
            <h2 className="section-heading">Models</h2>

            <div className="field">
              <div className="sitemap-toolbar">
                <label htmlFor="llm-provider">Answering provider</label>
                <SourceBadge source={data.settings.llmProvider.source} label="Answering provider" />
              </div>
              <select
                id="llm-provider"
                className="select"
                value={llmProvider}
                disabled={busy}
                onChange={(e) => {
                  settingsDirtyRef.current = true;
                  setLlmProvider(e.target.value as LlmProviderName);
                }}
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
              </select>
            </div>

            {llmProvider === "openrouter" ? (
              <div className="field">
                <div className="sitemap-toolbar">
                  <label htmlFor="llm-model">OpenRouter model ID</label>
                  <SourceBadge source={data.settings.llmModel.source} label="OpenRouter model ID" />
                </div>
                <input
                  id="llm-model"
                  type="text"
                  value={llmModel}
                  disabled={busy}
                  placeholder="anthropic/claude-sonnet-4"
                  onChange={(e) => {
                    settingsDirtyRef.current = true;
                    setLlmModel(e.target.value);
                  }}
                />
                <span className="field-hint">
                  Any OpenRouter model id. The daily spend cap is tracked in OpenRouter credits.
                </span>
                {fieldErrors.llmModel && (
                  <p className="field-error" role="alert">
                    {fieldErrors.llmModel}
                  </p>
                )}
              </div>
            ) : (
              <div className="field">
                <div className="sitemap-toolbar">
                  <label htmlFor="llm-tier">Model tier</label>
                  <SourceBadge source={data.settings.llmTier.source} label="Model tier" />
                </div>
                <select
                  id="llm-tier"
                  className="select"
                  value={llmTier}
                  disabled={busy}
                  onChange={(e) => {
                    settingsDirtyRef.current = true;
                    setLlmTier(e.target.value as LlmTier);
                  }}
                >
                  <option value="fast">Fast</option>
                  <option value="balanced">Balanced</option>
                </select>
              </div>
            )}

            <div className="field">
              <div className="sitemap-toolbar">
                <label htmlFor="embeddings-provider">Embeddings provider</label>
                <SourceBadge
                  source={data.settings.embeddingsProvider.source}
                  label="Embeddings provider"
                />
              </div>
              <select
                id="embeddings-provider"
                className="select"
                value={embeddingsProvider}
                disabled={busy}
                onChange={(e) => {
                  settingsDirtyRef.current = true;
                  setEmbeddingsProvider(e.target.value as EmbeddingsProviderName);
                }}
              >
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
              </select>
              <span className="field-hint">
                Both use the same embedding model and 1536 dimensions, so switching does not
                invalidate your index.
              </span>
            </div>

            <div className="actions">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? "Saving…" : "Save settings"}
              </button>
              {hasStoredSetting && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void handleResetSettings()}
                >
                  Reset to defaults
                </button>
              )}
            </div>

            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="notice-text" role="status">
                {notice}
              </p>
            )}
          </form>

          {!data.keysManaged && (
            <div className="stack">
              <h2 className="section-heading">API keys</h2>
              <p className="muted">
                Keys are encrypted at rest and never shown again after saving. Leave blank to keep
                the current key or use a Worker secret.
              </p>
              {PROVIDERS.map((provider) => (
                <ProviderKeyCard
                  key={provider}
                  provider={provider}
                  status={data.keys[provider]}
                  onChanged={res.reload}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
