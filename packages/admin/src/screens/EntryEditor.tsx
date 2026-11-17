import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, postJson, putJson } from "../api/client.js";
import { IDLE_SAVE, type SaveState } from "./saveState.js";

export interface EntrySaveSession {
  assistantId: string;
  sourceId?: string;
  documentId?: string;
  fromMessageId?: string;
}

/** The text in the editor's two boxes. */
export interface EntryDraft {
  question: string;
  answer: string;
}

export interface EntryEditorProps {
  assistantId: string;
  sourceId?: string | undefined;
  documentId?: string | undefined;
  fromMessageId?: string | undefined;
  initialQuestion?: string | undefined;
  initialAnswer?: string | undefined;
  /**
   * Text held by the owner instead of the editor. When given, the editor shows
   * and edits it through `onDraftChange`, so a draft outlives the editor being
   * unmounted and mounted again (for example when the list it sits in is
   * replaced by an error and comes back).
   */
  draft?: EntryDraft | undefined;
  onDraftChange?: ((draft: EntryDraft) => void) | undefined;
  /**
   * The save in progress and its errors, held by the owner like `draft`. An
   * owner that moves the editor while a save is in flight passes this so the
   * editor it mounts in the new place is still disabled until the save ends.
   */
  saveState?: SaveState | undefined;
  onSaveStateChange?: ((state: SaveState) => void) | undefined;
  onSaved?:
    | ((result: { documentId: string; sourceId: string }, session: EntrySaveSession) => void)
    | undefined;
  onCancel?: (() => void) | undefined;
}

export function EntryEditor({
  assistantId,
  sourceId,
  documentId,
  fromMessageId,
  initialQuestion = "",
  initialAnswer = "",
  draft,
  onDraftChange,
  saveState,
  onSaveStateChange,
  onSaved,
  onCancel,
}: EntryEditorProps) {
  const [ownDraft, setOwnDraft] = useState<EntryDraft>({
    question: initialQuestion,
    answer: initialAnswer,
  });
  const { question, answer } = draft ?? ownDraft;
  const [ownSaveState, setOwnSaveState] = useState<SaveState>(IDLE_SAVE);
  const { saving, fieldErrors, formError } = saveState ?? ownSaveState;
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const sessionRef = useRef(0);

  useEffect(() => {
    void assistantId;
    void sourceId;
    void documentId;
    void fromMessageId;
    sessionRef.current++;
    setOwnDraft({ question: initialQuestion, answer: initialAnswer });
    setOwnSaveState(IDLE_SAVE);
    setStatusMessage(null);
  }, [assistantId, sourceId, documentId, fromMessageId, initialQuestion, initialAnswer]);

  const isEditing = Boolean(sourceId && documentId);

  function updateDraft(next: EntryDraft) {
    if (draft !== undefined) {
      onDraftChange?.(next);
    } else {
      setOwnDraft(next);
    }
  }

  function updateSaveState(next: SaveState) {
    if (saveState !== undefined) {
      onSaveStateChange?.(next);
    } else {
      setOwnSaveState(next);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const submitSession = sessionRef.current;
    const session: EntrySaveSession = {
      assistantId,
      ...(sourceId !== undefined ? { sourceId } : {}),
      ...(documentId !== undefined ? { documentId } : {}),
      ...(fromMessageId !== undefined ? { fromMessageId } : {}),
    };
    updateSaveState({ saving: true, fieldErrors: {}, formError: null });
    setStatusMessage(null);

    let result: { documentId: string; sourceId: string };
    try {
      result = isEditing
        ? await putJson<{ documentId: string; sourceId: string }>(
            `/api/admin/sources/${sourceId}/entries/${documentId}`,
            { question, answer },
          )
        : fromMessageId
          ? await postJson<{ documentId: string; sourceId: string }>(
              `/api/admin/assistants/${assistantId}/answers`,
              { question, answer, fromMessageId },
            )
          : sourceId
            ? await postJson<{ documentId: string; sourceId: string }>(
                `/api/admin/sources/${sourceId}/entries`,
                { question, answer },
              )
            : await postJson<{ documentId: string; sourceId: string }>(
                `/api/admin/assistants/${assistantId}/entries`,
                { question, answer },
              );
    } catch (err) {
      if (sessionRef.current === submitSession) {
        updateSaveState(
          err instanceof ApiError
            ? {
                saving: false,
                fieldErrors: err.fields,
                formError: Object.keys(err.fields).length === 0 ? err.message : null,
              }
            : { saving: false, fieldErrors: {}, formError: "Could not save answer. Try again." },
        );
      }
      return;
    }

    if (sessionRef.current === submitSession) {
      updateSaveState(IDLE_SAVE);
      setStatusMessage("Answer saved.");
      if (!isEditing) {
        updateDraft({ question: "", answer: "" });
      }
    }
    onSaved?.(result, session);
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
          onChange={(e) => updateDraft({ question: e.target.value, answer })}
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
          onChange={(e) => updateDraft({ question, answer: e.target.value })}
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
