import { useId, useState } from "react";
import { ApiError, deleteJson, patchJson, postJson } from "../api/client.js";
import type { TopicItem, TopicsList } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { Dialog } from "../ui/Dialog.js";
import { Skeleton } from "../ui/Skeleton.js";
import { useToast } from "../ui/Toast.js";

/** The longest topic name the engine accepts (`TOPIC_NAME_MAX_LENGTH`). */
const NAME_MAX = 40;

export interface TopicsDialogProps {
  assistantId: string;
  open: boolean;
  onClose: () => void;
  /** Called after a rename, merge or delete, so the report can be read again. */
  onChanged: () => void;
}

type Editing =
  | { kind: "rename"; id: string; name: string; error: string | null }
  | { kind: "merge"; id: string; into: string }
  | { kind: "delete"; id: string }
  | null;

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.fields.name ?? err.message;
  return fallback;
}

/**
 * "Manage topics": rename one, merge one into another (its questions move),
 * or delete one (its questions keep no topic). Topics are named by the answer
 * review; there is no way to tag a single message by hand.
 */
export function TopicsDialog({ assistantId, open, onClose, onChanged }: TopicsDialogProps) {
  const res = useResource<TopicsList>(open ? `/api/admin/assistants/${assistantId}/topics` : null);
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const hintId = useId();
  const base = `/api/admin/assistants/${assistantId}/topics`;
  const topics = res.value?.topics ?? [];

  async function run(action: () => Promise<unknown>, done: string, failed: string) {
    setBusy(true);
    try {
      await action();
      toast.success(done);
      setEditing(null);
      res.reload();
      onChanged();
    } catch (err) {
      if (editing?.kind === "rename") {
        setEditing({ ...editing, error: errorText(err, failed) });
      } else {
        toast.error(errorText(err, failed));
      }
    } finally {
      setBusy(false);
    }
  }

  function row(topic: TopicItem) {
    const id = topic.id;
    if (editing?.id === id && editing.kind === "rename") {
      const inputId = `${hintId}-${id}`;
      return (
        <form
          className="topic-edit"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () => patchJson(`${base}/${id}`, { name: editing.name }),
              "Topic renamed.",
              "Could not rename. Try again.",
            );
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            New name for {topic.name}
          </label>
          <input
            id={inputId}
            value={editing.name}
            maxLength={NAME_MAX}
            aria-invalid={editing.error !== null}
            aria-describedby={editing.error ? `${inputId}-error` : undefined}
            onChange={(e) => setEditing({ ...editing, name: e.target.value, error: null })}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            Save
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => setEditing(null)}
          >
            Cancel
          </button>
          {editing.error && (
            <p id={`${inputId}-error`} className="field-error">
              {editing.error}
            </p>
          )}
        </form>
      );
    }
    if (editing?.id === id && editing.kind === "merge") {
      const selectId = `${hintId}-${id}-into`;
      const others = topics.filter((t) => t.id !== id);
      return (
        <form
          className="topic-edit"
          onSubmit={(event) => {
            event.preventDefault();
            if (editing.into === "") return;
            void run(
              () => postJson(`${base}/${id}/merge`, { into: editing.into }),
              "Topics merged.",
              "Could not merge. Try again.",
            );
          }}
        >
          <label htmlFor={selectId}>Merge “{topic.name}” into</label>
          <select
            id={selectId}
            className="select"
            value={editing.into}
            onChange={(e) => setEditing({ ...editing, into: e.target.value })}
          >
            <option value="">Choose a topic</option>
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={busy || editing.into === ""}
          >
            Merge
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => setEditing(null)}
          >
            Cancel
          </button>
          <p className="muted topic-edit-note">All its questions move to the topic you choose.</p>
        </form>
      );
    }
    if (editing?.id === id && editing.kind === "delete") {
      return (
        <div className="topic-edit">
          <span>Delete “{topic.name}”? Its questions will have no topic.</span>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={busy}
            onClick={() =>
              void run(
                () => deleteJson(`${base}/${id}`),
                "Topic deleted.",
                "Could not delete. Try again.",
              )
            }
          >
            Delete
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => setEditing(null)}
          >
            Cancel
          </button>
        </div>
      );
    }
    return (
      <>
        <span className="topic-name">{topic.name}</span>
        <span className="topic-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-label={`Rename ${topic.name}`}
            disabled={busy}
            onClick={() => setEditing({ kind: "rename", id, name: topic.name, error: null })}
          >
            Rename
          </button>
          {topics.length > 1 && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              aria-label={`Merge ${topic.name}`}
              disabled={busy}
              onClick={() => setEditing({ kind: "merge", id, into: "" })}
            >
              Merge
            </button>
          )}
          <button
            type="button"
            className="btn btn-danger-outline btn-sm"
            aria-label={`Delete ${topic.name}`}
            disabled={busy}
            onClick={() => setEditing({ kind: "delete", id })}
          >
            Delete
          </button>
        </span>
      </>
    );
  }

  return (
    <Dialog
      open={open}
      title="Manage topics"
      wide
      describedBy={hintId}
      dismissDisabled={busy}
      onClose={() => {
        setEditing(null);
        onClose();
      }}
      footer={
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
          Close
        </button>
      }
    >
      <p id={hintId} className="muted">
        Topics are named when answers are reviewed. Rename one, merge two that mean the same, or
        delete one.
      </p>
      {res.status === "error" ? (
        <p className="error-text">Could not load topics. {res.error}</p>
      ) : res.value === undefined ? (
        <Skeleton label="Loading topics…" lines={3} />
      ) : topics.length === 0 ? (
        <p className="muted">No topics yet.</p>
      ) : (
        <ul className="row-list topic-list">
          {topics.map((topic) => (
            <li key={topic.id} className="row-item topic-row">
              {row(topic)}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
