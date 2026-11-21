import { useRef, useState } from "react";
import type { AnswerOutcome, ConversationDetail, ConversationTurn } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { useAdminNavigation } from "../routing.js";
import { isSafeHttpUrl } from "../safeUrl.js";
import { ErrorState } from "../ui/ErrorState.js";
import { formatDateTime } from "../ui/format.js";
import { Icon } from "../ui/Icon.js";
import { PageHeader } from "../ui/PageHeader.js";
import { Skeleton } from "../ui/Skeleton.js";
import { StatusBadge, type StatusTone } from "../ui/StatusBadge.js";
import { AnswerTrace } from "./AnswerTrace.js";
import { EntryEditor } from "./EntryEditor.js";
import { TestEditor } from "./TestEditor.js";

/** The answer review's outcome as a badge: short label, longer tooltip. */
export const OUTCOME_BADGES: Record<
  AnswerOutcome,
  { label: string; tone: StatusTone; title: string }
> = {
  answered: {
    label: "Answered",
    tone: "success",
    title: "Checked after sending: this reply gave what was asked.",
  },
  partial: {
    label: "Partly answered",
    tone: "info",
    title: "Checked after sending: this reply gave some of what was asked, or was unsure.",
  },
  declined: {
    label: "Could not answer",
    tone: "warning",
    title:
      "Checked after sending: content was found, but this reply still said it could not help. The content may be unclear.",
  },
  off_topic: {
    label: "Off topic",
    tone: "neutral",
    title:
      "Checked after sending: the question was not about this site. It is left out of Gaps and the answered share.",
  },
  wants_human: {
    label: "Asked for a person",
    tone: "info",
    title:
      "Checked after sending: the visitor asked for a person, a call back, or to complain. It is left out of Gaps.",
  },
};

export interface ConversationProps {
  assistantId: string;
  conversationId: string;
  onBack: () => void;
}

/**
 * Where "Write an answer for this" goes when Gaps is shown: Gaps, with the
 * editor open and filled in. It names the assistant, so once Gaps has taken
 * the question out of the address, a reload still shows this assistant.
 */
function gapAnswerPath(
  gapsPath: string,
  assistantId: string,
  fromMessageId: string,
  question: string,
): string {
  const params = new URLSearchParams({ answer: fromMessageId, question, assistant: assistantId });
  return `${gapsPath}?${params.toString()}`;
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
  // With no list under the answer (sources linked in the text, or none) the
  // visitor saw no list of sources; the owner still sees what the answer used.
  const sourcesLabel = turn.citationsShown === false ? "Used content" : "Sources";
  return (
    <>
      <div className="turn-content">{turn.content}</div>

      {safeCitations.length > 0 && (
        <div className="turn-sources">
          <span className="turn-sources-label">{sourcesLabel}</span>
          <ul className="turn-citations" aria-label={sourcesLabel}>
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
  // Only used when the host hides Gaps: the answer is then written here.
  const [answering, setAnswering] = useState<{
    sessionId: number;
    turnId: string;
    question: string;
  } | null>(null);
  const nextAnswerSessionId = useRef(1);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const { navigate, pathFor } = useAdminNavigation();
  const gapsPath = pathFor("gaps");

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
          detail={detailRes.error}
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
            // What Gaps lists, so it offers the same fixes: a reply the
            // review found declined, or an unreviewed one with no content.
            // A miss reviewed as off topic or asking for a person is not a gap.
            const outcome = turn.outcome ?? null;
            const isUnanswered =
              !isUser && (outcome === "declined" || (outcome === null && !turn.answered));
            // A miss that declined keeps the "Unanswered" badge below (no
            // content found); every other reviewed reply shows its outcome.
            const outcomeBadge =
              !isUser && outcome !== null && (turn.answered || outcome !== "declined")
                ? OUTCOME_BADGES[outcome]
                : null;

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
                  {!isUser && !turn.answered && isUnanswered && !turn.answerDocumentId && (
                    <StatusBadge tone="warning" title="No content was found for this question.">
                      Unanswered
                    </StatusBadge>
                  )}
                  {outcomeBadge && !(isUnanswered && turn.answerDocumentId) && (
                    <StatusBadge tone={outcomeBadge.tone} title={outcomeBadge.title}>
                      {outcomeBadge.label}
                    </StatusBadge>
                  )}
                  {isUnanswered && turn.answerDocumentId && (
                    <StatusBadge tone="success">Answer written</StatusBadge>
                  )}
                  <Timestamp value={turn.createdAt} />
                </div>
                <TurnBody turn={turn} />
                {!isUser && (
                  <AnswerTrace
                    assistantId={assistantId}
                    conversationId={detail.conversation.id}
                    messageId={turn.id}
                  />
                )}

                {!isUser && (
                  <div className="actions">
                    {isUnanswered && !turn.answerDocumentId && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => {
                          // The reply's own id: the engine links the answer
                          // through the question the reply records.
                          const question = questionTurn?.content ?? "";
                          if (gapsPath !== null) {
                            navigate(gapAnswerPath(gapsPath, assistantId, turn.id, question));
                            return;
                          }
                          // Gaps is hidden by the host: write the answer here.
                          setAddingTest(null);
                          setStatusMessage(null);
                          // Pressed again on the turn already being answered,
                          // it keeps what has been typed: a new session would
                          // remount the editor empty.
                          setAnswering((current) =>
                            current?.turnId === turn.id
                              ? current
                              : {
                                  sessionId: nextAnswerSessionId.current++,
                                  turnId: turn.id,
                                  question,
                                },
                          );
                        }}
                      >
                        Write an answer for this
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        setAnswering(null);
                        setStatusMessage(null);
                        // Pressed again on the same turn, it keeps the draft.
                        setAddingTest((current) =>
                          current?.turnId === turn.id
                            ? current
                            : {
                                sessionId: nextTestSessionId.current++,
                                turnId: turn.id,
                                // The visitor's question, not the reply: a test
                                // is a question plus an expectation.
                                question: questionTurn?.content ?? "",
                              },
                        );
                      }}
                    >
                      Add to tests
                    </button>
                  </div>
                )}

                {answering?.turnId === turn.id &&
                  (() => {
                    const sessionId = answering.sessionId;
                    return (
                      <EntryEditor
                        key={sessionId}
                        assistantId={assistantId}
                        fromMessageId={turn.id}
                        initialQuestion={answering.question}
                        onSaved={(_result, saved) => {
                          if (saved.assistantId !== assistantId) return;
                          // A save that ends after the editor was closed or
                          // reopened leaves the editor now open alone.
                          setAnswering((current) =>
                            current?.sessionId === sessionId ? null : current,
                          );
                          setStatusMessage(
                            "Answer saved to your sources. The assistant can use it once indexed.",
                          );
                          detailRes.reload();
                        }}
                        onCancel={() =>
                          setAnswering((current) =>
                            current?.sessionId === sessionId ? null : current,
                          )
                        }
                      />
                    );
                  })()}

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
