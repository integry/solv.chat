import { type FormEvent, useState } from "react";
import { ApiError, postJson } from "../api/client.js";
import type { Assistant } from "../api/types.js";

export interface AssistantSwitcherProps {
  assistants: Assistant[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreated: (assistant: Assistant) => void;
}

export function AssistantSwitcher({
  assistants,
  selectedId,
  onSelect,
  onCreated,
}: AssistantSwitcherProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [originsText, setOriginsText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<{ assistantId: string; ingestKey: string } | null>(
    null,
  );
  const [copiedKey, setCopiedKey] = useState(false);

  async function handleCopyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setCopiedKey(true);
    } catch {
      setCopiedKey(false);
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const allowedOrigins = originsText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    try {
      const res = await postJson<{ assistant: Assistant; ingestKey?: string }>(
        "/api/admin/assistants",
        {
          name,
          allowedOrigins,
        },
      );
      setName("");
      setOriginsText("");
      setCreating(false);
      setCopiedKey(false);
      if (typeof res.ingestKey === "string" && res.ingestKey.length > 0) {
        setCreatedKey({ assistantId: res.assistant.id, ingestKey: res.ingestKey });
      }
      onCreated(res.assistant);
    } catch (err) {
      if (err instanceof ApiError) {
        const firstField = Object.values(err.fields)[0];
        setError(firstField ?? err.message);
      } else {
        setError("Could not create assistant.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="switcher">
      <div className="switcher-bar">
        <label htmlFor="assistant-select" className="switcher-label">
          Assistant
        </label>
        <select
          id="assistant-select"
          className="select"
          value={selectedId ?? ""}
          onChange={(e) => onSelect(e.target.value)}
          disabled={assistants.length === 0}
        >
          {assistants.length === 0 ? (
            <option value="">No assistants yet</option>
          ) : (
            assistants.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))
          )}
        </select>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setCreating((prev) => !prev);
            setError(null);
          }}
        >
          {creating ? "Cancel" : "New assistant"}
        </button>
      </div>

      {creating && (
        <form className="switcher-form" onSubmit={handleCreate}>
          <div className="field">
            <label htmlFor="new-assistant-name">Name</label>
            <input
              id="new-assistant-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My website"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="new-assistant-origins">Allowed origins (optional, one per line)</label>
            <textarea
              id="new-assistant-origins"
              rows={2}
              value={originsText}
              onChange={(e) => setOriginsText(e.target.value)}
              placeholder="https://example.com"
            />
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Creating…" : "Create assistant"}
            </button>
          </div>
        </form>
      )}

      {createdKey && (
        <div className="switcher-form" role="status" aria-label="New ingest key">
          <p className="warning-banner">Copy your ingest key now. It is shown once.</p>
          <div className="field">
            <label htmlFor="created-assistant-id">Assistant ID</label>
            <input id="created-assistant-id" type="text" readOnly value={createdKey.assistantId} />
          </div>
          <div className="field">
            <label htmlFor="created-ingest-key">Ingest key</label>
            <input id="created-ingest-key" type="text" readOnly value={createdKey.ingestKey} />
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void handleCopyKey(createdKey.ingestKey)}
            >
              Copy key
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setCreatedKey(null)}
            >
              Done
            </button>
            {copiedKey && <span className="notice-text">Copied.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
