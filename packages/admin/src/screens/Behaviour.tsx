import type { BehaviourConfig } from "@solvchat/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, postJson, putJson } from "../api/client.js";
import type { VersionRow } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { useAssistantMutation } from "../shell/useAssistantMutations.js";
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

  const mutation = useAssistantMutation(assistantId);
  const { saving, publishing, busy } = mutation;

  const latestRef = useRef({ greeting, persona, fallbackText, questionsText });
  latestRef.current = { greeting, persona, fallbackText, questionsText };
  const lastTickRef = useRef(mutation.tick);
  const ignoreNextTickRef = useRef(false);
  const syncOnLoadRef = useRef(false);
  const prevSavedBehaviourRef = useRef<BehaviourConfig | undefined>(undefined);

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
    syncOnLoadRef.current = true;
    draft.reload();
    setHistoryTick((n) => n + 1);
  }, [mutation.tick, mutation.lastKind, draft.reload]);

  useEffect(() => {
    if (!savedBehaviour) return;
    const key = `${assistantId}:${draft.value?.draft.id ?? ""}`;
    const shouldSyncReload =
      syncOnLoadRef.current && savedBehaviour !== prevSavedBehaviourRef.current;
    if (initializedFor !== key || shouldSyncReload) {
      syncOnLoadRef.current = false;
      prevSavedBehaviourRef.current = savedBehaviour;
      setGreeting(savedBehaviour.greeting);
      setPersona(savedBehaviour.persona);
      setFallbackText(savedBehaviour.fallbackText);
      setQuestionsText(savedBehaviour.suggestedQuestions.join("\n"));
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

  async function handlePublish() {
    if (busy) return;
    setFormError(null);
    setStatusMessage(null);
    try {
      await mutation.run("publishing", async () => {
        const res = await postJson<{ version: VersionRow }>(
          `/api/admin/assistants/${assistantId}/publish`,
        );
        ignoreNextTickRef.current = true;
        setStatusMessage(
          `Published (${new Date(res.version.publishedAt ?? Date.now()).toLocaleString()}).`,
        );
        setHistoryTick((n) => n + 1);
        draft.reload();
      });
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not publish.");
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
            disabled={busy}
            onClick={handlePublish}
          >
            {publishing ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>

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
