import { useEffect, useState } from "react";
import { ApiError, postJson } from "../api/client.js";
import type { VersionRow } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { useAssistantMutation } from "../shell/useAssistantMutations.js";
import { formatDateTime } from "../ui/format.js";

export interface HistoryProps {
  assistantId: string;
  refreshKey?: number;
  onRestored?: () => void;
}

const STATE_LABELS: Record<VersionRow["state"], string> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
};

export function History({ assistantId, refreshKey = 0, onRestored }: HistoryProps) {
  const { status, value, error, reload } = useResource<{ versions: VersionRow[] }>(
    `/api/admin/assistants/${assistantId}/versions`,
  );
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const mutation = useAssistantMutation(assistantId);

  useEffect(() => {
    if (refreshKey > 0) {
      reload();
    }
  }, [refreshKey, reload]);

  async function handleRollback(versionId: string) {
    if (mutation.busy || restoringId !== null) return;
    setRestoringId(versionId);
    setActionError(null);
    setActionNotice(null);
    try {
      await mutation.run("restoring", async () => {
        await postJson<{ version: VersionRow }>(
          `/api/admin/assistants/${assistantId}/versions/${versionId}/rollback`,
        );
        setActionNotice("Restored earlier version.");
        reload();
        onRestored?.();
      });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not restore version.");
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <section className="history-panel" aria-label="Version history">
      <div className="history-header">
        <h2>History</h2>
      </div>
      {actionNotice && (
        <p className="notice-text" role="status">
          {actionNotice}
        </p>
      )}
      {actionError && (
        <p className="error-text" role="alert">
          {actionError}
        </p>
      )}
      {status === "loading" && !value && <p className="muted">Loading history…</p>}
      {status === "error" && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {value && value.versions.length === 0 && <p className="muted">No versions yet.</p>}
      {value && value.versions.length > 0 && (
        <ul className="history-list">
          {value.versions.map((version) => {
            const timestamp = version.publishedAt ?? version.createdAt;
            return (
              <li key={version.id} className="history-item">
                <div className="history-meta">
                  <span className={`badge badge-${version.state}`}>
                    {STATE_LABELS[version.state]}
                  </span>
                  <span className="history-date">{formatDateTime(timestamp)}</span>
                </div>
                {version.state === "archived" && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={restoringId !== null || mutation.busy}
                    onClick={() => handleRollback(version.id)}
                  >
                    {restoringId === version.id ? "Restoring…" : "Restore"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
