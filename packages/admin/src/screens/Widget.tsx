import {
  type ActionsConfig,
  CONFIG_LIMITS,
  checkOrigin,
  type WidgetConfig,
  type WidgetPosition,
} from "@solvchat/core";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, patchJson, putJson } from "../api/client.js";
import {
  type ConfirmedDraft,
  DraftChangedError,
  FailedTestsError,
  publishAssistant,
} from "../api/publish.js";
import type { Assistant, TestRunSummary, VersionRow } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { PublishConfirmDialog, usePublishConfirmation } from "../shell/PublishConfirm.js";
import { useAssistantMutation, useReportUnsavedEdits } from "../shell/useAssistantMutations.js";
import { CharCount } from "../ui/CharCount.js";
import { contrastRatio, MIN_TEXT_CONTRAST } from "../ui/color.js";
import { ErrorState } from "../ui/ErrorState.js";
import { formatDateTime } from "../ui/format.js";
import { PageHeader } from "../ui/PageHeader.js";
import { Skeleton } from "../ui/Skeleton.js";
import { Notice, useToast } from "../ui/Toast.js";
import { FailedTestsPanel } from "./FailedTestsPanel.js";
import { History } from "./History.js";
import { WidgetPreview } from "./WidgetPreview.js";

export interface WidgetProps {
  assistantId: string;
}

