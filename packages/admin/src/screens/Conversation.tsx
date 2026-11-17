import { useRef, useState } from "react";
import type { ConversationDetail, ConversationTurn } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { navigateTo } from "../routing.js";
import { isSafeHttpUrl } from "../safeUrl.js";
import { ErrorState } from "../ui/ErrorState.js";
import { formatDateTime } from "../ui/format.js";
import { Icon } from "../ui/Icon.js";
import { PageHeader } from "../ui/PageHeader.js";
import { Skeleton } from "../ui/Skeleton.js";
import { StatusBadge } from "../ui/StatusBadge.js";
import { TestEditor } from "./TestEditor.js";

export interface ConversationProps {
  assistantId: string;
  conversationId: string;
  onBack: () => void;
}

/** Where "Write an answer for this" goes: Gaps, with the editor open and filled in. */
export function gapAnswerPath(fromMessageId: string, question: string): string {
  const params = new URLSearchParams({ answer: fromMessageId, question });
  return `/admin/gaps?${params.toString()}`;
}

function Timestamp({ value }: { value: number }) {
  return (
    <time className="turn-time" dateTime={new Date(value).toISOString()}>
      {formatDateTime(value)}
    </time>
  );
}

function TurnBody({ turn }: { turn: ConversationTurn }) {
  const safeCitations = turn.citations.filter((c) => isSafeHttpUrl(c.url));
  return (
    <>
      <div className="turn-content">{turn.content}</div>

      {safeCitations.length > 0 && (
        <div className="turn-sources">
          <span className="turn-sources-label">Sources</span>
          <ul className="turn-citations" aria-label="Sources">
            {safeCitations.map((c) => (
              <li key={c.url}>
                <a href={c.url} target="_blank" rel="noreferrer">
                  {c.title || c.url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {turn.toolCalls && turn.toolCalls.length > 0 && (
        <ul className="turn-citations" aria-label="What the assistant did">
          {turn.toolCalls.map((call) => (
            <li key={call.callId}>
              {/* Name and outcome only: the stored row holds no result body, by
                  design — a third party's payload is not the owner's to keep. */}
              {call.kind === "action" ? "On the page: " : "Tool: "}
              {call.name}
              {call.pending ? " — waiting" : call.ok ? "" : " — did not work"}
            </li>
          ))}
        </ul>
      )}

      {turn.feedback.length > 0 && (
        <div className="source-meta">
          {turn.feedback.map((fb) => (
            <StatusBadge key={fb.id} tone={fb.value === "up" ? "success" : "danger"}>
              {fb.value === "up" ? "Helpful" : "Not helpful"}
              {fb.note ? `: ${fb.note}` : ""}
            </StatusBadge>
          ))}
        </div>
      )}
    </>
  );
}

export function Conversation({ assistantId, conversationId, onBack }: ConversationProps) {
  const detailRes = useResource<ConversationDetail>(`/api/admin/conversations/${conversationId}`);
  const [addingTest, setAddingTest] = useState<{
    sessionId: number;
    turnId: string;
    question: string;
  } | null>(null);
  const nextTestSessionId = useRef(1);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // The detail is read by id alone. A link without its assistant (or naming
  // the wrong one) can load another assistant's conversation; it is not shown
  // here, so its actions cannot write to the assistant now selected.
  const loaded = detailRes.value;
  const otherAssistant = loaded !== undefined && loaded.conversation.assistantId !== assistantId;
  const detail = otherAssistant ? undefined : loaded;

  /**
   * The question a reply answered. The engine records it on the reply, and
   * that link is the only reliable one: two requests in one conversation can
   * interleave, so the nearest preceding question may belong to the other
   * request. The scan backwards is kept only for replies stored before the
   * link existed.
   */
  function findQuestionForTurn(index: number): { id: string; content: string } | null {
    if (!detail) return null;
    const reply = detail.turns[index];
    if (reply?.replyTo) {
      const question = detail.turns.find((t) => t.id === reply.replyTo && t.role === "user");
      return question ? { id: question.id, content: question.content } : null;
    }
    for (let i = index - 1; i >= 0; i--) {
      const turn = detail.turns[i];
      if (turn?.role === "user") {
        return { id: turn.id, content: turn.content };
      }
    }
    return null;
  }

  const pageUrl = detail?.conversation.pageUrl;
  return (
    <div className="screen screen-medium">
      <PageHeader
        title="Conversation"
        description={
          detail
            ? `Started ${formatDateTime(detail.conversation.startedAt)}${pageUrl ? ` on ${pageUrl}` : ""}.`
            : undefined
        }
        actions={
          <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>
            Back to conversations
          </button>
        }
      />

      {statusMessage && (
        <p className="notice-text" role="status">
          {statusMessage}
        </p>
      )}

      {detailRes.status === "error" ? (
        <ErrorState
          title="Could not load this conversation."
          message={detailRes.error}
          onRetry={detailRes.reload}
        />
      ) : otherAssistant ? (
        <p className="notice notice-info" role="status">
          This conversation belongs to another assistant. Switch to that assistant to read it.
        </p>
      ) : !detail ? (
        <div className="source-card">
          <Skeleton label="Loading conversation…" lines={5} />
        </div>
      ) : (
        <ol className="transcript" aria-label="Messages">
          {detail.turns.map((turn, index) => {
            const isUser = turn.role === "user";
            const questionTurn = findQuestionForTurn(index);
            const isUnanswered = !isUser && !turn.answered;

            return (
              <li
                key={turn.id}
                className={isUser ? "turn turn-user" : isUnanswered ? "turn turn-gap" : "turn"}
              >
                <div className="turn-header">
                  <span className="turn-role">
                    <Icon name={isUser ? "chat" : "conversations"} size={14} />
                    {isUser ? "Visitor" : "Assistant"}
                  </span>
                  {isUnanswered && !turn.answerDocumentId && (
                    <StatusBadge tone="warning">Unanswered</StatusBadge>
                  )}
                  {isUnanswered && turn.answerDocumentId && (
                    <StatusBadge tone="success">Answer written</StatusBadge>
                  )}
                  <Timestamp value={turn.createdAt} />
                </div>
                <TurnBody turn={turn} />

                {!isUser && (
                  <div className="actions">
                    {isUnanswered && !turn.answerDocumentId && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() =>
                          // The reply's own id: the engine links the answer
                          // through the question the reply records.
                          navigateTo(gapAnswerPath(turn.id, questionTurn?.content ?? ""))
                        }
                      >
                        Write an answer for this
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        setStatusMessage(null);
                        setAddingTest({
                          sessionId: nextTestSessionId.current++,
                          turnId: turn.id,
                          // The visitor's question, not the reply: a test is a
                          // question plus an expectation.
                          question: questionTurn?.content ?? "",
                        });
                      }}
                    >
                      Add to tests
                    </button>
                  </div>
                )}

                {addingTest?.turnId === turn.id &&
                  (() => {
                    const sessionId = addingTest.sessionId;
                    return (
                      <TestEditor
                        key={sessionId}
                        assistantId={assistantId}
                        initialQuestion={addingTest.question}
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
        </ol>
      )}
    </div>
  );
}
