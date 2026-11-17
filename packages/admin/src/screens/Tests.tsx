import type { TestExpectation } from "@solvchat/core";
import { useRef, useState } from "react";
import { ApiError, deleteJson, postJson } from "../api/client.js";
import type { AnswerTest, TestOutcome, TestResult, TestRunResponse } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { EmptyState } from "../ui/EmptyState.js";
import { PageHeader } from "../ui/PageHeader.js";
import { describeExpectation, TestEditor } from "./TestEditor.js";

export interface TestsProps {
  assistantId: string;
}

function expectationsEqual(a: TestExpectation, b: TestExpectation): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "cites":
      return b.kind === "cites" && a.url === b.url;
    case "contains":
    case "notContains":
      return b.kind === a.kind && a.phrase === b.phrase;
    case "declines":
      return true;
  }
}

function resultMatchesTest(result: TestResult, test: AnswerTest): boolean {
  return (
    result.question === test.question && expectationsEqual(result.expectation, test.expectation)
  );
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
  const [addingSessionId, setAddingSessionId] = useState<number | null>(null);
  const [editingSession, setEditingSession] = useState<{
    sessionId: number;
    testId: string;
  } | null>(null);
  const nextEditorSessionId = useRef(1);
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
      setEditingSession((current) => (current?.testId === testId ? null : current));
      setRunResults((prev) => {
        if (!prev?.has(testId)) return prev;
        const next = new Map(prev);
        next.delete(testId);
        return next;
      });
      testsRes.setValue((prev) => ({
        tests: (prev?.tests ?? []).filter((t) => t.id !== testId),
      }));
      testsRes.reload();
      setStatusMessage("Test deleted.");
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Could not delete test.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="screen">
      <PageHeader
        title="Tests"
        description="Questions your assistant must keep getting right. Publish runs these first."
        actions={
          <>
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
                setEditingSession(null);
                setAddingSessionId((prev) =>
                  prev === null ? nextEditorSessionId.current++ : null,
                );
              }}
            >
              Add test
            </button>
          </>
        }
      />

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

      {addingSessionId !== null && (
        <TestEditor
          key={`add-${addingSessionId}`}
          assistantId={assistantId}
          onSaved={(created) => {
            setAddingSessionId((current) => (current === addingSessionId ? null : current));
            setStatusMessage("Test saved.");
            testsRes.setValue((prev) => {
              const current = prev?.tests ?? [];
              return {
                tests: current.some((t) => t.id === created.id) ? current : [...current, created],
              };
            });
            testsRes.reload();
          }}
          onCancel={() => setAddingSessionId(null)}
        />
      )}

      {testsRes.status === "loading" && !testsRes.value ? (
        <p className="muted">Loading tests…</p>
      ) : testsRes.status === "error" ? (
        <p className="error-text" role="alert">
          {testsRes.error}
        </p>
      ) : tests.length === 0 ? (
        <EmptyState
          icon="tests"
          title="No tests yet"
          description="Add a question your assistant should get right."
        />
      ) : (
        <ul className="history-list">
          {tests.map((test) => {
            const rawResult = runResults?.get(test.id) ?? test.latestResult ?? null;
            const result = rawResult && resultMatchesTest(rawResult, test) ? rawResult : null;
            const badge = result ? outcomeBadge(result.outcome) : null;

            return (
              <li key={test.id} className="source-card stack">
                {editingSession?.testId === test.id ? (
                  (() => {
                    const sessionId = editingSession.sessionId;
                    return (
                      <TestEditor
                        key={sessionId}
                        assistantId={assistantId}
                        testId={test.id}
                        initialQuestion={test.question}
                        initialExpectation={test.expectation}
                        onSaved={(updated) => {
                          setEditingSession((current) =>
                            current?.sessionId === sessionId ? null : current,
                          );
                          setStatusMessage("Test saved.");
                          setRunResults((prev) => {
                            if (!prev?.has(updated.id)) return prev;
                            const next = new Map(prev);
                            next.delete(updated.id);
                            return next;
                          });
                          testsRes.setValue((prev) => ({
                            tests: (prev?.tests ?? []).map((item) =>
                              item.id === updated.id
                                ? {
                                    ...updated,
                                    latestResult:
                                      item.latestResult &&
                                      resultMatchesTest(item.latestResult, updated)
                                        ? item.latestResult
                                        : null,
                                  }
                                : item,
                            ),
                          }));
                          testsRes.reload();
                        }}
                        onCancel={() => setEditingSession(null)}
                      />
                    );
                  })()
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
                            setAddingSessionId(null);
                            setEditingSession({
                              sessionId: nextEditorSessionId.current++,
                              testId: test.id,
                            });
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
