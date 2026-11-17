import { useEffect, useRef, useState } from "react";
import { ApiError, postJson } from "../api/client.js";
import type { GapSummary, GapsPage } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { clearQueryParams, readQueryParam } from "../routing.js";
import { RelativeTime } from "../ui/DateText.js";
import { EmptyState } from "../ui/EmptyState.js";
import { ErrorState } from "../ui/ErrorState.js";
import { PageHeader } from "../ui/PageHeader.js";
import { ScreenLink } from "../ui/ScreenLink.js";
import { Skeleton } from "../ui/Skeleton.js";
import { useToast } from "../ui/Toast.js";
import { EntryEditor } from "./EntryEditor.js";
import { TestEditor } from "./TestEditor.js";

export interface GapsProps {
  assistantId: string;
}

const PAGE_SIZE = 25;

/** The editor is open for one gap row, or for a question handed over from a conversation. */
interface AnswerSession {
  fromMessageId: string;
  question: string;
  /** Set when it belongs to a row in the list; null for a handed-over question. */
  gapKey: string | null;
}

/** "Write an answer for this" in a conversation lands here with `?answer=…&question=…`. */
function readHandedOverAnswer(): AnswerSession | null {
  const fromMessageId = readQueryParam("answer");
  if (!fromMessageId) return null;
  return { fromMessageId, question: readQueryParam("question") ?? "", gapKey: null };
}

function gapTitle(gap: GapSummary): string {
  return gap.displayQuestion || gap.question;
}

export function Gaps({ assistantId }: GapsProps) {
  const toast = useToast();
  const [offset, setOffset] = useState(0);
  const gapsRes = useResource<GapsPage>(
    `/api/admin/assistants/${assistantId}/gaps?status=open&limit=${PAGE_SIZE}&offset=${offset}`,
  );
  const [answering, setAnswering] = useState<AnswerSession | null>(readHandedOverAnswer);
  const [addingTest, setAddingTest] = useState<{ sessionId: number; gapKey: string } | null>(null);
  const nextTestSessionId = useRef(1);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<GapSummary | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // The handed-over question is now in state; drop it from the address so a
  // reload does not open the editor again.
  useEffect(() => {
    clearQueryParams();
  }, []);

  const page = gapsRes.value;
  const gaps = page?.gaps ?? [];
  const hasPrevious = offset > 0;
  const hasNext = page ? offset + page.limit < page.total : false;

  function startAnswer(gap: GapSummary) {
    setAddingTest(null);
    setStatusMessage(null);
    setAnswering({
      fromMessageId: gap.exampleMessageId,
      question: gapTitle(gap),
      gapKey: gap.question,
    });
  }

  async function dismiss(gap: GapSummary) {
    setBusyKey(gap.question);
    try {
      await postJson(`/api/admin/assistants/${assistantId}/gaps/dismiss`, {
        question: gap.question,
      });
      setDismissed(gap);
      setStatusMessage(null);
      if (answering?.gapKey === gap.question) setAnswering(null);
      if (addingTest?.gapKey === gap.question) setAddingTest(null);
      gapsRes.reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not dismiss. Try again.");
    } finally {
      setBusyKey(null);
    }
  }

  async function undoDismiss(gap: GapSummary) {
    setBusyKey(gap.question);
    try {
      await postJson(`/api/admin/assistants/${assistantId}/gaps/restore`, {
        question: gap.question,
      });
      setDismissed(null);
      gapsRes.reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not undo. Try again.");
    } finally {
      setBusyKey(null);
    }
  }

  function editorFor(session: AnswerSession) {
    return (
      <EntryEditor
        assistantId={assistantId}
        fromMessageId={session.fromMessageId}
        initialQuestion={session.question}
        onSaved={(_result, saved) => {
          if (saved.assistantId !== assistantId) return;
          setAnswering((current) =>
            current?.fromMessageId === saved.fromMessageId ? null : current,
          );
          toast.success("Answer saved to your sources. The assistant can use it once indexed.");
          gapsRes.reload();
        }}
        onCancel={() => setAnswering(null)}
      />
    );
  }

  return (
    <div className="screen screen-medium">
      <PageHeader
        title="Gaps"
        description="Questions your assistant could not answer yet, most asked first. Write an answer to add it to your sources."
      />

      {dismissed && (
        <div className="notice notice-info undo-notice" role="status">
          <span>Dismissed “{gapTitle(dismissed)}”. It comes back if a visitor asks it again.</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busyKey === dismissed.question}
            onClick={() => void undoDismiss(dismissed)}
          >
            Undo
          </button>
        </div>
      )}

      {statusMessage && (
        <p className="notice-text" role="status">
          {statusMessage}
        </p>
      )}

      {answering && answering.gapKey === null && editorFor(answering)}

      {gapsRes.status === "error" ? (
        <ErrorState title="Could not load gaps." message={gapsRes.error} onRetry={gapsRes.reload} />
      ) : !page ? (
        <div className="source-card">
          <Skeleton label="Loading gaps…" lines={5} />
        </div>
      ) : gaps.length === 0 && !hasPrevious ? (
        <EmptyState
          icon="gaps"
          title="No unanswered questions"
          description="When a visitor asks something your content does not cover, the question shows up here, grouped with others asked the same way. Writing an answer adds it to your sources, so the next visitor gets a real reply."
          action={
            <ScreenLink to="/admin/conversations" className="btn btn-secondary">
              Read conversations
            </ScreenLink>
          }
        />
      ) : (
        <div className="stack">
          {gaps.length === 0 ? (
            <p className="muted">No unanswered questions on this page.</p>
          ) : (
            <ul className="gap-list">
              {gaps.map((gap) => {
                const title = gapTitle(gap);
                return (
                  <li key={gap.exampleMessageId} className="source-card gap-item">
                    <div className="gap-row">
                      <div className="gap-text">
                        <div className="source-title">{title}</div>
                        <div className="source-meta">
                          <span className="badge badge-warn">
                            {gap.times === 1 ? "Asked 1 time" : `Asked ${gap.times} times`}
                          </span>
                          <span>
                            Last asked <RelativeTime value={gap.lastAsked} />
                          </span>
                        </div>
                      </div>
                      <div className="actions gap-actions">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          aria-expanded={answering?.gapKey === gap.question}
                          onClick={() => startAnswer(gap)}
                        >
                          Write an answer
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setAnswering(null);
                            setStatusMessage(null);
                            setAddingTest({
                              sessionId: nextTestSessionId.current++,
                              gapKey: gap.question,
                            });
                          }}
                        >
                          Add to tests
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          aria-label={`Dismiss “${title}”`}
                          disabled={busyKey === gap.question}
                          onClick={() => void dismiss(gap)}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>

                    {answering?.gapKey === gap.question && editorFor(answering)}

                    {addingTest?.gapKey === gap.question &&
                      (() => {
                        const sessionId = addingTest.sessionId;
                        return (
                          <TestEditor
                            key={sessionId}
                            assistantId={assistantId}
                            initialQuestion={title}
                            onSaved={() => {
                              setAddingTest((current) =>
                                current?.sessionId === sessionId ? null : current,
                              );
                              setStatusMessage("Added to tests.");
                            }}
                            onCancel={() => setAddingTest(null)}
                          />
                        );
                      })()}
                  </li>
                );
              })}
            </ul>
          )}

          {(hasPrevious || hasNext) && (
            <nav className="actions pager" aria-label="Pages">
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
            </nav>
          )}
        </div>
      )}
    </div>
  );
}
