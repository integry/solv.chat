import { useState } from "react";
import type { ConversationDetail } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { EntryEditor } from "./EntryEditor.js";

export interface ConversationProps {
  assistantId: string;
  conversationId: string;
  onBack: () => void;
}

function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function Conversation({ assistantId, conversationId, onBack }: ConversationProps) {
  const detailRes = useResource<ConversationDetail>(`/api/admin/conversations/${conversationId}`);
  const [answering, setAnswering] = useState<{
    turnId: string;
    fromMessageId: string;
    question: string;
  } | null>(null);

  const detail = detailRes.value;

  function findQuestionForTurn(index: number): { id: string; content: string } | null {
    if (!detail) return null;
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

                {isUnanswered && (
                  <div className="actions">
                    {turn.answerDocumentId ? (
                      <span className="badge badge-published">Handled</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() =>
                          setAnswering({
                            turnId: turn.id,
                            fromMessageId: questionTurn?.id ?? turn.id,
                            question: questionTurn?.content ?? "",
                          })
                        }
                      >
                        Write the right answer
                      </button>
                    )}
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
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
