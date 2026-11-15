import type { TestExpectation } from "@solvchat/core";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, patchJson, postJson } from "../api/client.js";
import type { AnswerTest } from "../api/types.js";

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

export interface TestEditorProps {
  assistantId: string;
  testId?: string | undefined;
  initialQuestion?: string | undefined;
  initialExpectation?: TestExpectation | undefined;
  onSaved: (test: AnswerTest) => void;
  onCancel?: (() => void) | undefined;
}

/** Shared form for adding or editing an answer test. */
export function TestEditor(props: TestEditorProps) {
  const [question, setQuestion] = useState(props.initialQuestion ?? "");
  const [kind, setKind] = useState<TestExpectation["kind"]>(
    props.initialExpectation?.kind ?? "contains",
  );
  const [detail, setDetail] = useState(detailOf(props.initialExpectation));
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setQuestion(props.initialQuestion ?? "");
    setKind(props.initialExpectation?.kind ?? "contains");
    setDetail(detailOf(props.initialExpectation));
    setFieldErrors({});
    setFormError(null);
  }, [props.initialQuestion, props.initialExpectation]);

  const chosen = EXPECTATIONS.find((option) => option.kind === kind) ?? EXPECTATIONS[0];

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const expectation =
        chosen.field === null ? { kind } : { kind, [chosen.field]: detail.trim() };
      const saved = props.testId
        ? await patchJson<{ test: AnswerTest }>(`/api/admin/tests/${props.testId}`, {
            question,
            expectation,
          })
        : await postJson<{ test: AnswerTest }>(`/api/admin/assistants/${props.assistantId}/tests`, {
            question,
            expectation,
          });
      props.onSaved(saved.test);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fields);
        if (Object.keys(err.fields).length === 0) setFormError(err.message);
      } else {
        setFormError("Could not save that test.");
      }
    } finally {
      setBusy(false);
    }
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
          onChange={(e) => setQuestion(e.target.value)}
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
            setKind(e.target.value as TestExpectation["kind"]);
            setFieldErrors({});
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
            onChange={(e) => setDetail(e.target.value)}
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
