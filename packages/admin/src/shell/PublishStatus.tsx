import { useEffect, useRef, useState } from "react";
import { ApiError, putJson } from "../api/client.js";
import {
  type ConfirmedDraft,
  DraftChangedError,
  FailedTestsError,
  publishAssistant,
} from "../api/publish.js";
import type { TestRunSummary, VersionRow } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { FailedTestsPanel } from "../screens/FailedTestsPanel.js";
import { ConfirmDialog, Dialog } from "../ui/Dialog.js";
import { RowMenu } from "../ui/RowMenu.js";
import { StatusBadge, type StatusTone } from "../ui/StatusBadge.js";
import { useToast } from "../ui/Toast.js";
import { PublishConfirmDialog, usePublishConfirmation } from "./PublishConfirm.js";
import { useAssistantMutation } from "./useAssistantMutations.js";

/**
 * `live`: the draft is what visitors get. `changes`: the saved draft differs
 * from the published version. `unpublished`: nothing has been published yet.
 */
export type PublishState = "live" | "changes" | "unpublished";

export const PUBLISH_STATE_LABELS: Record<PublishState, string> = {
  live: "Live",
  changes: "Unpublished changes",
  unpublished: "Not published yet",
};

const PUBLISH_STATE_TONES: Record<PublishState, StatusTone> = {
  live: "success",
  changes: "warning",
  unpublished: "neutral",
};

const PUBLISH_STATE_HINTS: Record<PublishState, string> = {
  live: "Visitors see your latest saved changes.",
  changes: "You saved changes that visitors do not see yet.",
  unpublished: "Visitors cannot use this assistant until you publish it.",
};

/** JSON with sorted object keys, so two equal configs always compare equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface PublishSnapshot {
  state: PublishState;
  draft: VersionRow | null;
  published: VersionRow | null;
}

/** Works out the publish state from the versions list, or null if it is not one. */
export function publishSnapshotOf(value: unknown): PublishSnapshot | null {
  const versions = (value as { versions?: unknown } | undefined)?.versions;
  if (!Array.isArray(versions)) return null;
  const rows = versions as VersionRow[];
  const draft = rows.find((v) => v?.state === "draft") ?? null;
  const published = rows.find((v) => v?.state === "published") ?? null;
  if (!published) return { state: "unpublished", draft, published };
  if (!draft) return { state: "live", draft, published };
  const same = stableJson(draft.config) === stableJson(published.config);
  return { state: same ? "live" : "changes", draft, published };
}

/**
 * The selected assistant's publish state. Reloads whenever `refreshKey`
 * changes (the shell passes the screen and the save/publish counter).
 */
export function usePublishStatus(assistantId: string | null, refreshKey: string) {
  const res = useResource<{ versions: VersionRow[] }>(
    assistantId ? `/api/admin/assistants/${assistantId}/versions` : null,
  );
  const { reload } = res;
  const lastKey = useRef(refreshKey);
  useEffect(() => {
    if (lastKey.current === refreshKey) return;
    lastKey.current = refreshKey;
    reload();
  }, [refreshKey, reload]);
  return { snapshot: publishSnapshotOf(res.value), reload };
}

export interface PublishStatusBadgeProps {
  state: PublishState;
}

export function PublishStatusBadge({ state }: PublishStatusBadgeProps) {
  return (
    <StatusBadge tone={PUBLISH_STATE_TONES[state]} title={PUBLISH_STATE_HINTS[state]}>
      {PUBLISH_STATE_LABELS[state]}
    </StatusBadge>
  );
}

export interface PublishControlsProps {
  assistantId: string;
  /** Current screen id; Publish and Discard are offered on Build screens. */
  showActions: boolean;
  /** Changes whenever the status may be stale (screen changes, saves). */
  refreshKey: string;
}

/**
 * "Live" / "Unpublished changes" / "Not published yet", with Publish (tests
 * run first, as on the screens) and "Discard changes" on Build screens.
 */
