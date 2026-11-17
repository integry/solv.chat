import { Icon } from "./Icon.js";

export interface ErrorStateProps {
  /** What could not be done, e.g. "Could not load conversations." */
  title: string;
  /** The server's message, if any. */
  message?: string | null | undefined;
  /** Shows "Try again" when given. */
  onRetry?: (() => void) | undefined;
}

/** Shown in place of content that failed to load, with a way to try again. */
export function ErrorState({ title, message, onRetry }: ErrorStateProps) {
  return (
    <div className="error-state" role="alert">
      <Icon name="alert" size={20} className="error-state-icon" />
      <div className="error-state-text">
        <p className="error-state-title">{title}</p>
        {message && message !== title && <p className="muted">{message}</p>}
      </div>
      {onRetry && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
