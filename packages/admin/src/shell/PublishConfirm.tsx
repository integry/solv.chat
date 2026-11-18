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
  const res = useResource<{ versions: VersionRow[] }>(
    `/api/admin/assistants/${assistantId}/versions`,
  );
  const cancelRef = useRef<HTMLButtonElement>(null);
  const versions = res.status === "ready" ? (res.value?.versions ?? null) : null;
  const draft = versions?.find((v) => v.state === "draft") ?? null;
  const published = versions?.find((v) => v.state === "published") ?? null;
  const changes = draft && published ? diffVersionConfigs(published.config, draft.config) : null;
  const firstPublish = versions !== null && draft !== null && published === null;
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
        {res.status === "loading" && <p className="muted">Comparing with the live version…</p>}
        {res.status === "error" && (
          <p className="error-text" role="alert">
            {res.error}
          </p>
        )}
        {versions !== null && firstPublish && (
          <p className="muted">Nothing is live yet. This will be the first version visitors get.</p>
        )}
        {versions !== null && !draft && <p className="muted">There is no draft to publish.</p>}
        {changes !== null && (
          <DiffList changes={changes} headingLevel={4} emptyText="Nothing has changed." />
        )}
      </section>
    </Dialog>
  );
}
