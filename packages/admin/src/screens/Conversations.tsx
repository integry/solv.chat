import { useState } from "react";
import type { ConversationsPage } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { EmptyState } from "../ui/EmptyState.js";
import { formatDateTime } from "../ui/format.js";
import { PageHeader } from "../ui/PageHeader.js";
import { Conversation } from "./Conversation.js";

export interface ConversationsProps {
  assistantId: string;
}

const PAGE_SIZE = 25;

function formatDate(timestamp: number): string {
  return formatDateTime(timestamp);
}

export function Conversations({ assistantId }: ConversationsProps) {
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listRes = useResource<ConversationsPage>(
    `/api/admin/assistants/${assistantId}/conversations?limit=${PAGE_SIZE}&offset=${offset}`,
  );

  if (selectedId !== null) {
    return (
      <Conversation
        assistantId={assistantId}
        conversationId={selectedId}
        onBack={() => {
          setSelectedId(null);
          listRes.reload();
        }}
      />
    );
  }

  const page = listRes.value;
  const hasPrevious = offset > 0;
  const hasNext = page ? offset + page.limit < page.total : false;

  return (
    <div className="screen">
      <PageHeader
        title="Conversations"
        description="Read what visitors asked and how your assistant replied."
      />

      {listRes.status === "loading" && !page ? (
        <p className="muted">Loading conversations…</p>
      ) : listRes.status === "error" ? (
        <p className="error-text" role="alert">
          {listRes.error}
        </p>
      ) : page && page.conversations.length === 0 ? (
        <EmptyState
          icon="conversations"
          title="No conversations yet"
          description="When visitors chat on your site, their conversations show up here."
        />
      ) : page ? (
        <div className="stack">
          <ul className="history-list">
            {page.conversations.map((conv) => (
              <li key={conv.id} className="source-card stack">
                <div className="source-header">
                  <div>
                    <div className="source-title">
                      {conv.firstQuestion ?? "Conversation without a question"}
                    </div>
                    <div className="source-meta">
                      <span>
                        {conv.turnCount === 1 ? "1 message" : `${conv.turnCount} messages`}
                      </span>
                      <span>Started {formatDate(conv.startedAt)}</span>
                      {conv.hasUnanswered && <span className="badge badge-warn">Unanswered</span>}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setSelectedId(conv.id)}
                  >
                    Open
                  </button>
                </div>
              </li>
            ))}
          </ul>

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
      ) : null}
    </div>
  );
}
