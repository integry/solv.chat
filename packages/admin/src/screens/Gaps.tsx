import { useState } from "react";
import type { GapSummary } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { EntryEditor } from "./EntryEditor.js";

export interface GapsProps {
  assistantId: string;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function Gaps({ assistantId }: GapsProps) {
  const gapsRes = useResource<{ gaps: GapSummary[] }>(`/api/admin/assistants/${assistantId}/gaps`);
  const [editingGap, setEditingGap] = useState<GapSummary | null>(null);

  const gaps = gapsRes.value?.gaps ?? [];

  return (
    <div className="screen">
      <div className="screen-header">
        <div>
          <h1>Gaps</h1>
          <p className="muted">
            Questions your assistant could not answer yet. Write an answer to add it to your
            sources.
          </p>
        </div>
      </div>

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

      {gapsRes.status === "loading" && !gapsRes.value ? (
        <p className="muted">Loading gaps…</p>
      ) : gapsRes.status === "error" ? (
        <p className="error-text" role="alert">
          {gapsRes.error}
        </p>
      ) : gaps.length === 0 ? (
        <p className="muted">No unanswered questions yet.</p>
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
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setEditingGap(gap)}
                >
                  Write the right answer
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
