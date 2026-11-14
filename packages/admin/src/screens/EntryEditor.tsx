import { type FormEvent, useEffect, useState } from "react";
import { ApiError, postJson, putJson } from "../api/client.js";

export interface EntryEditorProps {
  assistantId: string;
  sourceId?: string | undefined;
  documentId?: string | undefined;
  initialQuestion?: string | undefined;
  initialAnswer?: string | undefined;
  onSaved?: ((result: { documentId: string; sourceId: string }) => void) | undefined;
  onCancel?: (() => void) | undefined;
}

export function EntryEditor({
  assistantId,
  sourceId,
  documentId,
  initialQuestion = "",
  initialAnswer = "",
  onSaved,
  onCancel,
}: EntryEditorProps) {
  const [question, setQuestion] = useState(initialQuestion);
  const [answer, setAnswer] = useState(initialAnswer);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    void sourceId;
    void documentId;
    setQuestion(initialQuestion);
    setAnswer(initialAnswer);
    setFieldErrors({});
    setFormError(null);
    setStatusMessage(null);
  }, [sourceId, documentId, initialQuestion, initialAnswer]);

  const isEditing = Boolean(sourceId && documentId);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setFieldErrors({});
    setFormError(null);
    setStatusMessage(null);

    try {
      const payload = { question, answer };
      const result = isEditing
        ? await putJson<{ documentId: string; sourceId: string }>(
            `/api/admin/sources/${sourceId}/entries/${documentId}`,
            payload,
          )
        : sourceId
          ? await postJson<{ documentId: string; sourceId: string }>(
              `/api/admin/sources/${sourceId}/entries`,
              payload,
            )
          : await postJson<{ documentId: string; sourceId: string }>(
              `/api/admin/assistants/${assistantId}/entries`,
              payload,
            );

      setStatusMessage("Answer saved.");
      if (!isEditing) {
        setQuestion("");
        setAnswer("");
      }
      onSaved?.(result);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fields);
        setFormError(Object.keys(err.fields).length === 0 ? err.message : null);
      } else {
        setFormError("Could not save answer. Try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="source-card stack" onSubmit={(e) => void handleSubmit(e)}>
      <h2 className="section-heading">{isEditing ? "Edit answer" : "Write an answer"}</h2>
      <div className="field">
        <label htmlFor="entry-question">Question</label>
        <input
          id="entry-question"
          type="text"
          value={question}
          disabled={saving}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What do visitors ask?"
        />
        {fieldErrors.question && (
          <p className="field-error" role="alert">
            {fieldErrors.question}
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor="entry-answer">Answer</label>
        <textarea
          id="entry-answer"
          rows={4}
          value={answer}
          disabled={saving}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Write the answer in plain words or Markdown."
        />
        {fieldErrors.answer && (
          <p className="field-error" role="alert">
            {fieldErrors.answer}
          </p>
        )}
      </div>

      {formError && (
        <p className="error-text" role="alert">
          {formError}
        </p>
      )}
      {statusMessage && (
        <p className="notice-text" role="status">
          {statusMessage}
        </p>
      )}

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? "Saving…" : "Save answer"}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
