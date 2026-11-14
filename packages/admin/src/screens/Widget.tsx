import type { WidgetConfig, WidgetPosition } from "@solvchat/core";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, patchJson, postJson, putJson } from "../api/client.js";
import type { Assistant, VersionRow } from "../api/types.js";
import { useResource } from "../api/useResource.js";
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

function findOriginsError(fields: Record<string, string>): string | undefined {
  if (fields.allowedOrigins) return fields.allowedOrigins;
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("allowedOrigins[")) return value;
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

  const [title, setTitle] = useState("");
  const [accentColor, setAccentColor] = useState("#2563eb");
  const [position, setPosition] = useState<WidgetPosition>("right");
  const [originsText, setOriginsText] = useState("");
  const [initWidgetKey, setInitWidgetKey] = useState<string | null>(null);
  const [initOriginsKey, setInitOriginsKey] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!savedWidget) return;
    const key = `${assistantId}:${draftRes.value?.draft.id ?? ""}`;
    if (initWidgetKey !== key) {
      setTitle(savedWidget.title);
      setAccentColor(savedWidget.accentColor);
      setPosition(savedWidget.position);
      setInitWidgetKey(key);
    }
  }, [assistantId, draftRes.value?.draft.id, initWidgetKey, savedWidget]);

  useEffect(() => {
    if (!savedAssistant) return;
    const key = `${assistantId}:${savedAssistant.allowedOrigins.join("\n")}`;
    if (initOriginsKey !== key) {
      setOriginsText(savedAssistant.allowedOrigins.join("\n"));
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
  if (!savedWidget || !savedAssistant) {
    return null;
  }

  const currentWidget: WidgetConfig = { title, accentColor, position };
  const currentOrigins = parseOrigins(originsText);
  const widgetChanged = initWidgetKey !== null && !widgetEqual(currentWidget, savedWidget);
  const originsChanged =
    initOriginsKey !== null && !arraysEqual(currentOrigins, savedAssistant.allowedOrigins);
  const unsaved = widgetChanged || originsChanged;

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!savedAssistant) return;

    setSaving(true);
    setFieldErrors({});
    setFormError(null);
    setStatusMessage(null);

    const nextFieldErrors: Record<string, string> = {};
    let generalError: string | null = null;

    if (originsChanged) {
      try {
        const res = await patchJson<{ assistant: Assistant }>(
          `/api/admin/assistants/${assistantId}`,
          { name: savedAssistant.name, allowedOrigins: currentOrigins },
        );
        assistantRes.setValue(res);
        setOriginsText(res.assistant.allowedOrigins.join("\n"));
      } catch (err) {
        if (err instanceof ApiError) {
          Object.assign(nextFieldErrors, err.fields);
          if (Object.keys(err.fields).length === 0) generalError = err.message;
        } else {
          generalError = "Could not save allowed origins.";
        }
      }
    }

    if (widgetChanged) {
      try {
        const res = await putJson<{ draft: VersionRow }>(
          `/api/admin/assistants/${assistantId}/draft`,
          { widget: currentWidget },
        );
        draftRes.setValue(res);
        setTitle(res.draft.config.widget.title);
        setAccentColor(res.draft.config.widget.accentColor);
        setPosition(res.draft.config.widget.position);
      } catch (err) {
        if (err instanceof ApiError) {
          Object.assign(nextFieldErrors, err.fields);
          if (Object.keys(err.fields).length === 0) generalError = err.message;
        } else {
          generalError = "Could not save widget settings.";
        }
      }
    }

    if (Object.keys(nextFieldErrors).length > 0 || generalError !== null) {
      setFieldErrors(nextFieldErrors);
      setFormError(generalError);
    } else {
      setStatusMessage("Draft saved.");
    }

    setSaving(false);
  }

  async function handlePublish() {
    setPublishing(true);
    setFormError(null);
    setStatusMessage(null);
    try {
      const res = await postJson<{ version: VersionRow }>(
        `/api/admin/assistants/${assistantId}/publish`,
      );
      setStatusMessage(
        `Published (${new Date(res.version.publishedAt ?? Date.now()).toLocaleString()}).`,
      );
      setHistoryTick((n) => n + 1);
      draftRes.reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not publish.");
    } finally {
      setPublishing(false);
    }
  }

  const originsError = findOriginsError(fieldErrors);

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
            disabled={publishing}
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
          <label htmlFor="widget-title">Title</label>
          <input
            id="widget-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
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
            />
            <span
              className="color-swatch"
              style={{
                backgroundColor: /^#[0-9a-fA-F]{6}$/.test(accentColor)
                  ? accentColor
                  : "#transparent",
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
          />
          <span className="field-hint">Websites allowed to embed this widget, one per line.</span>
          {originsError && (
            <p className="field-error" role="alert">
              {originsError}
            </p>
          )}
        </div>

        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={!unsaved || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>

      {showHistory && <History assistantId={assistantId} refreshKey={historyTick} />}
    </div>
  );
}
