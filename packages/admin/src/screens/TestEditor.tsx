import type { TestExpectation } from "@solvchat/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, patchJson, postJson } from "../api/client.js";
import type { AnswerTest } from "../api/types.js";
import { IDLE_SAVE, type SaveState } from "./saveState.js";

/**
 * The four expectations in the owner's words. The key is the wire value; the
 * label and hint are what the screen shows, which is why they live next to
 * each other rather than in a translation table somewhere else.
 */
const EXPECTATIONS = [
  {
    kind: "contains",
    label: "It must mention",
    hint: "The answer has to include these words.",
    field: "phrase",
  },
  {
    kind: "notContains",
    label: "It must not mention",
    hint: "The answer must never include these words.",
    field: "phrase",
  },
  {
    kind: "cites",
    label: "It must link to",
    hint: "The answer has to show this page as a source.",
    field: "url",
  },
  {
    kind: "declines",
    label: "It must say it does not know",
    hint: "For questions your site should not answer.",
    field: null,
  },
] as const;

function detailOf(expectation: TestExpectation | undefined): string {
  if (!expectation) return "";
  if (expectation.kind === "cites") return expectation.url;
  if (expectation.kind === "contains" || expectation.kind === "notContains") {
    return expectation.phrase;
  }
  return "";
}

/** Formats an expectation in plain words for the test list. */
export function describeExpectation(expectation: TestExpectation): string {
  switch (expectation.kind) {
    case "contains":
      return `It must mention "${expectation.phrase}"`;
    case "notContains":
      return `It must not mention "${expectation.phrase}"`;
    case "cites":
      return `It must link to ${expectation.url}`;
    case "declines":
      return "It must say it does not know";
  }
}

/** What the owner has typed and picked so far. */
export interface TestDraft {
  question: string;
  kind: TestExpectation["kind"];
  detail: string;
}

export interface TestEditorProps {
  assistantId: string;
  testId?: string | undefined;
  initialQuestion?: string | undefined;
  initialExpectation?: TestExpectation | undefined;
  /**
   * A draft held by the owner instead of the editor. When given, the editor
   * shows and edits it through `onDraftChange`, so the draft outlives the
   * editor being unmounted and mounted again.
   */
  draft?: TestDraft | undefined;
  onDraftChange?: ((draft: TestDraft) => void) | undefined;
  /**
   * The save in progress and its errors, held by the owner like `draft`. An
   * owner that moves the editor while a save is in flight passes this so the
   * editor it mounts in the new place is still disabled until the save ends.
   */
  saveState?: SaveState | undefined;
  onSaveStateChange?: ((state: SaveState) => void) | undefined;
  onSaved: (test: AnswerTest) => void;
  onCancel?: (() => void) | undefined;
}

function initialDraftOf(props: TestEditorProps): TestDraft {
  return {
    question: props.initialQuestion ?? "",
    kind: props.initialExpectation?.kind ?? "contains",
    detail: detailOf(props.initialExpectation),
  };
}

