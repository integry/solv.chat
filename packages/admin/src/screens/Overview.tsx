import type { AssistantOverview } from "../api/types.js";
import { useResource } from "../api/useResource.js";

export interface OverviewProps {
  assistantId: string;
}

function formatUsd(costMicros: number): string {
  const dollars = costMicros / 1_000_000;
  if (costMicros > 0 && dollars < 0.01) {
    return "< $0.01";
  }
  return `$${dollars.toFixed(2)}`;
}

function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function Overview({ assistantId }: OverviewProps) {
  const overviewRes = useResource<AssistantOverview>(
    `/api/admin/assistants/${assistantId}/overview`,
  );

  return (
    <div className="screen">
      <div className="screen-header">
        <div>
          <h1>Overview</h1>
          <p className="muted">How your assistant is doing.</p>
        </div>
      </div>

      {overviewRes.status === "loading" && !overviewRes.value ? (
        <p className="muted">Loading overview…</p>
      ) : overviewRes.status === "error" ? (
        <p className="error-text" role="alert">
          {overviewRes.error}
        </p>
      ) : overviewRes.value ? (
        <div className="stack">
          <div className="overview-grid">
            <section className="source-card stack" aria-label="Messages">
              <div className="stat-label">Messages</div>
              <div className="stat-value">{overviewRes.value.messages}</div>
              <p className="muted">Total questions and replies across all conversations.</p>
            </section>

            <section className="source-card stack" aria-label="Answered share">
              <div className="stat-label">Answered share</div>
              <div className="stat-value">{formatPercent(overviewRes.value.answeredShare)}</div>
              <p className="muted">
                Share of questions your assistant could answer from your content.
              </p>
            </section>

            <section className="source-card stack" aria-label="Today's cost">
              <div className="stat-label">Today&apos;s cost</div>
              <div className="stat-value">{formatUsd(overviewRes.value.todayCostMicros)}</div>
              <p className="muted">Estimated cost so far today.</p>
            </section>
          </div>

          <section className="source-card stack" aria-label="Top questions">
            <div>
              <h2 className="section-heading">Top questions</h2>
              <p className="muted">Questions visitors ask most often.</p>
            </div>
            {overviewRes.value.topQuestions.length === 0 ? (
              <p className="muted">No questions asked yet.</p>
            ) : (
              <ul className="history-list">
                {overviewRes.value.topQuestions.map((item) => (
                  <li key={item.question} className="history-item">
                    <span>{item.question}</span>
                    <span className="badge">
                      {item.count === 1 ? "1 time" : `${item.count} times`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
