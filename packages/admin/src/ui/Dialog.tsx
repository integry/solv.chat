import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "./focus.js";

export interface DialogProps {
  open: boolean;
  title: ReactNode;
  /** Called on Escape, the backdrop, or a close button. */
  onClose: () => void;
  children?: ReactNode;
  /** Buttons at the bottom of the dialog. */
  footer?: ReactNode;
  /** Element focused when the dialog opens; default the first focusable one. */
  initialFocus?: RefObject<HTMLElement | null> | undefined;
  /** Id of the element describing the dialog. */
  describedBy?: string | undefined;
  /** Escape and the backdrop do nothing while true (for example, mid-request). */
  dismissDisabled?: boolean;
  /** Wider dialog, for content such as a list of changes. */
  wide?: boolean;
}

/**
 * Modal dialog: focus is trapped inside and returns to the opener on close.
 * Rendered into `document.body` so no container clips it.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  initialFocus,
  describedBy,
  dismissDisabled = false,
  wide = false,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = () => {
    if (!dismissDisabled) onClose();
  };
  const trap = useFocusTrap(ref, open, { onEscape: close, initialFocus });
  if (!open) return null;
  return createPortal(
    <div className="dialog-layer">
      <div className="dialog-backdrop" aria-hidden="true" onClick={close} />
      <div
        ref={ref}
        className={wide ? "dialog dialog-wide" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={trap.onKeyDown}
      >
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        {children !== undefined && <div className="dialog-body">{children}</div>}
        {footer !== undefined && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** What will happen, in one or two sentences. */
  description: ReactNode;
  /** Label of the confirm button, a verb such as "Delete source". */
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` styles the confirm button as destructive. Default `default`. */
  tone?: "default" | "danger";
  /**
   * Typed confirmation: the confirm button stays disabled until this exact
   * text is typed. Use it for actions that cannot be undone.
   */
  confirmText?: string;
  /** Shows the confirm button as working and blocks closing. */
  busy?: boolean;
  /** Label shown on the confirm button while busy. */
  busyLabel?: string;
  /** Error from the last attempt, shown above the buttons. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Asks before doing something. Cancel is focused first, so Enter never destroys. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null;
  return <ConfirmDialogBody {...props} />;
}

function ConfirmDialogBody({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  confirmText,
  busy = false,
  busyLabel,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const descriptionId = useId();
  const inputId = useId();
  const matches = confirmText === undefined || typed === confirmText;

  return (
    <Dialog
      open
      title={title}
      onClose={onCancel}
      describedBy={descriptionId}
      initialFocus={confirmText !== undefined ? inputRef : cancelRef}
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
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === "danger" ? "btn btn-danger" : "btn btn-primary"}
            disabled={busy || !matches}
            onClick={onConfirm}
          >
            {busy ? (busyLabel ?? `${confirmLabel}…`) : confirmLabel}
          </button>
        </>
      }
    >
      <div id={descriptionId} className="dialog-text">
        {description}
      </div>
      {confirmText !== undefined && (
        <div className="field">
          <label htmlFor={inputId}>
            Type <strong>{confirmText}</strong> to confirm
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            disabled={busy}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches && !busy) {
                e.preventDefault();
                onConfirm();
              }
            }}
          />
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
