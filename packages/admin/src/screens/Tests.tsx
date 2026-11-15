import { useState } from "react";
import { ApiError, deleteJson, postJson } from "../api/client.js";
import type { AnswerTest, TestOutcome, TestResult, TestRunResponse } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { describeExpectation, TestEditor } from "./TestEditor.js";

export interface TestsProps {
  assistantId: string;
}

function outcomeBadge(outcome: TestOutcome): { label: string; className: string } {
  switch (outcome) {
    case "passed":
      return { label: "Passed", className: "badge badge-published" };
    case "failed":
      return { label: "Failed", className: "badge badge-danger" };
    case "not_run":
      return { label: "Not run", className: "badge badge-warn" };
  }
}

export function Tests({ assistantId }: TestsProps) {
  const testsRes = useResource<{ tests: AnswerTest[] }>(
    `/api/admin/assistants/${assistantId}/tests`,
  );
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runResults, setRunResults] = useState<Map<string, TestResult> | null>(null);
  const [stoppedMessage, setStoppedMessage] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const tests = testsRes.value?.tests ?? [];

  async function handleRunAll() {
    if (running || tests.length === 0) return;
    setRunning(true);
    setRunError(null);
    setStoppedMessage(null);
    setStatusMessage(null);
    try {
      const res = await postJson<TestRunResponse>(`/api/admin/assistants/${assistantId}/test-runs`);
      const map = new Map<string, TestResult>();
      for (const result of res.results) {
        map.set(result.testId, result);
      }
      setRunResults(map);
      setStoppedMessage(res.stopped ?? null);
      testsRes.reload();
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Could not run tests.");
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete(testId: string) {
    if (deletingId) return;
    setDeletingId(testId);
    setRunError(null);
    setStatusMessage(null);
    try {
      await deleteJson<{ deleted: true }>(`/api/admin/tests/${testId}`);
      if (editingId === testId) setEditingId(null);
      testsRes.setValue({ tests: tests.filter((t) => t.id !== testId) });
      setStatusMessage("Test deleted.");
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Could not delete test.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <div>
          <h1>Tests</h1>
          <p className="muted">
            Questions your assistant must keep getting right. Publish runs these first.
          </p>
        </div>
        <div className="screen-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={running || tests.length === 0}
            onClick={() => void handleRunAll()}
          >
            {running ? "Running…" : "Run now"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={running}
            onClick={() => {
              setEditingId(null);
              setAdding((prev) => !prev);
            }}
          >
            Add test
          </button>
        </div>
      </div>

      {running && (
        <p className="muted" role="status">
          Running tests against your draft…
        </p>
      )}
      {statusMessage && (
        <p className="notice-text" role="status">
          {statusMessage}
        </p>
      )}
      {stoppedMessage && (
        <p className="error-text" role="alert">
          {stoppedMessage}
        </p>
      )}
      {runError && (
        <p className="error-text" role="alert">
          {runError}
        </p>
      )}

      {adding && (
        <TestEditor
          assistantId={assistantId}
          onSaved={(created) => {
            setAdding(false);
            setStatusMessage("Test saved.");
            testsRes.setValue({ tests: [...tests, created] });
            testsRes.reload();
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {testsRes.status === "loading" && !testsRes.value ? (
        <p className="muted">Loading tests…</p>
      ) : testsRes.status === "error" ? (
        <p className="error-text" role="alert">
          {testsRes.error}
        </p>
      ) : tests.length === 0 ? (
        <p className="muted">No tests yet. Add a question your assistant should get right.</p>
      ) : (
        <ul className="history-list">
          {tests.map((test) => {
            const result = runResults?.get(test.id) ?? test.latestResult ?? null;
            const badge = result ? outcomeBadge(result.outcome) : null;

            return (
              <li key={test.id} className="source-card stack">
                {editingId === test.id ? (
                  <TestEditor
                    key={test.id}
                    assistantId={assistantId}
                    testId={test.id}
                    initialQuestion={test.question}
                    initialExpectation={test.expectation}
                    onSaved={(updated) => {
                      setEditingId(null);
                      setStatusMessage("Test saved.");
                      testsRes.setValue({
                        tests: tests.map((item) =>
                          item.id === updated.id
                            ? { ...updated, latestResult: item.latestResult ?? null }
                            : item,
                        ),
                      });
                      testsRes.reload();
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <>
                    <div className="source-header">
                      <div>
                        <div className="source-title">{test.question}</div>
                        <div className="muted">{describeExpectation(test.expectation)}</div>
                      </div>
                      <div className="actions">
                        {badge ? (
                          <span className={badge.className}>{badge.label}</span>
                        ) : (
                          <span className="badge">Not run yet</span>
                        )}
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={running}
                          onClick={() => {
                            setAdding(false);
                            setEditingId(test.id);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={running || deletingId === test.id}
                          onClick={() => void handleDelete(test.id)}
                        >
                          {deletingId === test.id ? "Deleting…" : "Delete"}
                        </button>
                      </div>
                    </div>
                    {result && (
                      <div className="stack">
                        <p className="muted">{result.reason}</p>
                        {result.excerpt && <p className="muted">{result.excerpt}</p>}
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
