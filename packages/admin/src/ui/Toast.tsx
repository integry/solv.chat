import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "./Icon.js";

export type ToastKind = "success" | "error" | "info";

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ToastApi {
  /** Shows a message. Errors stay until dismissed; others go after a few seconds. */
  show: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  dismiss: (id: number) => void;
}

const NOOP: ToastApi = { show() {}, success() {}, error() {}, dismiss() {} };
const ToastContext = createContext<ToastApi | null>(null);

/** Auto-dismiss delay for success and info messages, in milliseconds. */
export const TOAST_TIMEOUT_MS = 6000;

/** How many messages show at once before older success and info messages make room. */
const MAX_TOASTS = 4;

/**
 * Adds a message and trims the oldest success and info messages until at most
 * `MAX_TOASTS` show. Errors are never trimmed (they stay until dismissed), and
 * neither is the message just added, so the list can go over the limit when
 * several errors are waiting.
 */
function addToast(prev: ToastMessage[], toast: ToastMessage): ToastMessage[] {
  const next = [...prev];
  let excess = next.length + 1 - MAX_TOASTS;
  for (let i = 0; i < next.length && excess > 0; ) {
    if (next[i]?.kind === "error") {
      i++;
    } else {
      next.splice(i, 1);
      excess--;
    }
  }
  next.push(toast);
  return next;
}

/**
 * Holds the admin's feedback messages and renders them in two live regions:
 * `role="status"` for success and info, `role="alert"` for errors. The admin
 * shell already provides one; mount another only outside the shell.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, kind: ToastKind = "info") => {
      const id = nextId.current++;
      setToasts((prev) => addToast(prev, { id, kind, message }));
      if (kind !== "error") {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), TOAST_TIMEOUT_MS),
        );
      }
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message) => show(message, "success"),
      error: (message) => show(message, "error"),
      dismiss,
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/** The feedback messages API. Does nothing outside a `ToastProvider`. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: number) => void }) {
  return (
    <div className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
      <Icon name={toast.kind === "error" ? "alert" : "check"} />
      <p className="toast-text">{toast.message}</p>
      <button
        type="button"
        className="btn-icon toast-close"
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

function ToastRegion({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}) {
  // Both live regions are always in the page (a region added together with its
  // text is often not read out); each message carries its own role.
  return (
    <div className="toast-stack">
      <div aria-live="polite" className="toast-region">
        {toasts
          .filter((t) => t.kind !== "error")
          .map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
          ))}
      </div>
      <div aria-live="assertive" className="toast-region">
        {toasts
          .filter((t) => t.kind === "error")
          .map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
          ))}
      </div>
    </div>
  );
}

export interface NoticeProps {
  tone?: "success" | "error" | "info" | "warning";
  children: ReactNode;
  className?: string;
}

/**
 * Inline feedback next to the thing it is about. Errors use `role="alert"`;
 * everything else `role="status"`.
 */
export function Notice({ tone = "info", children, className }: NoticeProps) {
  return (
    <div
      className={`notice notice-${tone}${className ? ` ${className}` : ""}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
