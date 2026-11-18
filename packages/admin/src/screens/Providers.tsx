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
import { ConfirmDialog } from "../ui/Dialog.js";
import { ErrorState } from "../ui/ErrorState.js";
import { formatDate } from "../ui/format.js";
import { PageHeader } from "../ui/PageHeader.js";
import { Skeleton } from "../ui/Skeleton.js";
import { StatusBadge, type StatusTone } from "../ui/StatusBadge.js";
import { Notice, useToast } from "../ui/Toast.js";
import { AnswerReviewSwitch } from "./AnswerReviewSwitch.js";

const PROVIDER_LABELS: Record<LlmProviderName, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

const PROVIDERS: readonly LlmProviderName[] = ["anthropic", "openai", "openrouter"];

/** Where a value comes from, in the owner's words. */
export const SOURCE_TEXT: Record<SettingSource, { label: string; tone: StatusTone }> = {
  none: { label: "Using the default", tone: "neutral" },
  stored: { label: "Set in this screen", tone: "info" },
  environment: { label: "Set on the server", tone: "neutral" },
};

function SourceBadge({ source }: { source: SettingSource }) {
  const text = SOURCE_TEXT[source];
  return <StatusBadge tone={text.tone}>{text.label}</StatusBadge>;
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
  const [testResult, setTestResult] = useState<KeyTestResult | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const toast = useToast();

  const label = PROVIDER_LABELS[provider];
  const inputId = `provider-key-${provider}`;

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setTestResult(null);
    // Read once and clear state immediately so the secret does not linger in the DOM.
    const submitted = keyInput;
    setKeyInput("");
    try {
      await putJson(`/api/admin/providers/keys/${provider}`, { key: submitted });
      toast.success(`${label} key saved.`);
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
    setTestResult(null);
    try {
      await deleteJson(`/api/admin/providers/keys/${provider}`);
      toast.success(`${label} key removed.`);
      setConfirmRemove(false);
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
              ? `Saved here on ${formatDate(status.updatedAt)}.`
              : status.source === "environment"
                ? "A key was set when the server was set up."
                : "No key yet."}
          </p>
        </div>
        <StatusBadge tone={status.source === "none" ? "warning" : SOURCE_TEXT[status.source].tone}>
          {status.source === "none" ? "No key" : SOURCE_TEXT[status.source].label}
        </StatusBadge>
      </div>

      {status.unreadable && (
        <p className="warning-banner" role="alert">
          The {label} key saved here can no longer be read, so answers fail until you enter it again
          below. This happens when the server's secret key changes.
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
              onClick={() => {
                setError(null);
                setConfirmRemove(true);
              }}
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

      {error && !confirmRemove && <Notice tone="error">{error}</Notice>}
      {testResult && (
        <div className="key-test-result" role={testResult.ok ? "status" : "alert"}>
          <StatusBadge tone={testResult.ok ? "success" : "danger"}>
            {testResult.ok ? "Key works" : "Key test failed"}
          </StatusBadge>
          <span>{testResult.message}</span>
        </div>
      )}
      <ConfirmDialog
        open={confirmRemove}
        title={`Remove the ${label} key?`}
        description={
          status.source === "stored"
            ? "Answers then use the key set on the server, if there is one. Without a key, this provider stops answering."
            : ""
        }
        confirmLabel="Remove key"
        busyLabel="Removing…"
        tone="danger"
        busy={busy}
        error={error}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => void handleRemove()}
      />
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
  const [confirmReset, setConfirmReset] = useState(false);
  const [ownKeysOpen, setOwnKeysOpen] = useState(false);
  const toast = useToast();
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
      toast.success("Provider settings saved.");
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
    try {
      const updated = await putJson<ProviderSettingsView>("/api/admin/providers", {
        llmProvider: null,
        llmTier: null,
        llmModel: null,
        embeddingsProvider: null,
      });
      settingsDirtyRef.current = false;
      res.setValue(updated);
      setConfirmReset(false);
      toast.success("Back to the defaults.");
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
      <PageHeader
        title="Providers"
        description="Choose the answering and embeddings providers for this organisation."
      />

      {res.status === "loading" && !data ? (
        <Skeleton label="Loading provider settings…" lines={6} />
      ) : res.status === "error" ? (
        <ErrorState
          title="Could not load your provider settings."
          detail={res.error}
          onRetry={res.reload}
        />
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
                <SourceBadge source={data.settings.llmProvider.source} />
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
                  <SourceBadge source={data.settings.llmModel.source} />
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
                  <SourceBadge source={data.settings.llmTier.source} />
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
                <SourceBadge source={data.settings.embeddingsProvider.source} />
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
                  onClick={() => {
                    setError(null);
                    setConfirmReset(true);
                  }}
                >
                  Reset to defaults
                </button>
              )}
            </div>

            {error && !confirmReset && <Notice tone="error">{error}</Notice>}
          </form>

          <AnswerReviewSwitch view={data} onSaved={res.setValue} />

          <section className="stack" aria-labelledby="provider-keys-heading">
            <h2 id="provider-keys-heading" className="section-heading">
              API keys
            </h2>
            {data.keysManaged ? (
              <div className="source-card stack">
                <p className="managed-keys">
                  <StatusBadge tone="success">Included with your plan</StatusBadge>
                  <span>No key needed: answers use keys your plan provides.</span>
                </p>
                {data.ownKeysAllowed === true && (
                  <>
                    <div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        aria-expanded={ownKeysOpen}
                        aria-controls="own-keys"
                        onClick={() => setOwnKeysOpen((open) => !open)}
                      >
                        Use my own key
                      </button>
                    </div>
                    <div id="own-keys" className="stack" hidden={!ownKeysOpen}>
                      <p className="muted">
                        A key you save here is used instead of your plan's key for that provider.
                        Keys are encrypted and never shown again after saving.
                      </p>
                      {ownKeysOpen &&
                        PROVIDERS.map((provider) => (
                          <ProviderKeyCard
                            key={provider}
                            provider={provider}
                            status={data.keys[provider]}
                            onChanged={res.reload}
                          />
                        ))}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <>
                <p className="muted">
                  Keys are encrypted and never shown again after saving. A key saved here is used
                  instead of one set on the server.
                </p>
                {PROVIDERS.map((provider) => (
                  <ProviderKeyCard
                    key={provider}
                    provider={provider}
                    status={data.keys[provider]}
                    onChanged={res.reload}
                  />
                ))}
              </>
            )}
          </section>

          <ConfirmDialog
            open={confirmReset}
            title="Go back to the defaults?"
            description="The choices saved on this screen are removed. Answers then use the server's settings, or the built-in defaults. Saved keys are kept."
            confirmLabel="Use the defaults"
            busyLabel="Resetting…"
            busy={busy}
            error={error}
            onCancel={() => setConfirmReset(false)}
            onConfirm={() => void handleResetSettings()}
          />
        </div>
      ) : null}
    </div>
  );
}
