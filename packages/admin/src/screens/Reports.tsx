import { type ReactNode, useState } from "react";
import type { AssistantReport, TopQuestion } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { buildCsv } from "../csv.js";
import { assistantPath } from "../routing.js";
import { isSafeHttpUrl } from "../safeUrl.js";
import { EmptyState } from "../ui/EmptyState.js";
import { ErrorState } from "../ui/ErrorState.js";
import { formatDate } from "../ui/format.js";
import { PageHeader } from "../ui/PageHeader.js";
import { ScreenLink } from "../ui/ScreenLink.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { Skeleton } from "../ui/Skeleton.js";
import { questionConversationsPath } from "./conversationLinks.js";
import { formatCost, formatPercent, formatTimes } from "./figures.js";

export interface ReportsProps {
  assistantId: string;
}

/** The three the specification names. */
const RANGES = [7, 30, 90] as const;

const formatUsd = (costMicros: number) => formatCost(costMicros, "usd");

function csvFor(report: AssistantReport): string {
  return buildCsv([
    {
      title: `Report ${report.from} to ${report.to}`,
      header: ["Figure", "Value"],
      rows: [
        ["Questions asked", report.questions],
        ["Answers given", report.replies],
        ["Answered share", formatPercent(report.answeredShare)],
        ["Marked not helpful", formatPercent(report.thumbsDownShare)],
        ["Cost", formatUsd(report.costMicros)],
      ],
    },
    {
      title: "Most asked questions",
      header: ["Question", "Times"],
      rows: report.topQuestions.map((item) => [item.question, item.count]),
    },
    {
      title: "Most often unanswered",
      header: ["Question", "Times"],
      rows: report.topGaps.map((item) => [item.question, item.count]),
    },
    {
      title: "Pages used most",
      header: ["Page", "Address", "Times"],
      rows: report.topSources.map((item) => [item.title, item.url, item.count]),
    },
    {
      title: "Pages never used",
      header: ["Page", "Address"],
      rows: report.uncitedSources.map((item) => [item.title, item.url]),
    },
  ]);
}

function NoneInPeriod() {
  return <EmptyState size="compact" icon="inbox" title="None in this period" headingLevel={3} />;
}

function ReportList({
  heading,
  explanation,
  empty,
  children,
  footer,
}: {
  heading: string;
  explanation: string;
  empty: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="source-card stack" aria-label={heading}>
      <div>
        <h2 className="section-heading">{heading}</h2>
        <p className="muted">{explanation}</p>
      </div>
      {empty ? <NoneInPeriod /> : <ul className="history-list">{children}</ul>}
      {footer}
    </section>
  );
}

function QuestionTable({
  heading,
  explanation,
  rows,
  linkTo,
}: {
  heading: string;
  explanation: string;
  rows: readonly TopQuestion[];
  linkTo: (question: string) => string;
}) {
  return (
    <ReportList heading={heading} explanation={explanation} empty={rows.length === 0}>
      {rows.map((item) => (
        <li key={item.question} className="history-item">
          <ScreenLink to={linkTo(item.question)}>{item.question}</ScreenLink>
          <span className="badge">{formatTimes(item.count)}</span>
        </li>
      ))}
    </ReportList>
  );
}

function PageLink({ url, title }: { url: string; title: string }) {
  // Filtered like every other citation link in the admin: the URL came from
  // ingested content.
  return isSafeHttpUrl(url) ? (
    <a href={url} target="_blank" rel="noreferrer">
      {title || url}
    </a>
  ) : (
    <span>{title || url}</span>
  );
}

function ReportSkeleton() {
  return (
    <div className="stack" aria-busy="true">
      <Skeleton label="Loading report…" lines={1} className="skeleton-heading" />
      <div className="overview-grid overview-grid-4" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="source-card stat-card">
            <span className="skeleton-line" style={{ width: "50%" }} />
            <span className="skeleton-line skeleton-line-lg" style={{ width: "35%" }} />
            <span className="skeleton-line" />
          </div>
        ))}
      </div>
      <div className="source-card" aria-hidden="true">
        <span className="skeleton-line" />
        <span className="skeleton-line" />
        <span className="skeleton-line" style={{ width: "60%" }} />
      </div>
    </div>
  );
}

const RANGE_OPTIONS = RANGES.map((value) => ({ value, label: `${value} days` }));

