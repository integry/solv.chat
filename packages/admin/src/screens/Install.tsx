import { useState } from "react";
import { ApiError, postJson } from "../api/client.js";
import type { InstallInfo } from "../api/types.js";
import { useResource } from "../api/useResource.js";

export interface InstallProps {
  assistantId: string;
}

export function Install({ assistantId }: InstallProps) {
  const installRes = useResource<InstallInfo>(`/api/admin/assistants/${assistantId}/install`);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  async function handleCopy(snippet: string) {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      setCopyError("Could not copy. Select the snippet and copy it manually.");
    }
  }

  async function handleRotateKey() {
    if (rotating) return;
    setRotating(true);
    setRotateError(null);
    setCopiedKey(false);
    try {
      const res = await postJson<{ ingestKey: string }>(
        `/api/admin/assistants/${assistantId}/ingest-key`,
        {},
      );
      setRotatedKey(res.ingestKey);
    } catch (err) {
      setRotateError(err instanceof ApiError ? err.message : "Could not rotate ingest key.");
    } finally {
      setRotating(false);
    }
  }

  async function handleCopyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setCopiedKey(true);
    } catch {
      setCopiedKey(false);
    }
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <div>
          <h1>Install</h1>
          <p className="muted">Add the chat widget to your website.</p>
        </div>
      </div>

      {installRes.status === "loading" && !installRes.value ? (
        <p className="muted">Loading install snippet…</p>
      ) : installRes.status === "error" ? (
        <p className="error-text" role="alert">
          {installRes.error}
        </p>
      ) : installRes.value ? (
        <div className="stack">
          <div className="source-card stack">
            <label htmlFor="install-snippet" className="stat-label">
              Paste this into your site
            </label>
            <textarea
              id="install-snippet"
              className="snippet-box"
              rows={3}
              readOnly
              value={installRes.value.snippet}
            />
            <div className="actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void handleCopy(installRes.value?.snippet ?? "")}
              >
                Copy snippet
              </button>
              {copied && (
                <span className="notice-text" role="status">
                  Copied.
                </span>
              )}
              {copyError && (
                <span className="error-text" role="alert">
                  {copyError}
                </span>
              )}
            </div>
          </div>

          <section className="source-card stack" aria-label="Allowed websites">
            <h2 className="section-heading">Allowed websites</h2>
            {installRes.value.allowedOrigins.length === 0 ? (
              // A plain warning, not a validation error: the owner has not done
              // anything wrong yet, but with no origins listed the widget refuses
              // every request, and that is invisible from the site itself.
              <p className="warning-banner" role="status">
                Add your website address on the Widget screen first. Until you do, the chat will not
                answer anyone.
              </p>
            ) : (
              <ul className="history-list">
                {installRes.value.allowedOrigins.map((origin) => (
                  <li key={origin} className="history-item">
                    <span>{origin}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="source-card stack" aria-label="Ingest key">
            <h2 className="section-heading">Ingest key</h2>
            <p className="muted">
              Used by <code>solv push</code> and <code>solv apply</code>. Shown once when created or
              rotated.
            </p>
            <div className="field">
              <label htmlFor="install-assistant-id">Assistant ID</label>
              <input id="install-assistant-id" type="text" readOnly value={assistantId} />
            </div>
            {rotatedKey && (
              <div className="stack" role="status">
                <p className="warning-banner">
                  Copy this key now. The previous key stopped working immediately.
                </p>
                <div className="field">
                  <label htmlFor="rotated-ingest-key">New ingest key</label>
                  <input id="rotated-ingest-key" type="text" readOnly value={rotatedKey} />
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleCopyKey(rotatedKey)}
                  >
                    Copy key
                  </button>
                  {copiedKey && <span className="notice-text">Copied.</span>}
                </div>
              </div>
            )}
            {rotateError && (
              <p className="error-text" role="alert">
                {rotateError}
              </p>
            )}
            <div className="actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={rotating}
                onClick={() => void handleRotateKey()}
              >
                {rotating ? "Rotating…" : "Rotate ingest key"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
