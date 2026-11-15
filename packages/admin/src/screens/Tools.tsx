import { type FormEvent, useState } from "react";
import { ApiError, deleteJson, patchJson, postJson } from "../api/client.js";
import type { McpServerSummary, McpToolView } from "../api/types.js";
import { useResource } from "../api/useResource.js";

export interface ToolsProps {
  assistantId: string;
}

/**
 * The standing warning. Not dismissible and not behind a disclosure: what it
 * says stays true for as long as a tool is on, and the specification calls for
 * a standing warning for exactly that reason.
 */
function CredentialWarning() {
  return (
    <p className="warning-banner" role="note">
      Anyone who chats with your assistant can make it use these tools, and every tool runs with the
      credential you give here. Use a token that can only read, never one that can change, buy or
      delete anything.
    </p>
  );
}

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p className="field-error" role="alert">
      {message}
    </p>
  );
}

interface CredentialFieldsProps {
  idPrefix: string;
  needsCredential: boolean;
  onNeedsCredentialChange: (next: boolean) => void;
  headerName: string;
  onHeaderNameChange: (next: string) => void;
  headerValue: string;
  onHeaderValueChange: (next: string) => void;
  busy: boolean;
  fieldErrors: Record<string, string>;
  hasExistingSecret?: boolean;
}

function CredentialFields({
  idPrefix,
  needsCredential,
  onNeedsCredentialChange,
  headerName,
  onHeaderNameChange,
  headerValue,
  onHeaderValueChange,
  busy,
  fieldErrors,
  hasExistingSecret = false,
}: CredentialFieldsProps) {
  const headerNameId = `${idPrefix}-header-name`;
  const headerValueId = `${idPrefix}-header-value`;

  return (
    <>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={needsCredential}
          disabled={busy}
          onChange={(e) => onNeedsCredentialChange(e.target.checked)}
        />
        <span>This server needs a key</span>
      </label>

      {needsCredential && (
        <>
          <div className="field">
            <label htmlFor={headerNameId}>Header name</label>
            <input
              id={headerNameId}
              type="text"
              value={headerName}
              disabled={busy}
              onChange={(e) => onHeaderNameChange(e.target.value)}
            />
            <FieldError message={fieldErrors.headerName} />
          </div>
          <div className="field">
            <label htmlFor={headerValueId}>{hasExistingSecret ? "New key" : "Key"}</label>
            {/* A password field, never populated from the server: the API does
                not return the value, and there is nothing to show back. */}
            <input
              id={headerValueId}
              type="password"
              autoComplete="off"
              value={headerValue}
              disabled={busy}
              placeholder={hasExistingSecret ? "Leave blank to keep the current key" : undefined}
              onChange={(e) => onHeaderValueChange(e.target.value)}
            />
            <span className="field-hint">
              Stored encrypted. It is never shown again, so keep your own copy.
            </span>
            <FieldError message={fieldErrors.headerValue} />
          </div>
        </>
      )}
    </>
  );
}

