import { useRef, useState } from "react";
import type { GapSummary, GapsPage } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { EmptyState } from "../ui/EmptyState.js";
import { formatDateTime } from "../ui/format.js";
import { PageHeader } from "../ui/PageHeader.js";
import { EntryEditor } from "./EntryEditor.js";
import { TestEditor } from "./TestEditor.js";

export interface GapsProps {
  assistantId: string;
}

const PAGE_SIZE = 25;

function formatDate(timestamp: number): string {
  return formatDateTime(timestamp);
}

export function Gaps({ assistantId }: GapsProps) {
  const [offset, setOffset] = useState(0);
  const gapsRes = useResource<GapsPage>(
    `/api/admin/assistants/${assistantId}/gaps?limit=${PAGE_SIZE}&offset=${offset}`,
  );
  const [editingGap, setEditingGap] = useState<GapSummary | null>(null);
  const [addingTestGap, setAddingTestGap] = useState<{
    sessionId: number;
    gap: GapSummary;
  } | null>(null);
  const nextTestSessionId = useRef(1);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const page = gapsRes.value;
  const gaps = page?.gaps ?? [];
  const hasPrevious = offset > 0;
  const hasNext = page ? offset + page.limit < page.total : false;

  return (
    <div className="screen">
      <PageHeader
        title="Gaps"
        description="Questions your assistant could not answer yet. Write an answer to add it to your sources."
      />

      {statusMessage && (
        <p className="notice-text" role="status">
          {statusMessage}
        </p>
      )}

      {editingGap && (
        <EntryEditor
          assistantId={assistantId}
          fromMessageId={editingGap.exampleMessageId}
          initialQuestion={editingGap.displayQuestion || editingGap.question}
          onSaved={(_result, session) => {
            if (session.assistantId !== assistantId) return;
            setEditingGap((current) =>
              current?.exampleMessageId === session.fromMessageId ? null : current,
            );
            gapsRes.reload();
          }}
          onCancel={() => setEditingGap(null)}
        />
      )}

      {addingTestGap &&
        (() => {
          const sessionId = addingTestGap.sessionId;
          return (
            <TestEditor
              key={sessionId}
              assistantId={assistantId}
              initialQuestion={addingTestGap.gap.displayQuestion || addingTestGap.gap.question}
              onSaved={() => {
                setAddingTestGap((current) => (current?.sessionId === sessionId ? null : current));
                setStatusMessage("Added to tests.");
              }}
              onCancel={() => setAddingTestGap(null)}
            />
          );
        })()}

      {gapsRes.status === "loading" && !gapsRes.value ? (
        <p className="muted">Loading gaps…</p>
      ) : gapsRes.status === "error" ? (
        <p className="error-text" role="alert">
          {gapsRes.error}
        </p>
      ) : gaps.length === 0 && !hasPrevious ? (
        <EmptyState
          icon="gaps"
          title="No unanswered questions yet"
          description="Questions your assistant could not answer show up here, ready for you to answer."
        />
      ) : (
        <div className="stack">
          {gaps.length === 0 ? (
            <p className="muted">No unanswered questions on this page.</p>
          ) : (
            <ul className="history-list">
              {gaps.map((gap) => (
                <li key={gap.exampleMessageId} className="source-card stack">
                  <div className="source-header">
                    <div>
                      <div className="source-title">{gap.displayQuestion || gap.question}</div>
                      <div className="source-meta">
                        <span>{gap.times === 1 ? "Asked 1 time" : `Asked ${gap.times} times`}</span>
                        <span>Last asked {formatDate(gap.lastAsked)}</span>
                        {gap.handled && <span className="badge badge-published">Handled</span>}
                      </div>
                    </div>
                    <div className="actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setAddingTestGap(null);
                          setStatusMessage(null);
                          setEditingGap(gap);
                        }}
                      >
                        Write the right answer
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setEditingGap(null);
                          setStatusMessage(null);
                          setAddingTestGap({
                            sessionId: nextTestSessionId.current++,
                            gap,
                          });
                        }}
                      >
                        Add to tests
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {(hasPrevious || hasNext) && (
            <div className="actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!hasPrevious}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!hasNext}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
