import { type BehaviourConfig, CONFIG_LIMITS } from "@solvchat/core";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ApiError, putJson } from "../api/client.js";
import { FailedTestsError, publishAssistant } from "../api/publish.js";
import type { TestRunSummary, VersionRow } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { useAssistantMutation, useReportUnsavedEdits } from "../shell/useAssistantMutations.js";
import { CharCount } from "../ui/CharCount.js";
import { ErrorState } from "../ui/ErrorState.js";
import { formatDateTime } from "../ui/format.js";
import { Icon } from "../ui/Icon.js";
import { PageHeader } from "../ui/PageHeader.js";
import { Skeleton } from "../ui/Skeleton.js";
import { Notice, useToast } from "../ui/Toast.js";
import { FailedTestsPanel } from "./FailedTestsPanel.js";
import { History } from "./History.js";

export interface BehaviourProps {
  assistantId: string;
}

/** The questions as saved: trimmed, empty rows left out. */
function cleanQuestions(rows: readonly string[]): string[] {
  return rows.map((q) => q.trim()).filter((q) => q.length > 0);
}

function FieldGroup({
  id,
  title,
  help,
  children,
}: {
  id: string;
  title: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <section className="field-group" aria-labelledby={`${id}-heading`}>
      <div className="field-group-text">
        <h2 id={`${id}-heading`} className="section-heading">
          {title}
        </h2>
        <p className="field-hint">{help}</p>
      </div>
      <div className="stack">{children}</div>
    </section>
  );
}

