import type { TestExpectation } from "@solvchat/core";
import { useRef, useState } from "react";
import { ApiError, deleteJson, postJson } from "../api/client.js";
import type {
  AnswerTest,
  TestOutcome,
  TestResult,
  TestRunResponse,
  TestRunRow,
} from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { DataTable, type DataTableColumn } from "../ui/DataTable.js";
import { RelativeTime } from "../ui/DateText.js";
import { ConfirmDialog } from "../ui/Dialog.js";
import { EmptyState } from "../ui/EmptyState.js";
import { ErrorState } from "../ui/ErrorState.js";
import { Icon } from "../ui/Icon.js";
import { PageHeader } from "../ui/PageHeader.js";
import { Skeleton } from "../ui/Skeleton.js";
import { StatusBadge, type StatusTone } from "../ui/StatusBadge.js";
import { Notice, useToast } from "../ui/Toast.js";
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

function outcomeBadge(outcome: TestOutcome): { label: string; tone: StatusTone } {
  switch (outcome) {
    case "passed":
      return { label: "Passed", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "not_run":
      return { label: "Not run", tone: "warning" };
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
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const toast = useToast();
  const runsRes = useResource<{ runs: TestRunRow[] }>(
    `/api/admin/assistants/${assistantId}/test-runs`,
  );
  const latestStoredRun = (runsRes.value?.runs ?? []).reduce<number | null>(
    (latest, run) => (latest === null || run.startedAt > latest ? run.startedAt : latest),
    null,
  );
  const lastRun = lastRunAt ?? latestStoredRun ?? null;

  const tests = testsRes.value?.tests ?? [];

  async function handleRunAll() {
    if (running || tests.length === 0) return;
    setRunning(true);
    setRunError(null);
    setStoppedMessage(null);
    try {
      const startedAt = Date.now();
      const res = await postJson<TestRunResponse>(`/api/admin/assistants/${assistantId}/test-runs`);
      setLastRunAt(startedAt);
      const map = new Map<string, TestResult>();
      for (const result of res.results) {
        map.set(result.testId, result);
      }
      setRunResults(map);
      setStoppedMessage(res.stopped ?? null);
      const failed = res.results.filter((r) => r.outcome !== "passed").length;
      if (failed === 0) toast.success("All tests passed.");
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
    setDeleteError(null);
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
      setConfirmDeleteId(null);
      toast.success("Test deleted.");
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Could not delete test.");
    } finally {
      setDeletingId(null);
    }
  }

  function resultFor(test: AnswerTest): TestResult | null {
    const rawResult = runResults?.get(test.id) ?? test.latestResult ?? null;
    return rawResult && resultMatchesTest(rawResult, test) ? rawResult : null;
  }

  function startAdding() {
    setEditingSession(null);
    setAddingSessionId((prev) => (prev === null ? nextEditorSessionId.current++ : prev));
    requestAnimationFrame(() => document.getElementById("test-question")?.focus());
  }

  const columns: DataTableColumn<AnswerTest>[] = [
    {
      key: "question",
      header: "Question",
      render: (test) => (
        <div>
          <div className="source-title">{test.question}</div>
          <div className="muted">{describeExpectation(test.expectation)}</div>
        </div>
      ),
    },
    {
      key: "result",
      header: "Result",
      render: (test) => {
        const result = resultFor(test);
        const badge = result ? outcomeBadge(result.outcome) : null;
        return badge ? (
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">Not run yet</StatusBadge>
        );
      },
    },
    {
      key: "answer",
      header: "What it answered",
      render: (test) => {
        const result = resultFor(test);
        if (!result) return <span className="muted">—</span>;
        if (result.outcome === "passed") {
          return <span className="muted">{result.reason}</span>;
        }
        return (
          <div className="test-failure">
            <p className="test-failure-reason">{result.reason}</p>
            {result.excerpt && <blockquote className="test-excerpt">{result.excerpt}</blockquote>}
          </div>
        );
      },
    },
    {
      key: "actions",
      header: "Actions",
      hideHeader: true,
      align: "end",
      render: (test) => (
        <div className="actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-label={`Edit test: ${test.question}`}
            disabled={running}
            onClick={() => {
              setAddingSessionId(null);
              setEditingSession({
                sessionId: nextEditorSessionId.current++,
                testId: test.id,
              });
              requestAnimationFrame(() => document.getElementById("test-question")?.focus());
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-label={`Delete test: ${test.question}`}
            disabled={running || deletingId === test.id}
            onClick={() => {
              setDeleteError(null);
              setConfirmDeleteId(test.id);
            }}
          >
            {deletingId === test.id ? "Deleting…" : "Delete"}
          </button>
        </div>
      ),
    },
  ];

  const editingTest = editingSession
    ? (tests.find((t) => t.id === editingSession.testId) ?? null)
    : null;
  const confirmingTest = tests.find((t) => t.id === confirmDeleteId) ?? null;
  const counts = tests.reduce(
    (acc, test) => {
      const outcome = resultFor(test)?.outcome;
      if (outcome === "passed") acc.passed++;
      else if (outcome === "failed" || outcome === "not_run") acc.failed++;
      return acc;
    },
    { passed: 0, failed: 0 },
  );

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
              onClick={startAdding}
            >
              <Icon name="plus" />
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
      {stoppedMessage && <Notice tone="error">{stoppedMessage}</Notice>}
      {runError && <Notice tone="error">{runError}</Notice>}

      {addingSessionId !== null && (
        <TestEditor
          key={`add-${addingSessionId}`}
          assistantId={assistantId}
          onSaved={(created) => {
            setAddingSessionId((current) => (current === addingSessionId ? null : current));
            toast.success("Test saved.");
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

      {editingSession &&
        editingTest &&
        (() => {
          const sessionId = editingSession.sessionId;
          return (
            <TestEditor
              key={sessionId}
              assistantId={assistantId}
              testId={editingTest.id}
              initialQuestion={editingTest.question}
              initialExpectation={editingTest.expectation}
              onSaved={(updated) => {
                setEditingSession((current) => (current?.sessionId === sessionId ? null : current));
                toast.success("Test saved.");
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
                            item.latestResult && resultMatchesTest(item.latestResult, updated)
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
        })()}

      {testsRes.status === "loading" && !testsRes.value ? (
        <Skeleton label="Loading tests…" lines={4} />
      ) : testsRes.status === "error" ? (
        <ErrorState
          title="Could not load your tests."
          detail={testsRes.error}
          onRetry={testsRes.reload}
        />
      ) : tests.length === 0 ? (
        addingSessionId === null && (
          <EmptyState
            icon="tests"
            title="No tests yet"
            description="Tests guard publishing. Write down questions your assistant must keep getting right; Publish runs them first and stops if one fails, so a change cannot quietly break an answer."
            action={
              <button type="button" className="btn btn-primary" onClick={startAdding}>
                Add your first test
              </button>
            }
          />
        )
      ) : (
        <>
          <div className="test-summary">
            {lastRun !== null ? (
              <span>
                Last run <RelativeTime value={lastRun} />
                {" · "}
                {counts.passed} passed
                {counts.failed > 0 ? `, ${counts.failed} did not pass` : ""}
              </span>
            ) : (
              <span className="muted">Not run yet. Press Run now, or Publish to run them.</span>
            )}
          </div>
          <DataTable
            className="tests-table"
            caption="Tests"
            columns={columns}
            rows={tests}
            rowKey={(test) => test.id}
          />
        </>
      )}

      <ConfirmDialog
        open={confirmingTest !== null}
        title="Delete this test?"
        description={
          confirmingTest
            ? `"${confirmingTest.question}" will no longer be checked before publishing.`
            : ""
        }
        confirmLabel="Delete test"
        busyLabel="Deleting…"
        tone="danger"
        busy={confirmingTest !== null && deletingId === confirmingTest.id}
        error={deleteError}
        onCancel={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          if (confirmingTest) void handleDelete(confirmingTest.id);
        }}
      />
    </div>
  );
}