function parseOrigins(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** Plain words shared with Install, which shows the same list read-only. */
export const ORIGINS_LABEL = "Websites that may show the chat";
export const ORIGINS_HINT =
  "One address per line, for example https://www.example.com. List each one visitors use, such as with and without www.";

export interface LineProblem {
  line: number;
  value: string;
  error: string;
}

/** Checks each non-empty line the way the API will. */
export function checkOriginLines(text: string): LineProblem[] {
  const problems: LineProblem[] = [];
  text.split("\n").forEach((raw, index) => {
    const value = raw.trim();
    if (value === "") return;
    const result = checkOrigin(value);
    if (!result.ok) problems.push({ line: index + 1, value, error: result.error });
  });
  return problems;
}

function LineProblems({ id, problems }: { id: string; problems: LineProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <ul id={id} className="field-error line-problems">
      {problems.map((p) => (
        <li key={`${p.line}:${p.value}`}>
          Line {p.line} ({p.value}): {p.error}
        </li>
      ))}
    </ul>
  );
}

function widgetEqual(a: WidgetConfig, b: WidgetConfig): boolean {
  return (
    a.title === b.title &&
    a.accentColor === b.accentColor &&
    a.position === b.position &&
    a.allowExpand === b.allowExpand
  );
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

const DESCRIPTION = "Choose how the chat button and window look on your site.";

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
  const [allowExpand, setAllowExpand] = useState(true);
  const [originsText, setOriginsText] = useState("");
  const [builtins, setBuiltins] = useState(false);
  const [actionOriginsText, setActionOriginsText] = useState("");
  const [initWidgetKey, setInitWidgetKey] = useState<string | null>(null);
  const [initOriginsKey, setInitOriginsKey] = useState<string | null>(null);

  const [showHistory, setShowHistory] = useState(false);
  const confirmation = usePublishConfirmation(assistantId, (confirmed) => {
    void handlePublish(false, undefined, confirmed);
  });
  const [historyTick, setHistoryTick] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const toast = useToast();
  const [checkedOrigins, setCheckedOrigins] = useState(false);
  const [failedRun, setFailedRun] = useState<TestRunSummary | null>(null);

  const mutation = useAssistantMutation(assistantId);
  const { saving, publishing, busy } = mutation;

  const latestRef = useRef({
    title,
    accentColor,
    position,
    allowExpand,
    originsText,
    builtins,
    actionOriginsText,
  });
  latestRef.current = {
    title,
    accentColor,
    position,
    allowExpand,
    originsText,
    builtins,
    actionOriginsText,
  };
  const savedDraftRef = useRef({ widget: savedWidget, actions: savedActions });
  savedDraftRef.current = { widget: savedWidget, actions: savedActions };
  const lastTickRef = useRef(mutation.tick);
  const ignoreNextTickRef = useRef(false);
  const syncWidgetOnLoadRef = useRef(false);
  const syncOriginsOnLoadRef = useRef(false);
  const syncWidgetSnapshotRef = useRef<{
    title: string;
    accentColor: string;
    position: WidgetPosition;
    allowExpand: boolean;
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
      allowExpand: boolean;
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
    if (mutation.lastKind === "publishing") {
      // Published from outside this screen (the header). Publishing replaces
      // the draft and adds a version, so reload both. Publish waits for edits
      // to be saved, so a field that now differs from the saved draft was
      // changed while the publish was in flight and keeps its edit.
      const { widget, actions } = savedDraftRef.current;
      if (widget && actions) {
        const latest = latestRef.current;
        const actionOriginsSame = arraysEqual(
          parseOrigins(latest.actionOriginsText),
          actions.allowedOrigins,
        );
        publishSnapshotRef.current = {
          assistantId,
          fields: {
            title: widget.title,
            accentColor: widget.accentColor,
            position: widget.position,
            allowExpand: widget.allowExpand,
            builtins: actions.builtins,
            actionOriginsText: actionOriginsSame
              ? latest.actionOriginsText
              : actions.allowedOrigins.join("\n"),
          },
        };
      }
      draftRes.reload();
      setHistoryTick((n) => n + 1);
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
        allowExpand: latestRef.current.allowExpand,
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
  }, [mutation.tick, mutation.lastKind, assistantRes.reload, draftRes.reload, assistantId]);

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
      if (!keep || latest.allowExpand === keep.allowExpand) {
        setAllowExpand(savedWidget.allowExpand);
      }
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
      if (!snapshot || latestRef.current.allowExpand === snapshot.allowExpand) {
        setAllowExpand(savedWidget.allowExpand);
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

  const currentWidget: WidgetConfig = { title, accentColor, position, allowExpand };
  const currentOrigins = parseOrigins(originsText);
  const currentActions: ActionsConfig = {
    builtins,
    allowedOrigins: parseOrigins(actionOriginsText),
  };
  const widgetChanged =
    savedWidget !== undefined && initWidgetKey !== null && !widgetEqual(currentWidget, savedWidget);
  const actionsChanged =
    savedActions !== undefined &&
    initWidgetKey !== null &&
    !actionsEqual(currentActions, savedActions);
  const originsChanged =
    savedAssistant !== undefined &&
    initOriginsKey !== null &&
    !arraysEqual(currentOrigins, savedAssistant.allowedOrigins);
  const unsaved = widgetChanged || originsChanged || actionsChanged;
  // The header's Publish sends the saved draft too, so it waits for a save.
  useReportUnsavedEdits(assistantId, unsaved);

  const savedBehaviour = draftRes.value?.draft.config.behaviour;
  const previewConfig = useMemo(
    () => ({
      widget: {
        title: title.trim() || "Ask a question",
        accentColor: HEX_COLOUR.test(accentColor.trim()) ? accentColor.trim() : "#2563eb",
        position,
        allowExpand,
      },
      behaviour: {
        greeting: savedBehaviour?.greeting ?? "",
        suggestedQuestions: savedBehaviour?.suggestedQuestions ?? [],
      },
    }),
    [title, accentColor, position, allowExpand, savedBehaviour],
  );
  const originProblems = checkOriginLines(originsText);
  const actionOriginProblems = checkOriginLines(actionOriginsText);

  if (draftRes.status === "error" || assistantRes.status === "error") {
    return (
      <div className="screen">
        <PageHeader title="Widget" description={DESCRIPTION} />
        <ErrorState
          title="Could not load your widget settings."
          detail={draftRes.error ?? assistantRes.error}
          onRetry={() => {
            if (draftRes.status === "error") draftRes.reload();
            if (assistantRes.status === "error") assistantRes.reload();
          }}
        />
      </div>
    );
  }
  if (
    (draftRes.status === "loading" && !savedWidget) ||
    (assistantRes.status === "loading" && !savedAssistant)
  ) {
    return (
      <div className="screen">
        <PageHeader title="Widget" description={DESCRIPTION} />
        <Skeleton label="Loading widget settings…" lines={6} />
      </div>
    );
  }
  if (!savedWidget || !savedActions || !savedAssistant) {
    return null;
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!savedAssistant || busy) return;
    setCheckedOrigins(true);
    if (originProblems.length > 0 || actionOriginProblems.length > 0) {
      document
        .getElementById(originProblems.length > 0 ? "widget-origins" : "action-origins")
        ?.focus();
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setFailedRun(null);

    const submittedOriginsText = originsText;
    const submittedWidget = { title, accentColor, position, allowExpand };
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
          if (latestRef.current.allowExpand === submittedWidget.allowExpand) {
            setAllowExpand(res.draft.config.widget.allowExpand);
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
        toast.success("Draft saved.");
      }
    });
  }

  async function handlePublish(
    force = false,
    runId?: string,
    confirmed: ConfirmedDraft | undefined = confirmation.confirmed(),
  ) {
    // Publishing sends the saved draft, not the form: with unsaved edits the
    // owner would publish something other than what they see.
    if (busy || unsaved) return;
    setFormError(null);
    setFailedRun(null);
    const {
      title: t,
      accentColor: a,
      position: p,
      allowExpand: x,
      builtins: b,
      actionOriginsText: ao,
    } = latestRef.current;
    const snapshot = {
      assistantId,
      fields: {
        title: t,
        accentColor: a,
        position: p,
        allowExpand: x,
        builtins: b,
        actionOriginsText: ao,
      },
    };
    try {
      await mutation.run("publishing", async () => {
        const res = await publishAssistant(assistantId, force, runId, confirmed);
        publishSnapshotRef.current = snapshot;
        ignoreNextTickRef.current = true;
        toast.success(`Published (${formatDateTime(res.version.publishedAt ?? Date.now())}).`);
        setHistoryTick((n) => n + 1);
        draftRes.reload();
      });
    } catch (err) {
      if (err instanceof DraftChangedError) {
        // Another save got there first: show what will change now.
        setFailedRun(null);
        confirmation.reopen(err.message);
      } else if (err instanceof FailedTestsError) {
        setFailedRun(err.run);
      } else {
        setFormError(err instanceof ApiError ? err.message : "Could not publish.");
      }
    }
  }

  const originsError = findPrefixedError(fieldErrors, "allowedOrigins");
  const actionOriginsError = findPrefixedError(fieldErrors, "actions.allowedOrigins");

  const contrast = contrastRatio(accentColor, "#ffffff");
  const lowContrast = contrast !== null && contrast < MIN_TEXT_CONTRAST;
  const showOriginProblems = checkedOrigins || originsChanged;
  const showActionOriginProblems = checkedOrigins || actionsChanged;

  return (
    <div className="screen screen-wide">
      <PageHeader
        title="Widget"
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
              aria-describedby={unsaved ? "widget-publish-hint" : undefined}
              onClick={() => confirmation.open()}
            >
              {publishing ? "Publishing…" : "Publish"}
            </button>
          </>
        }
      />
      {unsaved && !busy && (
        <p id="widget-publish-hint" className="field-hint">
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

      <div className="widget-layout">
        <form className="stack form-groups" onSubmit={handleSave}>
          <section className="field-group" aria-labelledby="widget-look-heading">
            <div className="field-group-text">
              <h2 id="widget-look-heading" className="section-heading">
                Look
              </h2>
              <p className="field-hint">The preview shows each change as you make it.</p>
            </div>
            <div className="stack">
              <div className="field">
                <label htmlFor="widget-title">Title</label>
                <input
                  id="widget-title"
                  type="text"
                  value={title}
                  aria-describedby="widget-title-count"
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={saving}
                />
                <CharCount id="widget-title-count" value={title} max={CONFIG_LIMITS.title} />
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
                    type="color"
                    className="color-picker"
                    aria-label="Pick accent colour"
                    value={HEX_COLOUR.test(accentColor) ? accentColor.toLowerCase() : "#2563eb"}
                    onChange={(e) => setAccentColor(e.target.value)}
                    disabled={saving}
                  />
                  <input
                    id="widget-accent"
                    type="text"
                    value={accentColor}
                    onChange={(e) => setAccentColor(e.target.value)}
                    placeholder="#2563eb"
                    aria-describedby="widget-accent-hint"
                    spellCheck={false}
                    disabled={saving}
                  />
                </div>
                <span id="widget-accent-hint" className="field-hint">
                  Used for the chat button, links and the visitor's messages, with white text on
                  top.
                </span>
                {lowContrast && (
                  <p className="contrast-warning" role="status">
                    White text on this colour is hard to read (contrast {contrast?.toFixed(1)}:1,
                    aim for at least {MIN_TEXT_CONTRAST}:1). Try a darker shade.
                  </p>
                )}
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
                  <option value="right">Bottom right</option>
                  <option value="left">Bottom left</option>
                </select>
                {fieldErrors["widget.position"] && (
                  <p className="field-error" role="alert">
                    {fieldErrors["widget.position"]}
                  </p>
                )}
              </div>

              <div className="field">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={allowExpand}
                    disabled={saving}
                    aria-describedby="widget-expand-hint"
                    onChange={(e) => setAllowExpand(e.target.checked)}
                  />
                  <span>Allow expanding to a side panel</span>
                </label>
                <span id="widget-expand-hint" className="field-hint">
                  Adds a button to the chat window that opens the chat as a tall column on the same
                  side as the chat button. Your page moves over to make room, so visitors can read
                  it and the chat side by side. On small screens the chat fills the screen instead.
                </span>
                {fieldErrors["widget.allowExpand"] && (
                  <p className="field-error" role="alert">
                    {fieldErrors["widget.allowExpand"]}
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="field-group" aria-labelledby="widget-sites-heading">
            <div className="field-group-text">
              <h2 id="widget-sites-heading" className="section-heading">
                Where it appears
              </h2>
              <p className="field-hint">
                The chat refuses to answer on any website not listed here.
              </p>
            </div>
            <div className="field">
              <label htmlFor="widget-origins">{ORIGINS_LABEL}</label>
              <textarea
                id="widget-origins"
                rows={4}
                value={originsText}
                onChange={(e) => setOriginsText(e.target.value)}
                placeholder="https://www.example.com"
                aria-describedby={
                  showOriginProblems && originProblems.length > 0
                    ? "widget-origins-hint widget-origins-problems"
                    : "widget-origins-hint"
                }
                aria-invalid={showOriginProblems && originProblems.length > 0}
                spellCheck={false}
                disabled={saving}
              />
              <span id="widget-origins-hint" className="field-hint">
                {ORIGINS_HINT}
              </span>
              {showOriginProblems && (
                <LineProblems id="widget-origins-problems" problems={originProblems} />
              )}
              {originsError && (
                <p className="field-error" role="alert">
                  {originsError}
                </p>
              )}
            </div>
          </section>

          <section className="field-group" aria-labelledby="widget-actions-heading">
            <div className="field-group-text">
              <h2 id="widget-actions-heading" className="section-heading">
                Help on the page
              </h2>
              <p className="field-hint">
                When this is on, the assistant can act on the page the visitor is reading, in their
                own browser. It never sends, buys or deletes anything: the visitor always makes the
                final click.
              </p>
            </div>
            <div className="stack">
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
                <ul className="field-hint plain-list">
                  <li>Take a visitor to another page on your site.</li>
                  <li>Point at a button or field and explain it.</li>
                  <li>
                    Fill in form fields you have marked, after the visitor agrees. It never sends,
                    buys or deletes anything.
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
                  aria-describedby={
                    showActionOriginProblems && actionOriginProblems.length > 0
                      ? "action-origins-hint action-origins-problems"
                      : "action-origins-hint"
                  }
                  aria-invalid={showActionOriginProblems && actionOriginProblems.length > 0}
                  spellCheck={false}
                />
                {/* Said explicitly because the screen already has a list of websites that
                    means something else, and confusing the two would widen either the
                    embed list or the navigation list by accident. */}
                <span id="action-origins-hint" className="field-hint">
                  One per line. Your own site is always allowed. This is not the same as the list of
                  sites that may show the chat.
                </span>
                {showActionOriginProblems && (
                  <LineProblems id="action-origins-problems" problems={actionOriginProblems} />
                )}
                {actionOriginsError && (
                  <p className="field-error" role="alert">
                    {actionOriginsError}
                  </p>
                )}
              </div>
            </div>
          </section>

          <div className="actions form-footer">
            <button type="submit" className="btn btn-primary" disabled={!unsaved || busy}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>

        <aside className="widget-preview-column" aria-label="Preview">
          <WidgetPreview config={previewConfig} />
        </aside>
      </div>

      <PublishConfirmDialog {...confirmation.dialogProps} />

      {showHistory && <History assistantId={assistantId} refreshKey={historyTick} />}
    </div>
  );
}