export function Reports({ assistantId }: ReportsProps) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const reportRes = useResource<AssistantReport>(
    `/api/admin/assistants/${assistantId}/report?days=${days}`,
  );
  // Ignore a retained report from another period (or while a refetch is in
  // flight) so stale figures and CSV exports are never shown for the new range.
  const report =
    reportRes.status !== "loading" && reportRes.value?.days === days ? reportRes.value : undefined;

  function download(): void {
    if (!report) return;
    const blob = new Blob([csvFor(report)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `solv-report-${report.from}-to-${report.to}.csv`;
    link.click();
    // Revoked immediately: an object URL held for the life of the page keeps
    // the whole blob in memory for nothing.
    URL.revokeObjectURL(url);
  }

  const empty =
    report !== undefined &&
    report.questions === 0 &&
    report.replies === 0 &&
    report.costMicros === 0;

  return (
    <div className="screen screen-wide">
      <PageHeader
        title="Reports"
        description={
          report
            ? `How your assistant did from ${formatDate(report.from)} to ${formatDate(report.to)}.`
            : "How your assistant did over time."
        }
        actions={
          <>
            <SegmentedControl
              label="Period"
              options={RANGE_OPTIONS}
              value={days}
              onChange={(next) => setDays(next)}
            />
            {/* Offered only with something to download: an empty CSV is a
                support question, not a feature. */}
            {report && !empty && (
              <button
                type="button"
                className="btn btn-secondary"
                aria-describedby="report-csv-hint"
                onClick={download}
              >
                Download CSV
              </button>
            )}
          </>
        }
      />
      {report && !empty && (
        <p id="report-csv-hint" className="muted report-csv-hint">
          The CSV holds the four figures and the four lists below, for {formatDate(report.from)} to{" "}
          {formatDate(report.to)}.
        </p>
      )}

      {reportRes.status === "error" ? (
        <ErrorState
          title="Could not load the report."
          detail={reportRes.error}
          onRetry={reportRes.reload}
        />
      ) : !report ? (
        <ReportSkeleton />
      ) : empty ? (
        <EmptyState
          icon="reports"
          title="Nothing yet for this period"
          description="Once visitors ask questions, their answers show up here."
        />
      ) : (
        <div className="stack">
          <div className="overview-grid overview-grid-4">
            <section className="source-card stat-card" aria-label="Questions asked">
              <div className="stat-label">Questions asked</div>
              <div className="stat-value">{report.questions}</div>
              <p className="muted">How many questions visitors asked in this period.</p>
            </section>
            <section className="source-card stat-card" aria-label="Answered share">
              <div className="stat-label">Answered share</div>
              <div className="stat-value">{formatPercent(report.answeredShare)}</div>
              <p className="muted">Share of answers your assistant could give from your content.</p>
            </section>
            <section className="source-card stat-card" aria-label="Marked not helpful">
              <div className="stat-label">Marked not helpful</div>
              <div className="stat-value">{formatPercent(report.thumbsDownShare)}</div>
              <p className="muted">Share of answers a visitor said did not help.</p>
            </section>
            <section className="source-card stat-card" aria-label="Cost">
              <div className="stat-label">Cost</div>
              <div className="stat-value">{formatUsd(report.costMicros)}</div>
              <p className="muted">Estimated cost for this period.</p>
            </section>
          </div>

          <div className="report-columns">
            <QuestionTable
              heading="Most asked questions"
              explanation="What visitors want to know. Open one to read those conversations."
              rows={report.topQuestions}
              linkTo={(question) => questionConversationsPath(assistantId, question)}
            />
            <QuestionTable
              heading="Most often unanswered"
              explanation="Write an answer for these on the Gaps screen."
              rows={report.topGaps}
              linkTo={() => assistantPath("/admin/gaps", assistantId)}
            />

            <ReportList
              heading="Pages used most"
              explanation="The content your assistant answers from."
              empty={report.topSources.length === 0}
            >
              {report.topSources.map((item) => (
                <li key={item.url} className="history-item">
                  <PageLink url={item.url} title={item.title} />
                  <span className="badge">{formatTimes(item.count)}</span>
                </li>
              ))}
            </ReportList>

            <ReportList
              heading="Pages never used"
              explanation="Nobody was shown these in this period. They may be out of date, or nobody asks about them."
              empty={report.uncitedSources.length === 0}
              footer={
                report.uncitedTotal > report.uncitedSources.length ? (
                  <p className="muted">
                    and {report.uncitedTotal - report.uncitedSources.length} more
                  </p>
                ) : null
              }
            >
              {report.uncitedSources.map((item) => (
                <li key={item.url} className="history-item">
                  <PageLink url={item.url} title={item.title} />
                </li>
              ))}
            </ReportList>
          </div>
        </div>
      )}
    </div>
  );
}
