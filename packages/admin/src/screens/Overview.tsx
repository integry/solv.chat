import type { AssistantOverview, PeriodFigures } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { assistantPath } from "../routing.js";
import { ErrorState } from "../ui/ErrorState.js";
import { formatDate } from "../ui/format.js";
import { PageHeader } from "../ui/PageHeader.js";
import { ScreenLink } from "../ui/ScreenLink.js";
import { Skeleton } from "../ui/Skeleton.js";
import { questionConversationsPath } from "./conversationLinks.js";
import {
  costChange,
  countChange,
  formatCost,
  formatPercent,
  formatTimes,
  shareChange,
} from "./figures.js";
import { GettingStarted, NeedsAttention, QuestionsChart, StatCard } from "./OverviewParts.js";

export interface OverviewProps {
  assistantId: string;
}

const EMPTY_FIGURES: PeriodFigures = {
  from: "",
  to: "",
  questions: 0,
  replies: 0,
  answeredShare: 0,
  thumbsDownShare: 0,
  costMicros: 0,
};

function OverviewSkeleton() {
  return (
    <div className="stack" aria-busy="true">
      <Skeleton label="Loading overview…" lines={1} className="skeleton-heading" />
      <div className="overview-grid" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="source-card stat-card">
            <span className="skeleton-line" style={{ width: "50%" }} />
            <span className="skeleton-line skeleton-line-lg" style={{ width: "35%" }} />
            <span className="skeleton-line" />
          </div>
        ))}
      </div>
      <div className="source-card" aria-hidden="true">
        <span className="skeleton-block" />
      </div>
    </div>
  );
}

export function Overview({ assistantId }: OverviewProps) {
  const overviewRes = useResource<AssistantOverview>(
    `/api/admin/assistants/${assistantId}/overview`,
  );
  const overview = overviewRes.value;
  const period = overview?.period;
  const days = period?.days ?? 7;
  const current = period ?? EMPTY_FIGURES;
  const previous = period?.previous ?? EMPTY_FIGURES;
  const unit = overview?.costUnit;

  return (
    <div className="screen screen-wide">
      <PageHeader
        title="Overview"
        description={
          period
            ? `Last ${days} days, ${formatDate(period.from)} to ${formatDate(period.to)}, compared with the ${days} days before.`
            : "How your assistant is doing."
        }
      />

      {overviewRes.status === "error" ? (
        <ErrorState
          title="Could not load the overview."
          detail={overviewRes.error}
          onRetry={overviewRes.reload}
        />
      ) : !overview ? (
        <OverviewSkeleton />
      ) : (
        <div className="stack">
          <NeedsAttention assistantId={assistantId} overview={overview} />
          {overview.setup && <GettingStarted assistantId={assistantId} setup={overview.setup} />}

          <div className="overview-grid overview-grid-4">
            <StatCard
              label="Questions asked"
              value={String(current.questions)}
              explanation="Questions visitors asked."
              change={period ? countChange(current.questions, previous.questions, days) : undefined}
            />
            <StatCard
              label="Answered share"
              value={formatPercent(current.answeredShare)}
              explanation="Share of answers your assistant could give from your content."
              change={
                period
                  ? shareChange(current.answeredShare, previous.answeredShare, days)
                  : undefined
              }
            />
            <StatCard
              label="Marked not helpful"
              value={formatPercent(current.thumbsDownShare)}
              explanation="Share of answers a visitor said did not help."
              change={
                period
                  ? shareChange(current.thumbsDownShare, previous.thumbsDownShare, days)
                  : undefined
              }
            />
            <StatCard
              label="Cost"
              value={formatCost(current.costMicros, unit)}
              explanation={
                overview.dailyCostCapMicros !== undefined
                  ? overview.dailyCostCapMicros > 0
                    ? `Today so far: ${formatCost(overview.todayCostMicros, unit)}. Daily spend cap: ${formatCost(overview.dailyCostCapMicros, unit)}.`
                    : `Today so far: ${formatCost(overview.todayCostMicros, unit)}. No daily spend cap.`
                  : `Today so far: ${formatCost(overview.todayCostMicros, unit)}.`
              }
              change={
                period ? costChange(current.costMicros, previous.costMicros, days, unit) : undefined
              }
            >
              {overview.todayCostUnknown && (
                <p className="error-text" role="alert">
                  Cost is not being reported for this model, so the daily spend cap cannot protect
                  this instance.
                </p>
              )}
            </StatCard>
          </div>

          <div className="overview-columns">
            {overview.daily && <QuestionsChart daily={overview.daily} />}

            <section className="source-card stack" aria-labelledby="top-questions-heading">
              <div>
                <h2 id="top-questions-heading" className="section-heading">
                  Most asked questions
                </h2>
                <p className="muted">Since the start. Open one to read those conversations.</p>
              </div>
              {overview.topQuestions.length === 0 ? (
                <p className="muted">No questions asked yet.</p>
              ) : (
                <ul className="history-list">
                  {overview.topQuestions.map((item) => (
                    <li key={item.question} className="history-item">
                      <ScreenLink to={questionConversationsPath(assistantId, item.question)}>
                        {item.question}
                      </ScreenLink>
                      <span className="badge">{formatTimes(item.count)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <ScreenLink to={assistantPath("/admin/reports", assistantId)} className="more-link">
                See Reports
              </ScreenLink>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
