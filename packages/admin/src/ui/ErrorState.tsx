import { Icon } from "./Icon.js";

export interface ErrorStateProps {
  /** What could not be loaded, as a sentence: "Could not load your sources." */
  title: string;
  /** The server's message, when there is one. */
  detail?: string | null | undefined;
  /** Shown as a "Try again" button when given. */
  onRetry?: (() => void) | undefined;
  /** Disables the button while a retry is running. */
  retrying?: boolean;
}

/** Shown in place of a screen's content when loading it failed. */
export function ErrorState({ title, detail, onRetry, retrying = false }: ErrorStateProps) {
  return (
    <div className="error-state" role="alert">
      <div className="error-state-text">
        <Icon name="alert" />
        <div>
          <p className="error-state-title">{title}</p>
          {detail && detail !== title && <p className="muted">{detail}</p>}
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? "Trying again…" : "Try again"}
        </button>
      )}
    </div>
  );
}