function QuestionList({
  questions,
  onChange,
  disabled,
  error,
}: {
  questions: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
  error: string | undefined;
}) {
  const listId = useId();
  const max = CONFIG_LIMITS.suggestedQuestions;
  const full = questions.length >= max;
  const [announce, setAnnounce] = useState("");

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= questions.length) return;
    const next = [...questions];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item ?? "");
    onChange(next);
    setAnnounce(`Moved question ${index + 1} to position ${target + 1}.`);
    // Keep the pressed button under the keyboard after the row moves.
    const direction = by < 0 ? "up" : "down";
    requestAnimationFrame(() => {
      const button = document.getElementById(`${listId}-${target}-${direction}`);
      if (button && !(button as HTMLButtonElement).disabled) button.focus();
      else document.getElementById(`${listId}-${target}`)?.focus();
    });
  }

  function remove(index: number) {
    const next = questions.filter((_, i) => i !== index);
    onChange(next);
    setAnnounce(`Removed question ${index + 1}.`);
    requestAnimationFrame(() => {
      const focusIndex = Math.min(index, next.length - 1);
      const el =
        focusIndex >= 0
          ? document.getElementById(`${listId}-${focusIndex}`)
          : document.getElementById(`${listId}-add`);
      el?.focus();
    });
  }

  function add() {
    if (full) return;
    onChange([...questions, ""]);
    const index = questions.length;
    requestAnimationFrame(() => document.getElementById(`${listId}-${index}`)?.focus());
  }

  return (
    <div className="stack">
      {questions.length === 0 ? (
        <p className="muted">No suggested questions. Visitors see only the greeting.</p>
      ) : (
        <ol className="question-list">
          {questions.map((question, index) => {
            const inputId = `${listId}-${index}`;
            const countId = `${inputId}-count`;
            return (
              // Rows have no identity beyond their position: the text is
              // what the owner edits, and two rows can hold the same words.
              // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
              <li key={index} className="question-row">
                <span className="question-number" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="question-input">
                  <label className="sr-only" htmlFor={inputId}>
                    Suggested question {index + 1}
                  </label>
                  <input
                    id={inputId}
                    type="text"
                    value={question}
                    disabled={disabled}
                    aria-describedby={countId}
                    placeholder="How do I get started?"
                    onChange={(e) =>
                      onChange(questions.map((q, i) => (i === index ? e.target.value : q)))
                    }
                  />
                  <CharCount id={countId} value={question} max={CONFIG_LIMITS.suggestedQuestion} />
                </div>
                <div className="question-actions">
                  <button
                    id={`${inputId}-up`}
                    type="button"
                    className="btn-icon"
                    aria-label={`Move question ${index + 1} up`}
                    disabled={disabled || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <Icon name="arrow-up" />
                  </button>
                  <button
                    id={`${inputId}-down`}
                    type="button"
                    className="btn-icon"
                    aria-label={`Move question ${index + 1} down`}
                    disabled={disabled || index === questions.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <Icon name="arrow-down" />
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    aria-label={`Remove question ${index + 1}`}
                    disabled={disabled}
                    onClick={() => remove(index)}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className="actions">
        <button
          id={`${listId}-add`}
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={disabled || full}
          onClick={add}
        >
          <Icon name="plus" />
          Add a question
        </button>
        <span className="field-hint">
          {questions.length} of {max}
          {full ? " — that is the most the chat shows." : ""}
        </span>
      </div>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function behaviourEqual(a: BehaviourConfig, b: BehaviourConfig): boolean {
  return (
    a.greeting === b.greeting &&
    a.persona === b.persona &&
    a.fallbackText === b.fallbackText &&
    sameStrings(a.suggestedQuestions, b.suggestedQuestions)
  );
}

function findQuestionError(fields: Record<string, string>): string | undefined {
  if (fields["behaviour.suggestedQuestions"]) return fields["behaviour.suggestedQuestions"];
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("behaviour.suggestedQuestions[")) return value;
  }
  return undefined;
}

const DESCRIPTION = "How your assistant greets visitors and answers them.";

export function Behaviour({ assistantId }: BehaviourProps) {
  const draft = useResource<{ draft: VersionRow }>(`/api/admin/assistants/${assistantId}/draft`);
  const savedBehaviour = draft.value?.draft.config.behaviour;

  const [greeting, setGreeting] = useState("");
  const [persona, setPersona] = useState("");
  const [fallbackText, setFallbackText] = useState("");
  const [questions, setQuestions] = useState<string[]>([]);
  const [initializedFor, setInitializedFor] = useState<string | null>(null);

  const [showHistory, setShowHistory] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const toast = useToast();
  const [failedRun, setFailedRun] = useState<TestRunSummary | null>(null);

  const mutation = useAssistantMutation(assistantId);
  const { saving, publishing, busy } = mutation;

  const latestRef = useRef({ greeting, persona, fallbackText, questions });
  latestRef.current = { greeting, persona, fallbackText, questions };
  const savedBehaviourRef = useRef(savedBehaviour);
  savedBehaviourRef.current = savedBehaviour;
  const lastTickRef = useRef(mutation.tick);
  const ignoreNextTickRef = useRef(false);
  const syncOnLoadRef = useRef(false);
  const syncSnapshotRef = useRef<{
    greeting: string;
    persona: string;
    fallbackText: string;
    questions: string[];
  } | null>(null);
  const prevSavedBehaviourRef = useRef<BehaviourConfig | undefined>(undefined);
  // What the fields held when Publish was pressed. Publishing replaces the
  // draft with a new one (new id), which would otherwise reset every field;
  // a field the owner changed while the publish was in flight keeps its edit.
  const publishSnapshotRef = useRef<{
    assistantId: string;
    fields: { greeting: string; persona: string; fallbackText: string; questions: string[] };
  } | null>(null);

  useEffect(() => {
    if (mutation.tick === lastTickRef.current) return;
    lastTickRef.current = mutation.tick;
    if (ignoreNextTickRef.current) {
      ignoreNextTickRef.current = false;
      return;
    }
    if (mutation.lastKind === "publishing") {
      // Published from outside this screen (the header). Publishing replaces
      // the draft and adds a version, so reload both. Publish waits for edits
      // to be saved, so a field that now differs from the saved draft was
      // changed while the publish was in flight and keeps its edit.
      const saved = savedBehaviourRef.current;
      if (saved) {
        const latest = latestRef.current;
        const questionsSame = sameStrings(
          cleanQuestions(latest.questions),
          saved.suggestedQuestions,
        );
        publishSnapshotRef.current = {
          assistantId,
          fields: {
            greeting: saved.greeting,
            persona: saved.persona,
            fallbackText: saved.fallbackText,
            questions: questionsSame ? latest.questions : saved.suggestedQuestions,
          },
        };
      }
      draft.reload();
      setHistoryTick((n) => n + 1);
      return;
    }
    if (mutation.lastKind !== "saving") {
      return;
    }
    if (!syncOnLoadRef.current) {
      syncSnapshotRef.current = { ...latestRef.current };
      syncOnLoadRef.current = true;
    }
    draft.reload();
    setHistoryTick((n) => n + 1);
  }, [mutation.tick, mutation.lastKind, draft.reload, assistantId]);

  useEffect(() => {
    if (!savedBehaviour) return;
    const key = `${assistantId}:${draft.value?.draft.id ?? ""}`;
    const shouldSyncReload =
      syncOnLoadRef.current && savedBehaviour !== prevSavedBehaviourRef.current;
    if (initializedFor !== key) {
      syncOnLoadRef.current = false;
      syncSnapshotRef.current = null;
      prevSavedBehaviourRef.current = savedBehaviour;
      const published = publishSnapshotRef.current;
      publishSnapshotRef.current = null;
      const keep =
        published !== null && published.assistantId === assistantId ? published.fields : null;
      const latest = latestRef.current;
      if (!keep || latest.greeting === keep.greeting) setGreeting(savedBehaviour.greeting);
      if (!keep || latest.persona === keep.persona) setPersona(savedBehaviour.persona);
      if (!keep || latest.fallbackText === keep.fallbackText) {
        setFallbackText(savedBehaviour.fallbackText);
      }
      if (!keep || sameStrings(latest.questions, keep.questions)) {
        setQuestions(savedBehaviour.suggestedQuestions);
      }
      setInitializedFor(key);
    } else if (
      publishSnapshotRef.current !== null &&
      savedBehaviour !== prevSavedBehaviourRef.current
    ) {
      // The publish reload came back with the same draft id, so nothing was
      // replaced and there is nothing to preserve.
      publishSnapshotRef.current = null;
      prevSavedBehaviourRef.current = savedBehaviour;
    } else if (shouldSyncReload) {
      const snapshot = syncSnapshotRef.current;
      syncOnLoadRef.current = false;
      syncSnapshotRef.current = null;
      prevSavedBehaviourRef.current = savedBehaviour;
      if (!snapshot || latestRef.current.greeting === snapshot.greeting) {
        setGreeting(savedBehaviour.greeting);
      }
      if (!snapshot || latestRef.current.persona === snapshot.persona) {
        setPersona(savedBehaviour.persona);
      }
      if (!snapshot || latestRef.current.fallbackText === snapshot.fallbackText) {
        setFallbackText(savedBehaviour.fallbackText);
      }
      if (!snapshot || sameStrings(latestRef.current.questions, snapshot.questions)) {
        setQuestions(savedBehaviour.suggestedQuestions);
      }
      setInitializedFor(key);
    }
  }, [assistantId, draft.value?.draft.id, initializedFor, savedBehaviour]);

  const current: BehaviourConfig = {
    greeting,
    persona,
    fallbackText,
    suggestedQuestions: cleanQuestions(questions),
  };
  const unsaved =
    savedBehaviour !== undefined &&
    initializedFor !== null &&
    !behaviourEqual(current, savedBehaviour);
  // The header's Publish sends the saved draft too, so it waits for a save.
  useReportUnsavedEdits(assistantId, unsaved);

  if (draft.status === "loading" && !savedBehaviour) {
    return (
      <div className="screen">
        <PageHeader title="Behaviour" description={DESCRIPTION} />
        <Skeleton label="Loading behaviour…" lines={6} />
      </div>
    );
  }
  if (draft.status === "error") {
    return (
      <div className="screen">
        <PageHeader title="Behaviour" description={DESCRIPTION} />
        <ErrorState
          title="Could not load your assistant's behaviour."
          detail={draft.error}
          onRetry={draft.reload}
        />
      </div>
    );
  }
  if (!savedBehaviour) {
    return null;
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFieldErrors({});
    setFormError(null);
    setFailedRun(null);

    const submitted = { greeting, persona, fallbackText, questions };

    try {
      await mutation.run("saving", async () => {
        const res = await putJson<{ draft: VersionRow }>(
          `/api/admin/assistants/${assistantId}/draft`,
          { behaviour: current },
        );
        ignoreNextTickRef.current = true;
        draft.setValue(res);
        if (latestRef.current.greeting === submitted.greeting) {
          setGreeting(res.draft.config.behaviour.greeting);
        }
        if (latestRef.current.persona === submitted.persona) {
          setPersona(res.draft.config.behaviour.persona);
        }
        if (latestRef.current.fallbackText === submitted.fallbackText) {
          setFallbackText(res.draft.config.behaviour.fallbackText);
        }
        if (sameStrings(latestRef.current.questions, submitted.questions)) {
          setQuestions(res.draft.config.behaviour.suggestedQuestions);
        }
        toast.success("Draft saved.");
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fields);
        if (Object.keys(err.fields).length === 0) {
          setFormError(err.message);
        }
      } else {
        setFormError("Could not save draft.");
      }
    }
  }

  async function handlePublish(force = false, runId?: string) {
    // Publishing sends the saved draft, not the form: with unsaved edits the
    // owner would publish something other than what they see.
    if (busy || unsaved) return;
    setFormError(null);
    setFailedRun(null);
    const snapshot = { assistantId, fields: { ...latestRef.current } };
    try {
      await mutation.run("publishing", async () => {
        const res = await publishAssistant(assistantId, force, runId);
        publishSnapshotRef.current = snapshot;
        ignoreNextTickRef.current = true;
        toast.success(`Published (${formatDateTime(res.version.publishedAt ?? Date.now())}).`);
        setHistoryTick((n) => n + 1);
        draft.reload();
      });
    } catch (err) {
      if (err instanceof FailedTestsError) {
        setFailedRun(err.run);
      } else {
        setFormError(err instanceof ApiError ? err.message : "Could not publish.");
      }
    }
  }

  const questionError = findQuestionError(fieldErrors);

  return (
    <div className="screen">
      <PageHeader
        title="Behaviour"
        description={DESCRIPTION}
        actions={
          <>
            {unsaved && <span className="unsaved-badge">Unsaved changes</span>}
            <button
              type="button"
              className="btn btn-secondary"
              aria-expanded={showHistory}
              onClick={() => setShowHistory((prev) => !prev)}
            >
              History
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || unsaved}
              aria-describedby={unsaved ? "behaviour-publish-hint" : undefined}
              onClick={() => void handlePublish(false)}
            >
              {publishing ? "Publishing…" : "Publish"}
            </button>
          </>
        }
      />
      {unsaved && !busy && (
        <p id="behaviour-publish-hint" className="field-hint">
          Save your changes before publishing.
        </p>
      )}

      {formError && <Notice tone="error">{formError}</Notice>}
      {failedRun && (
        <FailedTestsPanel
          run={failedRun}
          busy={busy}
          publishBlocked={unsaved}
          onFix={() => setFailedRun(null)}
          onPublishAnyway={() => void handlePublish(true, failedRun.id)}
        />
      )}

      <form className="stack form-groups" onSubmit={handleSave}>
        <FieldGroup
          id="behaviour-greeting-group"
          title="Greeting"
          help="The first message visitors see when they open the chat."
        >
          <div className="field">
            <label htmlFor="behaviour-greeting">First thing it says</label>
            <input
              id="behaviour-greeting"
              type="text"
              value={greeting}
              onChange={(e) => setGreeting(e.target.value)}
              aria-describedby="behaviour-greeting-count"
              disabled={saving}
            />
            <CharCount
              id="behaviour-greeting-count"
              value={greeting}
              max={CONFIG_LIMITS.greeting}
            />
            {fieldErrors["behaviour.greeting"] && (
              <p className="field-error" role="alert">
                {fieldErrors["behaviour.greeting"]}
              </p>
            )}
          </div>
        </FieldGroup>

        <FieldGroup
          id="behaviour-tone-group"
          title="Tone"
          help="Describe its voice in a sentence or two. It always answers from your content."
        >
          <div className="field">
            <label htmlFor="behaviour-persona">How it should sound</label>
            <textarea
              id="behaviour-persona"
              rows={4}
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              placeholder="Friendly, concise, and helpful."
              aria-describedby="behaviour-persona-count"
              disabled={saving}
            />
            <CharCount id="behaviour-persona-count" value={persona} max={CONFIG_LIMITS.persona} />
            {fieldErrors["behaviour.persona"] && (
              <p className="field-error" role="alert">
                {fieldErrors["behaviour.persona"]}
              </p>
            )}
          </div>
        </FieldGroup>

        <FieldGroup
          id="behaviour-fallback-group"
          title="When it does not know"
          help="What it says when your content has no answer. Those questions show up under Gaps."
        >
          <div className="field">
            <label htmlFor="behaviour-fallback">What to say when it does not know</label>
            <textarea
              id="behaviour-fallback"
              rows={2}
              value={fallbackText}
              onChange={(e) => setFallbackText(e.target.value)}
              aria-describedby="behaviour-fallback-count"
              disabled={saving}
            />
            <CharCount
              id="behaviour-fallback-count"
              value={fallbackText}
              max={CONFIG_LIMITS.fallbackText}
            />
            {fieldErrors["behaviour.fallbackText"] && (
              <p className="field-error" role="alert">
                {fieldErrors["behaviour.fallbackText"]}
              </p>
            )}
          </div>
        </FieldGroup>

        <FieldGroup
          id="behaviour-questions-group"
          title="Suggested questions"
          help="Buttons visitors can press instead of typing, in this order."
        >
          <QuestionList
            questions={questions}
            onChange={setQuestions}
            disabled={saving}
            error={questionError}
          />
        </FieldGroup>

        <div className="actions form-footer">
          <button type="submit" className="btn btn-primary" disabled={!unsaved || busy}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>

      {showHistory && <History assistantId={assistantId} refreshKey={historyTick} />}
    </div>
  );
}
