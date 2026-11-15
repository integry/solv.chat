import { useRef, useState } from "react";
import type { ConversationDetail } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { isSafeHttpUrl } from "../safeUrl.js";
import { EntryEditor } from "./EntryEditor.js";
import { TestEditor } from "./TestEditor.js";

export interface ConversationProps {
  assistantId: string;
  conversationId: string;
  onBack: () => void;
}

export function Conversation({ assistantId, conversationId, onBack }: ConversationProps) {
  const detailRes = useResource<ConversationDetail>(`/api/admin/conversations/${conversationId}`);
  const [answering, setAnswering] = useState<{
    turnId: string;
    fromMessageId: string;
    question: string;
  } | null>(null);
  const [addingTest, setAddingTest] = useState<{
    sessionId: number;
    turnId: string;
    question: string;
  } | null>(null);
  const nextTestSessionId = useRef(1);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const detail = detailRes.value;

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

  return (
    <div className="screen">
      <div className="screen-header">
        <div>
          <h1>Conversation</h1>
          {detail?.conversation.pageUrl && (
            <p className="muted">Page: {detail.conversation.pageUrl}</p>
          )}
        </div>
        <div className="screen-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>
            Back to conversations
          </button>
        </div>
      </div>

      {statusMessage && (
        <p className="notice-text" role="status">
          {statusMessage}
        </p>
      )}

      {detailRes.status === "loading" && !detail ? (
        <p className="muted">Loading conversation…</p>
      ) : detailRes.status === "error" ? (
        <p className="error-text" role="alert">
          {detailRes.error}
        </p>
      ) : detail ? (
        <div className="stack">
          {detail.turns.map((turn, index) => {
            const isUser = turn.role === "user";
            const safeCitations = turn.citations.filter((c) => isSafeHttpUrl(c.url));
            const questionTurn = findQuestionForTurn(index);
            const isUnanswered = !isUser && !turn.answered;

            return (
              <div key={turn.id} className={isUser ? "turn turn-user" : "turn"}>
                <div className="turn-role">{isUser ? "Visitor" : "Assistant"}</div>
                <div className="turn-content">{turn.content}</div>

                {safeCitations.length > 0 && (
                  <ul className="turn-citations">
                    {safeCitations.map((c) => (
                      <li key={c.url}>
                        <a href={c.url} target="_blank" rel="noreferrer">
                          {c.title || c.url}
                        </a>
                      </li>
                    ))}
                  </ul>
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
                      <span key={fb.id} className="badge">
                        {fb.value === "up" ? "Helpful" : "Not helpful"}
                        {fb.note ? `: ${fb.note}` : ""}
                      </span>
                    ))}
                  </div>
                )}

                {!isUser && (
                  <div className="actions">
                    {isUnanswered &&
                      (turn.answerDocumentId ? (
                        <span className="badge badge-published">Handled</span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setAddingTest(null);
                            setStatusMessage(null);
                            setAnswering({
                              turnId: turn.id,
                              // The reply's own id: the engine links the
                              // answer through the question the reply records.
                              fromMessageId: turn.id,
                              question: questionTurn?.content ?? "",
                            });
                          }}
                        >
                          Write the right answer
                        </button>
                      ))}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        setAnswering(null);
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

                {answering?.turnId === turn.id && (
                  <EntryEditor
                    assistantId={assistantId}
                    fromMessageId={answering.fromMessageId}
                    initialQuestion={answering.question}
                    onSaved={(_result, session) => {
                      if (session.assistantId !== assistantId) return;
                      setAnswering((current) =>
                        current?.fromMessageId === session.fromMessageId ? null : current,
                      );
                      detailRes.reload();
                    }}
                    onCancel={() => setAnswering(null)}
                  />
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
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
