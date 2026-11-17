import type { TestRunSummary } from "../api/types.js";

export interface FailedTestsPanelProps {
  run: TestRunSummary;
  busy: boolean;
  /** "Publish anyway" stays disabled (with a hint) while edits are not saved. */
  publishBlocked?: boolean;
  onFix: () => void;
  onPublishAnyway: () => void;
}

/** Shows which tests failed during publish and lets the owner fix or override. */
export function FailedTestsPanel({
  run,
  busy,
  publishBlocked = false,
  onFix,
  onPublishAnyway,
}: FailedTestsPanelProps) {
  return (
    <section className="source-card stack" role="alert" aria-label="Tests that did not pass">
      <p className="error-text">Some tests did not pass, so nothing was published.</p>
      {run.stopped && <p className="muted">{run.stopped}</p>}
      <ul className="history-list">
        {run.results
          .filter((result) => result.outcome !== "passed")
          .map((result) => (
            <li key={result.testId} className="history-item">
              <span>{result.question}</span>
              <span className="muted">{result.reason}</span>
            </li>
          ))}
      </ul>
      {publishBlocked && !busy && (
        <p className="field-hint">Save your changes before publishing.</p>
      )}
      <div className="actions">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onFix}>
          Go back and fix it
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || publishBlocked}
          onClick={onPublishAnyway}
        >
          {busy ? "Publishing…" : "Publish anyway"}
        </button>
      </div>
    </section>
  );
}
