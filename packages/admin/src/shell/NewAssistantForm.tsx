import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, postJson } from "../api/client.js";
import type { Assistant } from "../api/types.js";

export interface CreatedAssistant {
  assistant: Assistant;
  /** One-time ingest key returned on creation, or null when none was returned. */
  ingestKey: string | null;
}

export interface NewAssistantFormProps {
  /** Prefix for field ids so two copies of the form can share a page. */
  idPrefix: string;
  className: string;
  onCreated: (created: CreatedAssistant) => void;
  /** Moves focus to the name field when the form first renders. */
  autoFocus?: boolean;
  /** Id of the element naming the form, for assistive technology. */
  labelledBy?: string;
}

/**
 * The "New assistant" form shared by the header dialog and the first-run state.
 * Validation is the API's: field errors from the create request are shown
 * under the form.
 */
export function NewAssistantForm({
  idPrefix,
  className,
  onCreated,
  autoFocus = false,
  labelledBy,
}: NewAssistantFormProps) {
  const [name, setName] = useState("");
  const [originsText, setOriginsText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) nameRef.current?.focus();
  }, [autoFocus]);

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
      setSubmitting(false);
      onCreated({
        assistant: res.assistant,
        ingestKey:
          typeof res.ingestKey === "string" && res.ingestKey.length > 0 ? res.ingestKey : null,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        const firstField = Object.values(err.fields)[0];
        setError(firstField ?? err.message);
      } else {
        setError("Could not create assistant.");
      }
      setSubmitting(false);
    }
  }

  return (
    <form className={className} onSubmit={handleCreate} aria-labelledby={labelledBy}>
      <div className="field">
        <label htmlFor={`${idPrefix}-name`}>Name</label>
        <input
          ref={nameRef}
          id={`${idPrefix}-name`}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My website"
          required
        />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-origins`}>Allowed origins (optional, one per line)</label>
        <textarea
          id={`${idPrefix}-origins`}
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
  );
}