/** Shared form for adding or editing an answer test. */
export function TestEditor(props: TestEditorProps) {
  const [ownDraft, setOwnDraft] = useState<TestDraft>(() => initialDraftOf(props));
  const current = props.draft ?? ownDraft;
  const { question, kind, detail } = current;
  const [ownSaveState, setOwnSaveState] = useState<SaveState>(IDLE_SAVE);
  const { saving: busy, fieldErrors, formError } = props.saveState ?? ownSaveState;
  const sessionRef = useRef(0);

  const latestInitialRef = useRef(initialDraftOf(props));
  latestInitialRef.current = initialDraftOf(props);
  const identityRef = useRef({ assistantId: props.assistantId, testId: props.testId });

  // Reset only when the edited target (assistant/test) changes, not when
  // initialQuestion/initialExpectation props update mid-session from an
  // earlier save completing.
  useEffect(() => {
    if (
      identityRef.current.assistantId === props.assistantId &&
      identityRef.current.testId === props.testId
    ) {
      return;
    }
    identityRef.current = { assistantId: props.assistantId, testId: props.testId };
    sessionRef.current++;
    setOwnDraft(latestInitialRef.current);
    setOwnSaveState(IDLE_SAVE);
  }, [props.assistantId, props.testId]);

  const chosen = EXPECTATIONS.find((option) => option.kind === kind) ?? EXPECTATIONS[0];

  function updateDraft(patch: Partial<TestDraft>) {
    const next = { ...current, ...patch };
    if (props.draft !== undefined) {
      props.onDraftChange?.(next);
    } else {
      setOwnDraft(next);
    }
  }

  function updateSaveState(next: SaveState) {
    if (props.saveState !== undefined) {
      props.onSaveStateChange?.(next);
    } else {
      setOwnSaveState(next);
    }
  }

  /** Puts a failed save's errors under the boxes they belong to, the rest above the buttons. */
  function failureState(err: unknown): SaveState {
    if (!(err instanceof ApiError)) {
      return { saving: false, fieldErrors: {}, formError: "Could not save that test." };
    }
    const renderedKeys = new Set([
      "question",
      ...(chosen.field !== null ? ["expectation.phrase", "expectation.url"] : []),
    ]);
    const unmatched = Object.entries(err.fields)
      .filter(([key]) => !renderedKeys.has(key))
      .map(([, message]) => message);
    const formError =
      unmatched.length > 0
        ? unmatched.join(" ")
        : Object.keys(err.fields).length === 0
          ? err.message
          : null;
    return { saving: false, fieldErrors: err.fields, formError };
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const submitSession = sessionRef.current;
    updateSaveState({ saving: true, fieldErrors: {}, formError: null });
    let saved: { test: AnswerTest };
    try {
      const expectation =
        chosen.field === null ? { kind } : { kind, [chosen.field]: detail.trim() };
      saved = props.testId
        ? await patchJson<{ test: AnswerTest }>(`/api/admin/tests/${props.testId}`, {
            question,
            expectation,
          })
        : await postJson<{ test: AnswerTest }>(`/api/admin/assistants/${props.assistantId}/tests`, {
            question,
            expectation,
          });
    } catch (err) {
      if (sessionRef.current === submitSession) {
        updateSaveState(failureState(err));
      }
      return;
    }
    if (sessionRef.current === submitSession) {
      updateSaveState(IDLE_SAVE);
    }
    props.onSaved(saved.test);
  }

  return (
    <form className="source-card stack" onSubmit={(e) => void handleSubmit(e)}>
      <h2 className="section-heading">{props.testId ? "Edit test" : "Add a test"}</h2>
      <div className="field">
        <label htmlFor="test-question">Question</label>
        <input
          id="test-question"
          type="text"
          value={question}
          disabled={busy}
          onChange={(e) => updateDraft({ question: e.target.value })}
          placeholder="What should the assistant answer?"
        />
        {fieldErrors.question && (
          <p className="field-error" role="alert">
            {fieldErrors.question}
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor="test-kind">What the answer must do</label>
        <select
          id="test-kind"
          className="select"
          value={kind}
          disabled={busy}
          onChange={(e) => {
            updateDraft({ kind: e.target.value as TestExpectation["kind"] });
            updateSaveState({ saving: false, fieldErrors: {}, formError });
          }}
        >
          {EXPECTATIONS.map((option) => (
            <option key={option.kind} value={option.kind}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="field-hint">{chosen.hint}</span>
      </div>

      {/* Only the expectation that needs a value shows a box: an owner
          choosing "it must say it does not know" should not be asked for a
          phrase they then have to leave empty. */}
      {chosen.field !== null && (
        <div className="field">
          <label htmlFor="test-detail">{chosen.field === "url" ? "Page address" : "Words"}</label>
          <input
            id="test-detail"
            type={chosen.field === "url" ? "url" : "text"}
            value={detail}
            disabled={busy}
            onChange={(e) => updateDraft({ detail: e.target.value })}
            placeholder={
              chosen.field === "url"
                ? "https://example.com/page"
                : "Words that must or must not appear"
            }
          />
          {(fieldErrors["expectation.phrase"] ?? fieldErrors["expectation.url"]) && (
            <p className="field-error" role="alert">
              {fieldErrors["expectation.phrase"] ?? fieldErrors["expectation.url"]}
            </p>
          )}
        </div>
      )}

      {formError && (
        <p className="error-text" role="alert">
          {formError}
        </p>
      )}

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !question.trim()}>
          {busy ? "Saving…" : "Save test"}
        </button>
        {props.onCancel && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={props.onCancel}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
