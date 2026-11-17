import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { getJson } from "../api/client.js";
import type { Assistant } from "../api/types.js";
import { CopyButton } from "../ui/CopyButton.js";
import { useOutsidePress } from "../ui/focus.js";
import { Icon } from "../ui/Icon.js";
import { type CreatedAssistant, NewAssistantForm } from "./NewAssistantForm.js";
import { type PublishState, PublishStatusBadge, publishSnapshotOf } from "./PublishStatus.js";

export interface CreatedIngestKey {
  assistantId: string;
  ingestKey: string;
}

export interface AssistantSwitcherProps {
  assistants: Assistant[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreated: (created: CreatedAssistant) => void;
  /** Oldest undismissed one-time ingest key, shown until dismissed. */
  createdKey: CreatedIngestKey | null;
  /** How many more new keys wait behind `createdKey`. */
  pendingKeyCount?: number;
  onDismissKey: (assistantId: string) => void;
  /** Hides the switcher without unmounting it, so an unsent form is kept. */
  hidden?: boolean;
}

export function IngestKeyNotice({
  createdKey,
  pendingCount,
  onDismiss,
}: {
  createdKey: CreatedIngestKey;
  pendingCount: number;
  onDismiss: () => void;
}) {
  return (
    <div className="switcher-form" role="status" aria-label="New ingest key">
      <p className="warning-banner">Copy your ingest key now. It is shown once.</p>
      <div className="field">
        <label htmlFor="created-assistant-id">Assistant ID</label>
        <input id="created-assistant-id" type="text" readOnly value={createdKey.assistantId} />
      </div>
      <div className="field">
        <label htmlFor="created-ingest-key">Ingest key</label>
        <input id="created-ingest-key" type="text" readOnly value={createdKey.ingestKey} />
      </div>
      <div className="actions">
        <CopyButton
          value={createdKey.ingestKey}
          label="Copy key"
          className="btn btn-primary btn-sm"
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={onDismiss}>
          Done
        </button>
      </div>
      {pendingCount > 0 && (
        <p className="notice-text">
          {pendingCount === 1
            ? "1 more new key is next."
            : `${pendingCount} more new keys are next.`}
        </p>
      )}
    </div>
  );
}

const NEW_ASSISTANT = "__new__";

/** Loads each assistant's publish state while the list is open. */
function usePublishStates(assistants: Assistant[], open: boolean) {
  const [states, setStates] = useState<Record<string, PublishState>>({});
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    for (const a of assistants) {
      getJson<unknown>(`/api/admin/assistants/${a.id}/versions`, controller.signal)
        .then((value) => {
          const snapshot = publishSnapshotOf(value);
          if (!snapshot || controller.signal.aborted) return;
          setStates((prev) =>
            prev[a.id] === snapshot.state ? prev : { ...prev, [a.id]: snapshot.state },
          );
        })
        .catch(() => {
          // A status that fails to load is left out; the name is still listed.
        });
    }
    return () => controller.abort();
  }, [assistants, open]);
  return states;
}

/**
 * The assistant picker: a button showing the selected assistant that opens a
 * listbox of every assistant with its publish status, ending in "New assistant".
 */
export function AssistantSwitcher({
  assistants,
  selectedId,
  onSelect,
  onCreated,
  createdKey,
  pendingKeyCount = 0,
  onDismissKey,
  hidden = false,
}: AssistantSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const buttonId = `${baseId}-button`;
  const listId = `${baseId}-list`;
  const states = usePublishStates(assistants, open);

  const optionIds = [...assistants.map((a) => a.id), NEW_ASSISTANT];
  const selected = assistants.find((a) => a.id === selectedId) ?? null;

  useOutsidePress([buttonRef, listRef], open, () => setOpen(false));

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  function openList(index?: number) {
    const selectedIndex = assistants.findIndex((a) => a.id === selectedId);
    setActiveIndex(index ?? Math.max(selectedIndex, 0));
    setOpen(true);
  }

  function closeList() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function choose(index: number) {
    const id = optionIds[index];
    if (id === undefined) return;
    setOpen(false);
    if (id === NEW_ASSISTANT) {
      setCreating(true);
      return;
    }
    buttonRef.current?.focus();
    onSelect(id);
  }

  function onListKeyDown(event: KeyboardEvent) {
    const last = optionIds.length - 1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, last));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(last);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(activeIndex);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeList();
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  const optionId = (index: number) => `${baseId}-option-${index}`;

  return (
    <div className="switcher" hidden={hidden}>
      <div className="switcher-bar">
        <span id={labelId} className="switcher-label">
          Assistant
        </span>
        <button
          ref={buttonRef}
          id={buttonId}
          type="button"
          className="switcher-button"
          data-value={selectedId ?? ""}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-labelledby={`${labelId} ${buttonId}`}
          onClick={() => (open ? setOpen(false) : openList())}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              openList();
            }
          }}
        >
          <span className="switcher-name">{selected?.name ?? "No assistants yet"}</span>
          <Icon name="chevron-down" />
        </button>
        {open && (
          <div
            ref={listRef}
            id={listId}
            className="switcher-list"
            role="listbox"
            aria-labelledby={labelId}
            aria-activedescendant={optionId(activeIndex)}
            tabIndex={-1}
            onKeyDown={onListKeyDown}
          >
            {assistants.map((a, index) => {
              const state = states[a.id];
              return (
                <div
                  key={a.id}
                  id={optionId(index)}
                  role="option"
                  data-value={a.id}
                  tabIndex={-1}
                  aria-selected={a.id === selectedId}
                  className={
                    index === activeIndex
                      ? "switcher-option switcher-option-active"
                      : "switcher-option"
                  }
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(index)}
                  onKeyDown={() => {}}
                >
                  <span className="switcher-check" aria-hidden="true">
                    {a.id === selectedId && <Icon name="check" />}
                  </span>
                  <span className="switcher-option-name">{a.name}</span>
                  {state && <PublishStatusBadge state={state} />}
                </div>
              );
            })}
            <div
              id={optionId(assistants.length)}
              role="option"
              tabIndex={-1}
              aria-selected={false}
              className={
                activeIndex === assistants.length
                  ? "switcher-option switcher-new switcher-option-active"
                  : "switcher-option switcher-new"
              }
              onMouseEnter={() => setActiveIndex(assistants.length)}
              onClick={() => choose(assistants.length)}
              onKeyDown={() => {}}
            >
              <span className="switcher-check" aria-hidden="true">
                <Icon name="plus" />
              </span>
              <span className="switcher-option-name">New assistant</span>
            </div>
          </div>
        )}
      </div>

      {creating && (
        <section className="switcher-popover" aria-labelledby={`${baseId}-new-title`}>
          <div className="switcher-popover-header">
            <h2 id={`${baseId}-new-title`} className="switcher-popover-title">
              New assistant
            </h2>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setCreating(false);
                buttonRef.current?.focus();
              }}
            >
              Cancel
            </button>
          </div>
          <NewAssistantForm
            idPrefix="new-assistant"
            className="switcher-form"
            autoFocus
            onCreated={(created) => {
              setCreating(false);
              onCreated(created);
            }}
          />
        </section>
      )}

      {createdKey && (
        <div className="switcher-popover">
          <IngestKeyNotice
            key={createdKey.assistantId}
            createdKey={createdKey}
            pendingCount={pendingKeyCount}
            onDismiss={() => onDismissKey(createdKey.assistantId)}
          />
        </div>
      )}
    </div>
  );
}
