import type { ActionsConfig, WidgetConfig, WidgetPosition } from "@solvchat/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, patchJson, postJson, putJson } from "../api/client.js";
import type { Assistant, VersionRow } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { useAssistantMutation } from "../shell/useAssistantMutations.js";
import { History } from "./History.js";

export interface WidgetProps {
  assistantId: string;
}

function parseOrigins(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function widgetEqual(a: WidgetConfig, b: WidgetConfig): boolean {
  return a.title === b.title && a.accentColor === b.accentColor && a.position === b.position;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function actionsEqual(a: ActionsConfig, b: ActionsConfig): boolean {
  return a.builtins === b.builtins && arraysEqual(a.allowedOrigins, b.allowedOrigins);
}

function findPrefixedError(fields: Record<string, string>, prefix: string): string | undefined {
  if (fields[prefix]) return fields[prefix];
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith(`${prefix}[`)) return value;
  }
  return undefined;
}

export function Widget({ assistantId }: WidgetProps) {
  const assistantRes = useResource<{ assistant: Assistant }>(
    `/api/admin/assistants/${assistantId}`,
  );
  const draftRes = useResource<{ draft: VersionRow }>(`/api/admin/assistants/${assistantId}/draft`);

  const savedAssistant = assistantRes.value?.assistant;
  const savedWidget = draftRes.value?.draft.config.widget;
  const savedActions = draftRes.value?.draft.config.actions;

  const [title, setTitle] = useState("");
  const [accentColor, setAccentColor] = useState("#2563eb");
  const [position, setPosition] = useState<WidgetPosition>("right");
  const [originsText, setOriginsText] = useState("");
  const [builtins, setBuiltins] = useState(false);
  const [actionOriginsText, setActionOriginsText] = useState("");
  const [initWidgetKey, setInitWidgetKey] = useState<string | null>(null);
  const [initOriginsKey, setInitOriginsKey] = useState<string | null>(null);

  const [showHistory, setShowHistory] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const mutation = useAssistantMutation(assistantId);
  const { saving, publishing, busy } = mutation;

  const latestRef = useRef({
    title,
    accentColor,
    position,
    originsText,
    builtins,
    actionOriginsText,
  });
  latestRef.current = {
    title,
    accentColor,
    position,
    originsText,
    builtins,
    actionOriginsText,
  };
  const lastTickRef = useRef(mutation.tick);
  const ignoreNextTickRef = useRef(false);
  const syncWidgetOnLoadRef = useRef(false);
  const syncOriginsOnLoadRef = useRef(false);
  const syncWidgetSnapshotRef = useRef<{
    title: string;
    accentColor: string;
    position: WidgetPosition;
    builtins: boolean;
    actionOriginsText: string;
  } | null>(null);
  const syncOriginsSnapshotRef = useRef<string | null>(null);
  const prevSavedWidgetRef = useRef<WidgetConfig | undefined>(undefined);
  const prevSavedActionsRef = useRef<ActionsConfig | undefined>(undefined);
  const prevSavedAssistantRef = useRef<Assistant | undefined>(undefined);
  // What the draft fields held when Publish was pressed. Publishing replaces
  // the draft with a new one (new id), which would otherwise reset them; a
  // field changed while the publish was in flight keeps its edit.
  const publishSnapshotRef = useRef<{
    assistantId: string;
    fields: {
      title: string;
      accentColor: string;
      position: WidgetPosition;
      builtins: boolean;
      actionOriginsText: string;
    };
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
    if (!syncWidgetOnLoadRef.current) {
      syncWidgetSnapshotRef.current = {
        title: latestRef.current.title,
        accentColor: latestRef.current.accentColor,
        position: latestRef.current.position,
        builtins: latestRef.current.builtins,
        actionOriginsText: latestRef.current.actionOriginsText,
      };
      syncWidgetOnLoadRef.current = true;
    }
    if (!syncOriginsOnLoadRef.current) {
      syncOriginsSnapshotRef.current = latestRef.current.originsText;
      syncOriginsOnLoadRef.current = true;
    }
    assistantRes.reload();
    draftRes.reload();
    setHistoryTick((n) => n + 1);
  }, [mutation.tick, mutation.lastKind, assistantRes.reload, draftRes.reload]);

  useEffect(() => {
    if (!savedWidget || !savedActions) return;
    const key = `${assistantId}:${draftRes.value?.draft.id ?? ""}`;
    const shouldSyncReload =
      syncWidgetOnLoadRef.current &&
      (savedWidget !== prevSavedWidgetRef.current || savedActions !== prevSavedActionsRef.current);
    const savedActionOrigins = savedActions.allowedOrigins.join("\n");
    if (initWidgetKey !== key) {
      syncWidgetOnLoadRef.current = false;
      syncWidgetSnapshotRef.current = null;
      prevSavedWidgetRef.current = savedWidget;
      prevSavedActionsRef.current = savedActions;
      const published = publishSnapshotRef.current;
      publishSnapshotRef.current = null;
      const keep =
        published !== null && published.assistantId === assistantId ? published.fields : null;
      const latest = latestRef.current;
      if (!keep || latest.title === keep.title) setTitle(savedWidget.title);
      if (!keep || latest.accentColor === keep.accentColor) {
        setAccentColor(savedWidget.accentColor);
      }
      if (!keep || latest.position === keep.position) setPosition(savedWidget.position);
      if (!keep || latest.builtins === keep.builtins) setBuiltins(savedActions.builtins);
      if (!keep || latest.actionOriginsText === keep.actionOriginsText) {
        setActionOriginsText(savedActionOrigins);
      }
      setInitWidgetKey(key);
    } else if (
      publishSnapshotRef.current !== null &&
      (savedWidget !== prevSavedWidgetRef.current || savedActions !== prevSavedActionsRef.current)
    ) {
      // The publish reload came back with the same draft id, so nothing was
      // replaced and there is nothing to preserve.
      publishSnapshotRef.current = null;
      prevSavedWidgetRef.current = savedWidget;
      prevSavedActionsRef.current = savedActions;
    } else if (shouldSyncReload) {
      const snapshot = syncWidgetSnapshotRef.current;
      syncWidgetOnLoadRef.current = false;
      syncWidgetSnapshotRef.current = null;
      prevSavedWidgetRef.current = savedWidget;
      prevSavedActionsRef.current = savedActions;
      if (!snapshot || latestRef.current.title === snapshot.title) {
        setTitle(savedWidget.title);
      }
      if (!snapshot || latestRef.current.accentColor === snapshot.accentColor) {
        setAccentColor(savedWidget.accentColor);
      }
      if (!snapshot || latestRef.current.position === snapshot.position) {
        setPosition(savedWidget.position);
      }
      if (!snapshot || latestRef.current.builtins === snapshot.builtins) {
        setBuiltins(savedActions.builtins);
      }
      if (!snapshot || latestRef.current.actionOriginsText === snapshot.actionOriginsText) {
        setActionOriginsText(savedActionOrigins);
      }
      setInitWidgetKey(key);
    }
  }, [assistantId, draftRes.value?.draft.id, initWidgetKey, savedWidget, savedActions]);

  useEffect(() => {
    if (!savedAssistant) return;
    const key = `${assistantId}:${savedAssistant.id}`;
    const shouldSyncReload =
      syncOriginsOnLoadRef.current && savedAssistant !== prevSavedAssistantRef.current;
    if (initOriginsKey !== key) {
      syncOriginsOnLoadRef.current = false;
      syncOriginsSnapshotRef.current = null;
      prevSavedAssistantRef.current = savedAssistant;
      setOriginsText(savedAssistant.allowedOrigins.join("\n"));
      setInitOriginsKey(key);
    } else if (shouldSyncReload) {
      const snapshot = syncOriginsSnapshotRef.current;
      syncOriginsOnLoadRef.current = false;
      syncOriginsSnapshotRef.current = null;
      prevSavedAssistantRef.current = savedAssistant;
      if (snapshot === null || latestRef.current.originsText === snapshot) {
        setOriginsText(savedAssistant.allowedOrigins.join("\n"));
      }
      setInitOriginsKey(key);
    }
  }, [assistantId, initOriginsKey, savedAssistant]);

  if (
    (draftRes.status === "loading" && !savedWidget) ||
    (assistantRes.status === "loading" && !savedAssistant)
  ) {
    return <p className="muted">Loading widget settings…</p>;
  }
  if (draftRes.status === "error") {
    return (
      <p className="error-text" role="alert">
        {draftRes.error}
      </p>
    );
  }
  if (assistantRes.status === "error") {
    return (
      <p className="error-text" role="alert">
        {assistantRes.error}
      </p>
    );
  }
  if (!savedWidget || !savedActions || !savedAssistant) {
    return null;
  }

  const currentWidget: WidgetConfig = { title, accentColor, position };
  const currentOrigins = parseOrigins(originsText);
  const currentActions: ActionsConfig = {
    builtins,
    allowedOrigins: parseOrigins(actionOriginsText),
  };
  const widgetChanged = initWidgetKey !== null && !widgetEqual(currentWidget, savedWidget);
  const actionsChanged = initWidgetKey !== null && !actionsEqual(currentActions, savedActions);
  const originsChanged =
    initOriginsKey !== null && !arraysEqual(currentOrigins, savedAssistant.allowedOrigins);
  const unsaved = widgetChanged || originsChanged || actionsChanged;

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!savedAssistant || busy) return;

    setFieldErrors({});
    setFormError(null);
    setStatusMessage(null);

    const submittedOriginsText = originsText;
    const submittedWidget = { title, accentColor, position };
    const submittedActions = { builtins, actionOriginsText };
    const nextFieldErrors: Record<string, string> = {};
    let generalError: string | null = null;

    await mutation.run("saving", async () => {
      if (originsChanged) {
        try {
          const res = await patchJson<{ assistant: Assistant }>(
            `/api/admin/assistants/${assistantId}`,
            { name: savedAssistant.name, allowedOrigins: currentOrigins },
          );
          assistantRes.setValue(res);
          if (latestRef.current.originsText === submittedOriginsText) {
            setOriginsText(res.assistant.allowedOrigins.join("\n"));
          }
        } catch (err) {
          if (err instanceof ApiError) {
            Object.assign(nextFieldErrors, err.fields);
            if (Object.keys(err.fields).length === 0) generalError = err.message;
          } else {
            generalError = "Could not save allowed origins.";
          }
        }
      }

      if (widgetChanged || actionsChanged) {
        try {
          const body: Record<string, unknown> = {};
          if (widgetChanged) body.widget = currentWidget;
          if (actionsChanged) body.actions = currentActions;
          const res = await putJson<{ draft: VersionRow }>(
            `/api/admin/assistants/${assistantId}/draft`,
            body,
          );
          draftRes.setValue(res);
          if (latestRef.current.title === submittedWidget.title) {
            setTitle(res.draft.config.widget.title);
          }
          if (latestRef.current.accentColor === submittedWidget.accentColor) {
            setAccentColor(res.draft.config.widget.accentColor);
          }
          if (latestRef.current.position === submittedWidget.position) {
            setPosition(res.draft.config.widget.position);
          }
          if (latestRef.current.builtins === submittedActions.builtins) {
            setBuiltins(res.draft.config.actions.builtins);
          }
          if (latestRef.current.actionOriginsText === submittedActions.actionOriginsText) {
            setActionOriginsText(res.draft.config.actions.allowedOrigins.join("\n"));
          }
        } catch (err) {
          if (err instanceof ApiError) {
            Object.assign(nextFieldErrors, err.fields);
            if (Object.keys(err.fields).length === 0) generalError = err.message;
          } else {
            generalError = "Could not save widget settings.";
          }
        }
      }

      ignoreNextTickRef.current = true;
      if (Object.keys(nextFieldErrors).length > 0 || generalError !== null) {
        setFieldErrors(nextFieldErrors);
        setFormError(generalError);
      } else {
        setStatusMessage("Draft saved.");
      }
    });
  }

  async function handlePublish() {
    // Publishing sends the saved draft, not the form: with unsaved edits the
    // owner would publish something other than what they see.
    if (busy || unsaved) return;
    setFormError(null);
    setStatusMessage(null);
    const {
      title: t,
      accentColor: a,
      position: p,
      builtins: b,
      actionOriginsText: ao,
    } = latestRef.current;
    const snapshot = {
      assistantId,
      fields: { title: t, accentColor: a, position: p, builtins: b, actionOriginsText: ao },
    };
    try {
      await mutation.run("publishing", async () => {
        const res = await postJson<{ version: VersionRow }>(
          `/api/admin/assistants/${assistantId}/publish`,
        );
        publishSnapshotRef.current = snapshot;
        ignoreNextTickRef.current = true;
        setStatusMessage(
          `Published (${new Date(res.version.publishedAt ?? Date.now()).toLocaleString()}).`,
        );
        setHistoryTick((n) => n + 1);
        draftRes.reload();
      });
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not publish.");
    }
  }

  const originsError = findPrefixedError(fieldErrors, "allowedOrigins");
  const actionOriginsError = findPrefixedError(fieldErrors, "actions.allowedOrigins");

  return (
    <div className="screen">
      <div className="screen-header">
        <div>
          <h1>Widget</h1>
          <p className="muted">Choose how the chat button and window look on your site.</p>
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
            aria-describedby={unsaved ? "widget-publish-hint" : undefined}
            onClick={handlePublish}
          >
            {publishing ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>
      {unsaved && !busy && (
        <p id="widget-publish-hint" className="field-hint">
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

      <form className="stack" onSubmit={handleSave}>
        <div className="field">
          <label htmlFor="widget-title">Title</label>
          <input
            id="widget-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={saving}
          />
          {fieldErrors["widget.title"] && (
            <p className="field-error" role="alert">
              {fieldErrors["widget.title"]}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="widget-accent">Accent colour</label>
          <div className="color-input-row">
            <input
              id="widget-accent"
              type="text"
              value={accentColor}
              onChange={(e) => setAccentColor(e.target.value)}
              placeholder="#2563eb"
              disabled={saving}
            />
            <span
              className="color-swatch"
              style={{
                backgroundColor: /^#[0-9a-fA-F]{6}$/.test(accentColor)
                  ? accentColor
                  : "transparent",
              }}
              aria-hidden="true"
            />
          </div>
          {fieldErrors["widget.accentColor"] && (
            <p className="field-error" role="alert">
              {fieldErrors["widget.accentColor"]}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="widget-position">Position</label>
          <select
            id="widget-position"
            className="select"
            value={position}
            onChange={(e) => setPosition(e.target.value as WidgetPosition)}
            disabled={saving}
          >
            <option value="right">Right</option>
            <option value="left">Left</option>
          </select>
          {fieldErrors["widget.position"] && (
            <p className="field-error" role="alert">
              {fieldErrors["widget.position"]}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="widget-origins">Allowed origins</label>
          <textarea
            id="widget-origins"
            rows={4}
            value={originsText}
            onChange={(e) => setOriginsText(e.target.value)}
            placeholder="https://example.com"
            disabled={saving}
          />
          <span className="field-hint">Websites allowed to embed this widget, one per line.</span>
          {originsError && (
            <p className="field-error" role="alert">
              {originsError}
            </p>
          )}
        </div>

        <div className="field">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={builtins}
              disabled={saving}
              onChange={(e) => setBuiltins(e.target.checked)}
            />
            <span>Let the assistant help on the page</span>
          </label>
          {/* The plain-language list the specification asks for: the owner should be
              able to read what they just allowed without knowing the word "action". */}
          <ul className="field-hint">
            <li>Take a visitor to another page on your site.</li>
            <li>Point at a button or field and explain it.</li>
            <li>
              Fill in form fields you have marked, after the visitor agrees. It never sends, buys or
              deletes anything.
            </li>
          </ul>
        </div>

        <div className="field">
          <label htmlFor="action-origins">Other sites it may send visitors to</label>
          <textarea
            id="action-origins"
            rows={3}
            value={actionOriginsText}
            disabled={saving}
            onChange={(e) => setActionOriginsText(e.target.value)}
            placeholder="https://shop.example.com"
          />
          {/* Said explicitly because the screen already has an "Allowed origins" box
              that means something else, and confusing the two would widen either the
              embed list or the navigation list by accident. */}
          <span className="field-hint">
            One per line. Your own site is always allowed. This is not the same as the list of sites
            that may show the chat.
          </span>
          {actionOriginsError && (
            <p className="field-error" role="alert">
              {actionOriginsError}
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
