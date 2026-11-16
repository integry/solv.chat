import { useState } from "react";
import type { Assistant } from "../api/types.js";
import { type CreatedAssistant, NewAssistantForm } from "./NewAssistantForm.js";

export interface CreatedIngestKey {
  assistantId: string;
  ingestKey: string;
}

export interface AssistantSwitcherProps {
  assistants: Assistant[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreated: (created: CreatedAssistant) => void;
  /** Oldest undismissed one-time ingest key, shown until dismissed. */
  createdKey: CreatedIngestKey | null;
  /** How many more new keys wait behind `createdKey`. */
  pendingKeyCount?: number;
  onDismissKey: (assistantId: string) => void;
  /** Hides the switcher without unmounting it, so an unsent form is kept. */
  hidden?: boolean;
}

function IngestKeyNotice({
  createdKey,
  pendingCount,
  onDismiss,
}: {
  createdKey: CreatedIngestKey;
  pendingCount: number;
  onDismiss: () => void;
}) {
  const [copiedKey, setCopiedKey] = useState(false);

  async function handleCopyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setCopiedKey(true);
    } catch {
      setCopiedKey(false);
    }
  }

  return (
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
        <button type="button" className="btn btn-secondary btn-sm" onClick={onDismiss}>
          Done
        </button>
        {copiedKey && <span className="notice-text">Copied.</span>}
      </div>
      {pendingCount > 0 && (
        <p className="notice-text">
          {pendingCount === 1
            ? "1 more new key is next."
            : `${pendingCount} more new keys are next.`}
        </p>
      )}
    </div>
  );
}

export function AssistantSwitcher({
  assistants,
  selectedId,
  onSelect,
  onCreated,
  createdKey,
  pendingKeyCount = 0,
  onDismissKey,
  hidden = false,
}: AssistantSwitcherProps) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="switcher" hidden={hidden}>
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
          onClick={() => setCreating((prev) => !prev)}
        >
          {creating ? "Cancel" : "New assistant"}
        </button>
      </div>

      {creating && (
        <NewAssistantForm
          idPrefix="new-assistant"
          className="switcher-form"
          onCreated={(created) => {
            setCreating(false);
            onCreated(created);
          }}
        />
      )}

      {createdKey && (
        <IngestKeyNotice
          key={createdKey.assistantId}
          createdKey={createdKey}
          pendingCount={pendingKeyCount}
          onDismiss={() => onDismissKey(createdKey.assistantId)}
        />
      )}
    </div>
  );
}
