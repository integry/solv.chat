import { useEffect, useRef, useState } from "react";
import { ApiError, postJson } from "../api/client.js";
import type { GapSummary, GapsPage } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { assistantPath, dropQueryParams, readQueryParam } from "../routing.js";
import { RelativeTime } from "../ui/DateText.js";
import { EmptyState } from "../ui/EmptyState.js";
import { ErrorState } from "../ui/ErrorState.js";
import { PageHeader } from "../ui/PageHeader.js";
import { ScreenLink } from "../ui/ScreenLink.js";
import { Skeleton } from "../ui/Skeleton.js";
import { useToast } from "../ui/Toast.js";
import { type EntryDraft, EntryEditor } from "./EntryEditor.js";
import { type TestDraft, TestEditor } from "./TestEditor.js";

export interface GapsProps {
  assistantId: string;
}

const PAGE_SIZE = 25;

/**
 * The editor is open for one gap row, or for a question handed over from a
 * conversation. The screen holds the typed text, not the editor: the list a
 * row sits in can be replaced by an error, or the row can move to another
 * page, and the draft must outlive both.
 */
interface AnswerSession {
  fromMessageId: string;
  /** Set when it belongs to a row in the list; null for a handed-over question. */
  gapKey: string | null;
  draft: EntryDraft;
}

interface TestSession {
  sessionId: number;
  gapKey: string;
  draft: TestDraft;
}

/** "Write an answer for this" in a conversation lands here with `?answer=…&question=…`. */
function readHandedOverAnswer(): AnswerSession | null {
  const fromMessageId = readQueryParam("answer");
  if (!fromMessageId) return null;
  return {
    fromMessageId,
    gapKey: null,
    draft: { question: readQueryParam("question") ?? "", answer: "" },
  };
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
  const [addingTest, setAddingTest] = useState<TestSession | null>(null);
  const nextTestSessionId = useRef(1);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<GapSummary | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // The handed-over question is now in state; drop it from the address so a
  // reload does not open the editor again. The assistant stays named, so the
  // reload shows this assistant's gaps and not the first one's.
  useEffect(() => {
    dropQueryParams(["answer", "question"]);
  }, []);

  const page = gapsRes.value;
  const gaps = page?.gaps ?? [];
  const hasPrevious = offset > 0;
  const hasNext = page ? offset + page.limit < page.total : false;

  // Rows on screen right now. An open editor sits under its row when the row
  // is here, and above the list when it is not (the list failed to load, or
  // the gap moved to another page), so its draft stays in view either way.
  const listedKeys = new Set(
    gapsRes.status === "error" || !page ? [] : gaps.map((g) => g.question),
  );
  const answeringInList = answering?.gapKey != null && listedKeys.has(answering.gapKey);
  const addingTestInList = addingTest !== null && listedKeys.has(addingTest.gapKey);

  function startAnswer(gap: GapSummary) {
    setAddingTest(null);
    setStatusMessage(null);
    // Pressing the button again on the gap already being answered keeps what
    // has been typed; only a different gap starts a fresh draft.
    setAnswering((current) =>
      current?.gapKey === gap.question
        ? current
        : {
            fromMessageId: gap.exampleMessageId,
            gapKey: gap.question,
            draft: { question: gapTitle(gap), answer: "" },
          },
    );
  }

  function startTest(gap: GapSummary) {
    setAnswering(null);
    setStatusMessage(null);
    setAddingTest({
      sessionId: nextTestSessionId.current++,
      gapKey: gap.question,
      draft: { question: gapTitle(gap), kind: "contains", detail: "" },
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
      // Read the editors as they are now, not as they were when Dismiss was
      // pressed: another gap's editor may have opened while this waited.
      setAnswering((current) => (current?.gapKey === gap.question ? null : current));
      setAddingTest((current) => (current?.gapKey === gap.question ? null : current));
      gapsRes.reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not dismiss. Try again.");
    } finally {
      setBusyKey((current) => (current === gap.question ? null : current));
    }
  }

  async function undoDismiss(gap: GapSummary) {
    setBusyKey(gap.question);
    try {
      await postJson(`/api/admin/assistants/${assistantId}/gaps/restore`, {
        question: gap.question,
      });
      // Another gap may have been dismissed while this waited; keep its Undo.
      setDismissed((current) => (current === gap ? null : current));
      gapsRes.reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not undo. Try again.");
    } finally {
      setBusyKey((current) => (current === gap.question ? null : current));
    }
  }

  function editorFor(session: AnswerSession) {
    return (
      <EntryEditor
        assistantId={assistantId}
        fromMessageId={session.fromMessageId}
        draft={session.draft}
        onDraftChange={(draft) =>
          setAnswering((current) =>
            current?.fromMessageId === session.fromMessageId ? { ...current, draft } : current,
          )
        }
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

  function testEditorFor(session: TestSession) {
    const sessionId = session.sessionId;
    return (
      <TestEditor
        key={sessionId}
        assistantId={assistantId}
        draft={session.draft}
        onDraftChange={(draft) =>
          setAddingTest((current) =>
            current?.sessionId === sessionId ? { ...current, draft } : current,
          )
        }
        onSaved={() => {
          setAddingTest((current) => (current?.sessionId === sessionId ? null : current));
          setStatusMessage("Added to tests.");
        }}
        onCancel={() => setAddingTest(null)}
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

      {answering && !answeringInList && editorFor(answering)}
      {addingTest && !addingTestInList && testEditorFor(addingTest)}

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
            <ScreenLink
              to={assistantPath("/admin/conversations", assistantId)}
              className="btn btn-secondary"
            >
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
                          onClick={() => startTest(gap)}
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

                    {addingTest?.gapKey === gap.question && testEditorFor(addingTest)}
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
