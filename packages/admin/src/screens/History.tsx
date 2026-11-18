import { type ConfigChange, diffVersionConfigs, summarizeChanges } from "@solvchat/core";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError, postJson } from "../api/client.js";
import type { VersionRow } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { useAssistantMutation } from "../shell/useAssistantMutations.js";
import { Dialog } from "../ui/Dialog.js";
import { DiffList } from "../ui/DiffList.js";
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

/** The engine returns at most this many versions, newest first. */
const HISTORY_LIMIT = 100;

/**
 * The version each row is compared with. A version that was published is
 * compared with the one published before it, so each row says what that
 * publish changed for visitors (a rollback included). The draft is compared
 * with the live version, like Publish. `null`: the first version, nothing to
 * compare with. `undefined`: the one before it is older than the list.
 */
export function previousVersions(
  versions: readonly VersionRow[],
): Map<string, VersionRow | null | undefined> {
  const published = versions
    .map((version, index) => ({ version, index }))
    .filter(({ version }) => version.publishedAt !== null)
    .sort(
      (a, b) => (b.version.publishedAt ?? 0) - (a.version.publishedAt ?? 0) || a.index - b.index,
    )
    .map(({ version }) => version);
  const truncated = versions.length >= HISTORY_LIMIT;
  const live = versions.find((v) => v.state === "published") ?? null;
  const result = new Map<string, VersionRow | null | undefined>();
  published.forEach((version, i) => {
    const before = published[i + 1];
    result.set(version.id, before ?? (truncated ? undefined : null));
  });
  for (const version of versions) {
    if (version.publishedAt === null) result.set(version.id, live);
  }
  return result;
}

interface RowProps {
  version: VersionRow;
  previous: VersionRow | null | undefined;
  restoreDisabled: boolean;
  restoring: boolean;
  onRestore: () => void;
}

function HistoryRow({ version, previous, restoreDisabled, restoring, onRestore }: RowProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const timestamp = version.publishedAt ?? version.createdAt;
  const changes: ConfigChange[] | null = previous
    ? diffVersionConfigs(previous.config, version.config)
    : null;
  const summary =
    changes !== null
      ? summarizeChanges(changes)
      : previous === null
        ? version.state === "draft"
          ? "Not published yet"
          : "First version"
        : null;

  return (
    <li className="history-item">
      <div className="history-row">
        <div className="history-row-text">
          <div className="history-meta">
            <span className={`badge badge-${version.state}`}>{STATE_LABELS[version.state]}</span>
            <span className="history-date">{formatDateTime(timestamp)}</span>
          </div>
          {summary && <p className="history-summary">{summary}</p>}
        </div>
        <div className="history-actions">
          {changes !== null && changes.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((prev) => !prev)}
            >
              {open ? "Hide changes" : "Show changes"}
            </button>
          )}
          {version.state === "archived" && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={restoreDisabled}
              onClick={onRestore}
            >
              {restoring ? "Restoring…" : "Restore"}
            </button>
          )}
        </div>
      </div>
      {open && changes !== null && (
        <div id={panelId} className="history-diff">
          <DiffList changes={changes} />
        </div>
      )}
    </li>
  );
}

interface RestoreDialogProps {
  target: VersionRow | null;
  live: VersionRow | null;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Shows what visitors will see change before an older version is restored. */
function RestoreDialog({ target, live, busy, error, onConfirm, onCancel }: RestoreDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  if (!target) return null;
  const changes = live ? diffVersionConfigs(live.config, target.config) : null;
  return (
    <Dialog
      open
      wide
      title="Restore this version?"
      onClose={onCancel}
      initialFocus={cancelRef}
      dismissDisabled={busy}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onConfirm}>
            {busy ? "Restoring…" : "Restore version"}
          </button>
        </>
      }
    >
      <p className="dialog-text">
        Visitors get the version from {formatDateTime(target.publishedAt ?? target.createdAt)}{" "}
        straight away. Your draft does not change.
      </p>
      <section className="diff-section" aria-labelledby="restore-diff-heading">
        <h3 id="restore-diff-heading" className="diff-section-heading">
          What will change
        </h3>
        {changes === null ? (
          <p className="muted">Nothing is live now, so there is nothing to compare with.</p>
        ) : (
          <DiffList
            changes={changes}
            headingLevel={4}
            emptyText="Nothing changes: this matches the live version."
          />
        )}
      </section>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

export function History({ assistantId, refreshKey = 0, onRestored }: HistoryProps) {
  const { status, value, error, reload } = useResource<{ versions: VersionRow[] }>(
    `/api/admin/assistants/${assistantId}/versions`,
  );
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
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
    setRestoreError(null);
    setActionNotice(null);
    try {
      await mutation.run("restoring", async () => {
        await postJson<{ version: VersionRow }>(
          `/api/admin/assistants/${assistantId}/versions/${versionId}/rollback`,
        );
        setConfirmId(null);
        setActionNotice("Restored earlier version.");
        reload();
        onRestored?.();
      });
    } catch (err) {
      setRestoreError(err instanceof ApiError ? err.message : "Could not restore version.");
    } finally {
      setRestoringId(null);
    }
  }

  const versions = value?.versions ?? [];
  const previous = previousVersions(versions);
  const live = versions.find((v) => v.state === "published") ?? null;
  const target = versions.find((v) => v.id === confirmId) ?? null;

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
      {status === "loading" && !value && <p className="muted">Loading history…</p>}
      {status === "error" && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {value && versions.length === 0 && <p className="muted">No versions yet.</p>}
      {versions.length > 0 && (
        <ul className="history-list">
          {versions.map((version) => (
            <HistoryRow
              key={version.id}
              version={version}
              previous={previous.get(version.id)}
              restoreDisabled={restoringId !== null || mutation.busy}
              restoring={restoringId === version.id}
              onRestore={() => {
                setRestoreError(null);
                setConfirmId(version.id);
              }}
            />
          ))}
        </ul>
      )}
      <RestoreDialog
        target={target}
        live={live}
        busy={restoringId !== null}
        error={restoreError}
        onConfirm={() => target && void handleRollback(target.id)}
        onCancel={() => setConfirmId(null)}
      />
    </section>
  );
}
