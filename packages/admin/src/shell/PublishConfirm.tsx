import { diffVersionConfigs } from "@solvchat/core";
import { useRef } from "react";
import type { VersionRow } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { Dialog } from "../ui/Dialog.js";
import { DiffList } from "../ui/DiffList.js";

export interface PublishConfirmDialogProps {
  assistantId: string;
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Asks before publishing, with "What will change": the saved draft compared
 * with the published version. Read fresh each time it opens, so it shows what
 * Publish will actually send. Nothing changed leaves Publish disabled.
 */
export function PublishConfirmDialog(props: PublishConfirmDialogProps) {
  if (!props.open) return null;
  return <PublishConfirmBody {...props} />;
}

function PublishConfirmBody({ assistantId, onConfirm, onCancel }: PublishConfirmDialogProps) {
  // The draft comes from its own endpoint, the one Publish sends: never from
  // History, which is bounded. The engine always includes the live version in
  // the versions list, however long History has grown.
  const draftRes = useResource<{ draft: VersionRow }>(`/api/admin/assistants/${assistantId}/draft`);
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
  const published = ready
    ? (versionsRes.value?.versions.find((v) => v.state === "published") ?? null)
    : null;
  const changes = draft && published ? diffVersionConfigs(published.config, draft.config) : null;
  const firstPublish = ready && draft !== null && published === null;
  const canPublish = firstPublish || (changes !== null && changes.length > 0);

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
            onClick={onConfirm}
          >
            Publish now
          </button>
        </>
      }
    >
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