function ServerForm({
  assistantId,
  onAdded,
}: {
  assistantId: string;
  onAdded: (refreshError?: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [needsCredential, setNeedsCredential] = useState(false);
  const [headerName, setHeaderName] = useState("Authorization");
  const [headerValue, setHeaderValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFieldErrors({});
    setFormError(null);
    // Read once and drop from state immediately: after this the value exists
    // only in the request, so no later render can put it back into the DOM.
    const submittedValue = headerValue;
    setHeaderValue("");
    try {
      const res = await postJson<{ server: McpServerSummary; refreshError?: string }>(
        `/api/admin/assistants/${assistantId}/mcp-servers`,
        {
          label,
          url,
          authKind: needsCredential ? "static_header" : "none",
          ...(needsCredential ? { headerName, headerValue: submittedValue } : {}),
        },
      );
      setLabel("");
      setUrl("");
      setNeedsCredential(false);
      setHeaderName("Authorization");
      onAdded(res.refreshError);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fields);
        if (Object.keys(err.fields).length === 0) setFormError(err.message);
      } else {
        setFormError("Could not add that server. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="source-card stack" onSubmit={handleSubmit}>
      <h2 className="section-heading">Add a tool server</h2>

      <div className="field">
        <label htmlFor="tool-label">What this is</label>
        <input
          id="tool-label"
          type="text"
          value={label}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Order lookup"
        />
        <FieldError message={fieldErrors.label} />
      </div>

      <div className="field">
        <label htmlFor="tool-url">Address</label>
        <input
          id="tool-url"
          type="url"
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://tools.example.com/mcp"
        />
        <span className="field-hint">Must start with https.</span>
        <FieldError message={fieldErrors.url} />
      </div>

      <CredentialFields
        idPrefix="tool"
        needsCredential={needsCredential}
        onNeedsCredentialChange={setNeedsCredential}
        headerName={headerName}
        onHeaderNameChange={setHeaderName}
        headerValue={headerValue}
        onHeaderValueChange={setHeaderValue}
        busy={busy}
        fieldErrors={fieldErrors}
      />

      {formError && (
        <p className="error-text" role="alert">
          {formError}
        </p>
      )}

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !label || !url}>
          {busy ? "Adding…" : "Add server"}
        </button>
      </div>
    </form>
  );
}

function EditServerForm({
  server,
  onSaved,
  onCancel,
}: {
  server: McpServerSummary;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(server.label);
  const [url, setUrl] = useState(server.url);
  const [enabled, setEnabled] = useState(server.enabled);
  const [needsCredential, setNeedsCredential] = useState(server.authKind === "static_header");
  const [headerName, setHeaderName] = useState(server.headerName ?? "Authorization");
  const [headerValue, setHeaderValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFieldErrors({});
    setFormError(null);
    const submittedValue = headerValue;
    setHeaderValue("");
    try {
      await patchJson(`/api/admin/mcp-servers/${server.id}`, {
        label,
        url,
        enabled,
        authKind: needsCredential ? "static_header" : "none",
        ...(needsCredential
          ? { headerName, ...(submittedValue !== "" ? { headerValue: submittedValue } : {}) }
          : { headerValue: "" }),
      });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fields);
        if (Object.keys(err.fields).length === 0) setFormError(err.message);
      } else {
        setFormError("Could not save that server. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveCredential() {
    if (busy) return;
    setBusy(true);
    setFieldErrors({});
    setFormError(null);
    setHeaderValue("");
    try {
      await patchJson(`/api/admin/mcp-servers/${server.id}`, { headerValue: "" });
      onSaved();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not remove the key.");
    } finally {
      setBusy(false);
    }
  }

  const editPrefix = `edit-${server.id}`;

  return (
    <form className="switcher-form" onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor={`${editPrefix}-label`}>What this is</label>
        <input
          id={`${editPrefix}-label`}
          type="text"
          value={label}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
        />
        <FieldError message={fieldErrors.label} />
      </div>

      <div className="field">
        <label htmlFor={`${editPrefix}-url`}>Address</label>
        <input
          id={`${editPrefix}-url`}
          type="url"
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
        />
        <FieldError message={fieldErrors.url} />
      </div>

      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Enabled</span>
      </label>

      <CredentialFields
        idPrefix={editPrefix}
        needsCredential={needsCredential}
        onNeedsCredentialChange={setNeedsCredential}
        headerName={headerName}
        onHeaderNameChange={setHeaderName}
        headerValue={headerValue}
        onHeaderValueChange={setHeaderValue}
        busy={busy}
        fieldErrors={fieldErrors}
        hasExistingSecret={server.hasSecret}
      />

      {formError && (
        <p className="error-text" role="alert">
          {formError}
        </p>
      )}

      <div className="actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !label || !url}>
          {busy ? "Saving…" : "Save"}
        </button>
        {server.hasSecret && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => void handleRemoveCredential()}
          >
            Remove credential
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ToolList({
  server,
  refreshVersion,
  onChanged,
}: {
  server: McpServerSummary;
  refreshVersion: number;
  onChanged: () => void;
}) {
  const toolsRes = useResource<{ tools: McpToolView[] }>(
    `/api/admin/mcp-servers/${server.id}/tools?v=${refreshVersion}`,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  async function toggle(tool: McpToolView) {
    if (busyId !== null) return;
    setBusyId(tool.id);
    setError(null);
    try {
      await patchJson(`/api/admin/mcp-servers/${server.id}/tools/${tool.id}`, {
        allowed: !tool.allowed,
      });
      // The chat path requires the tool name in the published version too, so
      // a switch alone does not reach visitors. Saying so here is the
      // difference between "it works" and "it looks broken".
      setChanged(true);
      toolsRes.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change that tool.");
    } finally {
      setBusyId(null);
    }
  }

  const tools = toolsRes.value?.tools ?? [];
  return (
    <div className="source-docs stack">
      <p className="field-hint">
        Tools are off by default. Switch one on to let your assistant call it when a visitor asks.
      </p>
      {toolsRes.status === "loading" && tools.length === 0 ? (
        <p className="muted">Loading tools…</p>
      ) : toolsRes.status === "error" ? (
        <p className="error-text" role="alert">
          {toolsRes.error}
        </p>
      ) : tools.length === 0 ? (
        <p className="muted">This server offered no tools. Check the address and press Refresh.</p>
      ) : (
        <ul className="source-doc-list">
          {tools.map((tool) => (
            <li key={tool.id} className="source-doc-item">
              <div>
                <div className="source-doc-title">{tool.name}</div>
                <div className="muted">{tool.description || "No description given."}</div>
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={tool.allowed}
                  disabled={busyId !== null}
                  onChange={() => void toggle(tool)}
                />
                <span>{tool.allowed ? "Visitors can use this" : "Off"}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {changed && (
        <p className="field-hint" role="status">
          This change takes effect on Publish. Press Publish on Behaviour or Widget to let visitors
          use what you changed.
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Tools({ assistantId }: ToolsProps) {
  const serversRes = useResource<{ servers: McpServerSummary[] }>(
    `/api/admin/assistants/${assistantId}/mcp-servers`,
  );
  const servers = serversRes.value?.servers ?? [];
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshCounts, setRefreshCounts] = useState<Record<string, number>>({});

  async function refresh(serverId: string) {
    if (busyId !== null) return;
    setBusyId(serverId);
    setActionError(null);
    try {
      await postJson(`/api/admin/mcp-servers/${serverId}/refresh`);
      setRefreshCounts((prev) => ({ ...prev, [serverId]: (prev[serverId] ?? 0) + 1 }));
      serversRes.reload();
    } catch (err) {
      // A 502 here means the owner's server failed, not this app; the engine's
      // message is already written for a person.
      setActionError(err instanceof ApiError ? err.message : "Could not reach that server.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(serverId: string) {
    if (busyId !== null) return;
    setBusyId(serverId);
    setActionError(null);
    try {
      await deleteJson(`/api/admin/mcp-servers/${serverId}`);
      if (expandedId === serverId) setExpandedId(null);
      if (editingId === serverId) setEditingId(null);
      setConfirmDeleteId(null);
      serversRes.reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not delete that server.");
    } finally {
      setBusyId(null);
    }
  }

  if (serversRes.status === "loading" && !serversRes.value) {
    return <p className="muted">Loading tools…</p>;
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <div>
          <h1>Tools</h1>
          <p className="muted">
            Connect an external tool server (MCP) so your assistant can look things up in your own
            systems while it answers.
          </p>
        </div>
      </div>

      <CredentialWarning />

      {actionError && (
        <p className="error-text" role="alert">
          {actionError}
        </p>
      )}

      {serversRes.status === "error" ? (
        <p className="error-text" role="alert">
          {serversRes.error}
        </p>
      ) : servers.length === 0 ? (
        <p className="muted">No tool servers yet. Add one below to get started.</p>
      ) : (
        <ul className="source-list">
          {servers.map((server) => (
            <li key={server.id} className="source-card stack">
              <div className="source-row-header">
                <div>
                  <div className="source-label">{server.label}</div>
                  <div className="muted">{server.url}</div>
                  <div className="source-meta">
                    <span className="badge">
                      {server.hasSecret ? "Credential: set" : "Credential: not set"}
                    </span>
                    <span className={server.enabled ? "badge badge-published" : "badge"}>
                      {server.enabled ? "Enabled" : "Disabled"}
                    </span>
                    <span>
                      {server.allowedCount} of {server.toolCount} tools on
                    </span>
                  </div>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setExpandedId(expandedId === server.id ? null : server.id)}
                  >
                    {expandedId === server.id ? "Hide tools" : "View tools"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busyId === server.id}
                    onClick={() => void refresh(server.id)}
                  >
                    {busyId === server.id ? "Refreshing…" : "Refresh"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busyId === server.id}
                    onClick={() => {
                      setConfirmDeleteId(null);
                      setEditingId(editingId === server.id ? null : server.id);
                    }}
                  >
                    {editingId === server.id ? "Close edit" : "Edit"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busyId === server.id}
                    onClick={() => {
                      setEditingId(null);
                      setConfirmDeleteId(confirmDeleteId === server.id ? null : server.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>

              {confirmDeleteId === server.id && (
                <section className="switcher-form" aria-label="Confirm delete">
                  <p className="muted">Remove this server and its tools?</p>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busyId === server.id}
                      onClick={() => void remove(server.id)}
                    >
                      {busyId === server.id ? "Deleting…" : "Confirm delete"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busyId === server.id}
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </section>
              )}

              {editingId === server.id && (
                <EditServerForm
                  server={server}
                  onSaved={() => {
                    setEditingId(null);
                    serversRes.reload();
                  }}
                  onCancel={() => setEditingId(null)}
                />
              )}

              {expandedId === server.id && (
                <ToolList
                  server={server}
                  refreshVersion={refreshCounts[server.id] ?? 0}
                  onChanged={() => serversRes.reload()}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <ServerForm
        assistantId={assistantId}
        onAdded={(refreshError) => {
          setActionError(refreshError ?? null);
          serversRes.reload();
        }}
      />
    </div>
  );
}
