import { useState } from "react";
import type { InstallInfo } from "../api/types.js";
import { useResource } from "../api/useResource.js";

export interface InstallProps {
  assistantId: string;
}

export function Install({ assistantId }: InstallProps) {
  const installRes = useResource<InstallInfo>(`/api/admin/assistants/${assistantId}/install`);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function handleCopy(snippet: string) {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      setCopyError("Could not copy. Select the snippet and copy it manually.");
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
        </div>
      ) : null}
    </div>
  );
}
