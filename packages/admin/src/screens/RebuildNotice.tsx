import { useState } from "react";
import { ApiError, postJson } from "../api/client.js";
import { useResource } from "../api/useResource.js";
import { ConfirmDialog } from "../ui/Dialog.js";
import { useToast } from "../ui/Toast.js";

interface ReindexStatus {
  outdated: number;
}

interface ReindexResult {
  queued: number;
  remaining: number;
}

const items = (n: number) => (n === 1 ? "1 item" : `${n.toLocaleString()} items`);

/**
 * Offers to rebuild content that was made searchable the old way (before
 * page menus, footers and tiny pieces were left out). Shown on Sources only
 * while there is such content. Nothing is fetched: stored text is cut up
 * and made searchable again, at about the cost of adding it.
 */
export function RebuildNotice({
  assistantId,
  onRebuilt,
}: {
  assistantId: string;
  onRebuilt?: (() => void) | undefined;
}) {
  const toast = useToast();
  const status = useResource<ReindexStatus>(`/api/admin/assistants/${assistantId}/reindex`);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outdated = status.value?.outdated ?? 0;
  if (outdated === 0) return null;

  async function rebuild() {
    setBusy(true);
    setError(null);
    try {
      const res = await postJson<ReindexResult>(`/api/admin/assistants/${assistantId}/reindex`);
      toast.success(
        res.remaining > 0
          ? `Rebuilding ${items(res.queued)}. Press Rebuild again for the other ${items(res.remaining)} once these are done.`
          : `Rebuilding ${items(res.queued)}. Answers use the new version as each one is ready.`,
      );
      setConfirming(false);
      status.reload();
      onRebuilt?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the rebuild. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="notice notice-info rebuild-notice" role="status">
        <p>
          {items(outdated)} of your content {outdated === 1 ? "was" : "were"} made searchable the
          old way, which can let menus, footers and link lists crowd out real answers. Rebuild to
          use the new way.
        </p>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          Rebuild
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Rebuild your content?"
        description={
          <>
            Your saved text is cut up and made searchable again, so this costs about what adding it
            did. Answers keep working meanwhile. Pages from a sitemap keep the text they were saved
            with; a scheduled sync reads them again once.
          </>
        }
        confirmLabel="Rebuild"
        busyLabel="Starting…"
        busy={busy}
        error={error}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void rebuild()}
      />
    </>
  );
}
