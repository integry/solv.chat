import { type FormEvent, useState } from "react";
import { ApiError, deleteJson, postJson } from "../api/client.js";
import { useResource } from "../api/useResource.js";
import { CopyButton } from "../ui/CopyButton.js";
import { RelativeTime } from "../ui/DateText.js";
import { ConfirmDialog } from "../ui/Dialog.js";
import { ErrorState } from "../ui/ErrorState.js";
import { PageHeader } from "../ui/PageHeader.js";
import { Skeleton } from "../ui/Skeleton.js";
import { StatusBadge } from "../ui/StatusBadge.js";

const ACCESS_PATH = "/api/admin/operator-tokens";
type Scope = "read" | "full";
interface Access {
  id: string;
  name: string;
  scope: Scope;
  kind: "token" | "connection";
  lastUsedAt: number | null;
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="operator-copy-field">
      <strong>{label}</strong>
      <CopyButton value={value} ariaLabel={`Copy ${label}`} />
      <code>{value}</code>
    </div>
  );
}

export function OperatorAccess({ manage }: { manage: boolean }) {
  const endpoint = `${window.location.origin}/mcp`;
  // https://code.claude.com/docs/en/mcp#option-1-add-a-remote-http-server
  const claude = `claude mcp add --transport http solv-chat '${endpoint}'`;

  return (
    <div className="screen operator-screen">
      <PageHeader
        title="MCP access"
        description="Connect a client to manage solv.chat or review its activity."
      />
      <section className="card operator-card" aria-labelledby="mcp-connect">
        <h2 id="mcp-connect">Connect an MCP client</h2>
        <p className="muted">
          Use the connection URL in Claude Desktop or claude.ai, or run the command in Claude Code.
          Sign in with your admin password and review the access request.
        </p>
        <CopyField label="Connector URL" value={endpoint} />
        <CopyField label="Claude Code command" value={claude} />
      </section>
      {manage && <OperatorTokenManagement />}
    </div>
  );
}

function OperatorTokenManagement() {
  const access = useResource<{ access: Access[] }>(ACCESS_PATH);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("read");
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Access | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  async function createToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await postJson<{ token: string }>(ACCESS_PATH, { name, scope });
      setIssuedToken(result.token);
      setName("");
      access.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the token.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    setRevokeError(null);
    try {
      await deleteJson(`${ACCESS_PATH}/${encodeURIComponent(revoking.id)}`);
      setRevoking(null);
      setIssuedToken(null);
      access.reload();
    } catch (err) {
      setRevokeError(err instanceof ApiError ? err.message : "Could not revoke access.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card operator-card" aria-labelledby="mcp-personal-tokens">
        <h2 id="mcp-personal-tokens">Personal access tokens</h2>
        <p className="muted">
          Use a token for scripts or clients that send an Authorization header. Choose Read only
          when you just need to review activity.
        </p>
        <form className="field operator-token-form" onSubmit={(event) => void createToken(event)}>
          <label htmlFor="operator-token-name">Token name</label>
          <input
            id="operator-token-name"
            type="text"
            required
            maxLength={80}
            value={name}
            placeholder="For example, Activity reports"
            onChange={(event) => setName(event.target.value)}
          />
          <label htmlFor="operator-token-scope">Access</label>
          <select
            className="select"
            id="operator-token-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value === "full" ? "full" : "read")}
          >
            <option value="read">Read only</option>
            <option value="full">Full access</option>
          </select>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || !name.trim() || access.status === "error" || issuedToken !== null}
          >
            Create token
          </button>
        </form>
        {issuedToken && (
          <div className="operator-issued" role="status" aria-label="New personal access token">
            <p>Copy this token now. This is the only time it will be shown.</p>
            <CopyField label="Personal access token" value={issuedToken} />
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => setIssuedToken(null)}
            >
              Done
            </button>
          </div>
        )}
      </section>

      <section className="card operator-card" aria-labelledby="mcp-active">
        <h2 id="mcp-active">Active access</h2>
        {access.status === "loading" && access.value === undefined && (
          <Skeleton label="Loading access…" lines={2} />
        )}
        {access.error && (
          <ErrorState
            title="Could not load access."
            detail={access.error}
            onRetry={access.reload}
          />
        )}
        {access.value?.access.length === 0 && (
          <p className="muted">No tokens or connected clients yet.</p>
        )}
        {access.value && access.value.access.length > 0 && (
          <ul className="operator-list">
            {access.value.access.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <div className="muted operator-list-meta">
                    {item.kind === "token" ? "Personal token" : "Connected client"}
                    {" · "}
                    {item.lastUsedAt === null ? (
                      "Never used"
                    ) : (
                      <>
                        Last used <RelativeTime value={item.lastUsedAt} />
                      </>
                    )}
                  </div>
                </div>
                <StatusBadge tone={item.scope === "read" ? "info" : "warning"}>
                  {item.scope === "read" ? "Read only" : "Full access"}
                </StatusBadge>
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  aria-label={`Revoke ${item.name}`}
                  onClick={() => setRevoking(item)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke ${revoking?.name ?? "access"}?`}
        description="This connection and any tokens it created will stop working immediately."
        confirmLabel="Revoke access"
        tone="danger"
        busy={busy}
        error={revokeError}
        onConfirm={() => void revoke()}
        onCancel={() => {
          setRevoking(null);
          setRevokeError(null);
        }}
      />
    </>
  );
}
