import { diffVersionConfigs } from "@solvchat/core";
import { useRef, useState } from "react";
import type { ConfirmedDraft } from "../api/publish.js";
import type { VersionRow } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { Dialog } from "../ui/Dialog.js";
import { DiffList } from "../ui/DiffList.js";

export interface PublishConfirmDialogProps {
  assistantId: string;
  open: boolean;
  /** Called with the draft that was shown, which is the only one publish may send. */
  onConfirm: (confirmed: ConfirmedDraft) => void;
  onCancel: () => void;
  /** Said above the comparison, such as why it is being shown again. */
  notice?: string | null | undefined;
}

/**
 * Asks before publishing, with "What will change": the saved draft compared
 * with the published version. Read fresh each time it opens. Confirming hands
 * back that draft's id and revision, and the server publishes only that
 * draft: one saved since (in another tab, say) is refused, and the comparison
 * is shown again. Nothing changed leaves Publish disabled.
 */
export function PublishConfirmDialog(props: PublishConfirmDialogProps) {
  if (!props.open) return null;
  return <PublishConfirmBody {...props} />;
}

function PublishConfirmBody({
  assistantId,
  onConfirm,
  onCancel,
  notice,
}: PublishConfirmDialogProps) {
  // The draft comes from its own endpoint, the one Publish sends: never from
  // History, which is bounded. The engine always includes the live version in
  // the versions list, however long History has grown.
  const draftRes = useResource<{ draft: VersionRow; revision: string }>(
    `/api/admin/assistants/${assistantId}/draft`,
  );
  const versionsRes = useResource<{ versions: VersionRow[] }>(
    `/api/admin/assistants/${assistantId}/versions`,
  );
  const cancelRef = useRef<HTMLButtonElement>(null);
  const status =
    draftRes.status === "error" || versionsRes.status === "error"
      ? "error"
      : draftRes.status === "ready" && versionsRes.status === "ready"
        ? "ready"
        : "loading";
  const error = draftRes.error ?? versionsRes.error;
  const ready = status === "ready";
  const draft = ready ? (draftRes.value?.draft ?? null) : null;
  const revision = ready ? (draftRes.value?.revision ?? null) : null;
  const published = ready
    ? (versionsRes.value?.versions.find((v) => v.state === "published") ?? null)
    : null;
  const changes = draft && published ? diffVersionConfigs(published.config, draft.config) : null;
  const firstPublish = ready && draft !== null && published === null;
  const canPublish =
    draft !== null &&
    revision !== null &&
    (firstPublish || (changes !== null && changes.length > 0));

  return (
    <Dialog
      open
      wide
      title="Publish your draft?"
      onClose={onCancel}
      initialFocus={cancelRef}
      footer={
        <>
          <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canPublish}
            onClick={() => {
              if (draft !== null && revision !== null) onConfirm({ draftId: draft.id, revision });
            }}
          >
            Publish now
          </button>
        </>
      }
    >
      {notice && (
        <p className="error-text" role="alert">
          {notice}
        </p>
      )}
      <p className="dialog-text">Your tests run first. Then visitors get this version.</p>
      <section className="diff-section" aria-labelledby="publish-diff-heading">
        <h3 id="publish-diff-heading" className="diff-section-heading">
          What will change
        </h3>
        {status === "loading" && <p className="muted">Comparing with the live version…</p>}
        {status === "error" && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {firstPublish && (
          <p className="muted">Nothing is live yet. This will be the first version visitors get.</p>
        )}
        {ready && !draft && <p className="muted">There is no draft to publish.</p>}
        {changes !== null && (
          <DiffList changes={changes} headingLevel={4} emptyText="Nothing has changed." />
        )}
      </section>
    </Dialog>
  );
}

/**
 * The confirmation's state for one Publish button: open it, hand the
 * confirmed draft to `publish`, keep it for "Publish anyway", and show the
 * comparison again when the server says the draft changed.
 */
export function usePublishConfirmation(
  assistantId: string,
  publish: (confirmed: ConfirmedDraft) => void,
) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const confirmedRef = useRef<ConfirmedDraft | null>(null);
  return {
    open() {
      setNotice(null);
      setOpen(true);
    },
    /** The draft last confirmed, for "Publish anyway" after failed tests. */
    confirmed(): ConfirmedDraft | undefined {
      return confirmedRef.current ?? undefined;
    },
    /** The draft changed: forget it, and read and show the comparison again. */
    reopen(message: string) {
      confirmedRef.current = null;
      setNotice(message);
      setOpen(true);
    },
    dialogProps: {
      assistantId,
      open,
      notice,
      onCancel() {
        setOpen(false);
        setNotice(null);
      },
      onConfirm(confirmed: ConfirmedDraft) {
        confirmedRef.current = confirmed;
        setOpen(false);
        setNotice(null);
        publish(confirmed);
      },
    } satisfies PublishConfirmDialogProps,
  };
}
