import type { BehaviourConfig } from "@solvchat/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, putJson } from "../api/client.js";
import { FailedTestsError, publishAssistant } from "../api/publish.js";
import type { TestRunSummary, VersionRow } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { useAssistantMutation } from "../shell/useAssistantMutations.js";
import { FailedTestsPanel } from "./FailedTestsPanel.js";
import { History } from "./History.js";

export interface BehaviourProps {
  assistantId: string;
}

function parseQuestions(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function behaviourEqual(a: BehaviourConfig, b: BehaviourConfig): boolean {
  return (
    a.greeting === b.greeting &&
    a.persona === b.persona &&
    a.fallbackText === b.fallbackText &&
    a.suggestedQuestions.length === b.suggestedQuestions.length &&
    a.suggestedQuestions.every((q, i) => q === b.suggestedQuestions[i])
  );
}

function findQuestionError(fields: Record<string, string>): string | undefined {
  if (fields["behaviour.suggestedQuestions"]) return fields["behaviour.suggestedQuestions"];
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("behaviour.suggestedQuestions[")) return value;
  }
  return undefined;
}

export function Behaviour({ assistantId }: BehaviourProps) {
  const draft = useResource<{ draft: VersionRow }>(`/api/admin/assistants/${assistantId}/draft`);
  const savedBehaviour = draft.value?.draft.config.behaviour;

  const [greeting, setGreeting] = useState("");
  const [persona, setPersona] = useState("");
  const [fallbackText, setFallbackText] = useState("");
  const [questionsText, setQuestionsText] = useState("");
  const [initializedFor, setInitializedFor] = useState<string | null>(null);

  const [showHistory, setShowHistory] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [failedRun, setFailedRun] = useState<TestRunSummary | null>(null);

  const mutation = useAssistantMutation(assistantId);
  const { saving, publishing, busy } = mutation;

  const latestRef = useRef({ greeting, persona, fallbackText, questionsText });
  latestRef.current = { greeting, persona, fallbackText, questionsText };
  const lastTickRef = useRef(mutation.tick);
  const ignoreNextTickRef = useRef(false);
  const syncOnLoadRef = useRef(false);
  const syncSnapshotRef = useRef<{
    greeting: string;
    persona: string;
    fallbackText: string;
    questionsText: string;
  } | null>(null);
  const prevSavedBehaviourRef = useRef<BehaviourConfig | undefined>(undefined);
  // What the fields held when Publish was pressed. Publishing replaces the
  // draft with a new one (new id), which would otherwise reset every field;
  // a field the owner changed while the publish was in flight keeps its edit.
  const publishSnapshotRef = useRef<{
    assistantId: string;
    fields: { greeting: string; persona: string; fallbackText: string; questionsText: string };
  } | null>(null);

  useEffect(() => {
    if (mutation.tick === lastTickRef.current) return;
    lastTickRef.current = mutation.tick;
    if (ignoreNextTickRef.current) {
      ignoreNextTickRef.current = false;
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
  }, [mutation.tick, mutation.lastKind, draft.reload]);

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
      if (!keep || latest.questionsText === keep.questionsText) {
        setQuestionsText(savedBehaviour.suggestedQuestions.join("\n"));
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
      if (!snapshot || latestRef.current.questionsText === snapshot.questionsText) {
        setQuestionsText(savedBehaviour.suggestedQuestions.join("\n"));
      }
      setInitializedFor(key);
    }
  }, [assistantId, draft.value?.draft.id, initializedFor, savedBehaviour]);

  if (draft.status === "loading" && !savedBehaviour) {
    return <p className="muted">Loading behaviour…</p>;
  }
  if (draft.status === "error") {
    return (
      <p className="error-text" role="alert">
        {draft.error}
      </p>
    );
  }
  if (!savedBehaviour) {
    return null;
  }

  const current: BehaviourConfig = {
    greeting,
    persona,
    fallbackText,
    suggestedQuestions: parseQuestions(questionsText),
  };
  const unsaved = initializedFor !== null && !behaviourEqual(current, savedBehaviour);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFieldErrors({});
    setFormError(null);
    setStatusMessage(null);
    setFailedRun(null);

    const submitted = { greeting, persona, fallbackText, questionsText };

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
        if (latestRef.current.questionsText === submitted.questionsText) {
          setQuestionsText(res.draft.config.behaviour.suggestedQuestions.join("\n"));
        }
        setStatusMessage("Draft saved.");
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

  async function handlePublish(force = false) {
    // Publishing sends the saved draft, not the form: with unsaved edits the
    // owner would publish something other than what they see.
    if (busy || unsaved) return;
    setFormError(null);
    setStatusMessage(null);
    setFailedRun(null);
    const snapshot = { assistantId, fields: { ...latestRef.current } };
    try {
      await mutation.run("publishing", async () => {
        const res = await publishAssistant(assistantId, force);
        publishSnapshotRef.current = snapshot;
        ignoreNextTickRef.current = true;
        setStatusMessage(
          `Published (${new Date(res.version.publishedAt ?? Date.now()).toLocaleString()}).`,
        );
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
      <div className="screen-header">
        <div>
          <h1>Behaviour</h1>
          <p className="muted">Control how your assistant greets visitors and responds.</p>
        </div>
        <div className="screen-actions">
          {unsaved && <span className="unsaved-badge">Unsaved changes</span>}
          <button
            type="button"
            className="btn btn-secondary"
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
        </div>
      </div>
      {unsaved && !busy && (
        <p id="behaviour-publish-hint" className="field-hint">
          Save your changes before publishing.
        </p>
      )}

      {statusMessage && (
        <p className="notice-text" role="status">
          {statusMessage}
        </p>
      )}
      {formError && (
        <p className="error-text" role="alert">
          {formError}
        </p>
      )}
      {failedRun && (
        <FailedTestsPanel
          run={failedRun}
          busy={busy}
          onFix={() => setFailedRun(null)}
          onPublishAnyway={() => void handlePublish(true)}
        />
      )}

      <form className="stack" onSubmit={handleSave}>
        <div className="field">
          <label htmlFor="behaviour-greeting">First thing it says</label>
          <input
            id="behaviour-greeting"
            type="text"
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            disabled={saving}
          />
          {fieldErrors["behaviour.greeting"] && (
            <p className="field-error" role="alert">
              {fieldErrors["behaviour.greeting"]}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="behaviour-persona">How it should sound</label>
          <textarea
            id="behaviour-persona"
            rows={4}
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder="Friendly, concise, and helpful."
            disabled={saving}
          />
          {fieldErrors["behaviour.persona"] && (
            <p className="field-error" role="alert">
              {fieldErrors["behaviour.persona"]}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="behaviour-fallback">What to say when it does not know</label>
          <textarea
            id="behaviour-fallback"
            rows={2}
            value={fallbackText}
            onChange={(e) => setFallbackText(e.target.value)}
            disabled={saving}
          />
          {fieldErrors["behaviour.fallbackText"] && (
            <p className="field-error" role="alert">
              {fieldErrors["behaviour.fallbackText"]}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="behaviour-questions">Questions to suggest</label>
          <textarea
            id="behaviour-questions"
            rows={4}
            value={questionsText}
            onChange={(e) => setQuestionsText(e.target.value)}
            placeholder="One question per line (up to 6)"
            disabled={saving}
          />
          <span className="field-hint">One question per line, up to 6.</span>
          {questionError && (
            <p className="field-error" role="alert">
              {questionError}
            </p>
          )}
        </div>

        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={!unsaved || busy}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>

      {showHistory && <History assistantId={assistantId} refreshKey={historyTick} />}
    </div>
  );
}