export function PublishControls({ assistantId, showActions, refreshKey }: PublishControlsProps) {
  const mutation = useAssistantMutation(assistantId);
  const { snapshot, reload } = usePublishStatus(assistantId, `${refreshKey}:${mutation.tick}`);
  const toast = useToast();
  const [failedRun, setFailedRun] = useState<TestRunSummary | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const confirmation = usePublishConfirmation(assistantId, (confirmed) => {
    void handlePublish(false, undefined, confirmed);
  });
  const [discardError, setDiscardError] = useState<string | null>(null);

  if (!snapshot) return null;
  const { state, draft, published } = snapshot;
  // Publishing sends the saved draft, so edits still open on the screen would
  // be left out; the owner saves them first, as the screen's own Publish asks.
  const { unsaved } = mutation;
  const canPublish = state !== "live" && !mutation.busy && !unsaved;

  async function handlePublish(
    force = false,
    runId?: string,
    confirmed: ConfirmedDraft | undefined = confirmation.confirmed(),
  ) {
    if (mutation.busy || mutation.unsaved) return;
    try {
      const result = await mutation.run("publishing", () =>
        publishAssistant(assistantId, force, runId, confirmed),
      );
      if (!result.ran) return;
      setFailedRun(null);
      toast.success("Published. Visitors now get this version.");
      reload();
    } catch (err) {
      if (err instanceof DraftChangedError) {
        // Another save got there first: show what will change now.
        setFailedRun(null);
        confirmation.reopen(err.message);
      } else if (err instanceof FailedTestsError) {
        setFailedRun(err.run);
      } else {
        setFailedRun(null);
        toast.error(err instanceof ApiError ? err.message : "Could not publish. Try again.");
      }
    }
  }

  async function handleDiscard() {
    if (mutation.busy || !published) return;
    setDiscardError(null);
    try {
      // Saving the published config as the draft; screens reload on a "saving" mutation.
      const result = await mutation.run("saving", () =>
        putJson<{ draft: VersionRow }>(`/api/admin/assistants/${assistantId}/draft`, {
          ...published.config,
          pageToolServers:
            published.config.pageToolServers ??
            (draft?.config.pageToolServers?.length ? [] : undefined),
        }),
      );
      if (!result.ran) return;
      setConfirmDiscard(false);
      toast.success("Changes discarded. Your draft matches the live version again.");
      reload();
    } catch (err) {
      setDiscardError(err instanceof ApiError ? err.message : "Could not discard changes.");
    }
  }

  return (
    <div className="publish-status">
      <span className="sr-only">Publish status:</span>
      <PublishStatusBadge state={state} />
      {showActions && (
        <div className="publish-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!canPublish}
            title={
              unsaved
                ? "Save your changes before publishing."
                : state === "live"
                  ? "Nothing new to publish."
                  : "Shows what will change, runs your tests, then publishes."
            }
            onClick={() => confirmation.open()}
          >
            {mutation.publishing ? "Publishing…" : "Publish draft"}
          </button>
          <RowMenu
            label="More publish options"
            items={[
              {
                label: "Discard changes",
                tone: "danger",
                disabled: state !== "changes" || mutation.busy,
                onSelect: () => {
                  setDiscardError(null);
                  setConfirmDiscard(true);
                },
              },
            ]}
          />
        </div>
      )}

      <PublishConfirmDialog {...confirmation.dialogProps} />

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard unpublished changes?"
        description="Your draft goes back to the version visitors get now. Saved changes you have not published are lost."
        confirmLabel="Discard changes"
        busyLabel="Discarding…"
        tone="danger"
        busy={mutation.saving}
        error={discardError}
        onConfirm={() => void handleDiscard()}
        onCancel={() => setConfirmDiscard(false)}
      />

      <Dialog
        open={failedRun !== null}
        title="Not published"
        onClose={() => setFailedRun(null)}
        dismissDisabled={mutation.publishing}
      >
        {failedRun && (
          <FailedTestsPanel
            run={failedRun}
            busy={mutation.busy}
            publishBlocked={unsaved}
            onFix={() => setFailedRun(null)}
            onPublishAnyway={() => void handlePublish(true, failedRun.id)}
          />
        )}
      </Dialog>
    </div>
  );
}
