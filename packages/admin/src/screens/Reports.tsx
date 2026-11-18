import { type ReactNode, useState } from "react";
import type { AssistantReport, ResponseTimePeriod, TopQuestion } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { buildCsv } from "../csv.js";
import { ScreenLink, useAdminNavigation } from "../routing.js";
import { isSafeHttpUrl } from "../safeUrl.js";
import { EmptyState } from "../ui/EmptyState.js";
import { ErrorState } from "../ui/ErrorState.js";
import { formatDate } from "../ui/format.js";
import { PageHeader } from "../ui/PageHeader.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { questionConversationsQuery } from "./conversationLinks.js";
import {
  durationChange,
  formatCost,
  formatPercent,
  formatResponseTime,
  formatTimes,
  pageActionNote,
  responseTimeNote,
} from "./figures.js";
import { StatCard } from "./OverviewParts.js";
import { StatsSkeleton } from "./StatsSkeleton.js";

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
    ...(report.responseTime ? [responseTimeCsv(report.responseTime)] : []),
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

/** The three response-time figures, in the order and words the screen uses. */
const RESPONSE_FIGURES = [
  { key: "firstTokenMedianMs", label: "Answer starts appearing" },
  { key: "firstTokenP90Ms", label: "Slowest 1 in 10 start after" },
  { key: "totalMedianMs", label: "Full answer" },
] as const;

function responseTimeCsv(time: ResponseTimePeriod) {
  return {
    title: "Response time",
    header: ["Figure", "This period", `The ${time.days} days before`],
    rows: RESPONSE_FIGURES.map(({ key, label }) => [
      label,
      formatResponseTime(time[key], time.status),
      formatResponseTime(time.previous[key], time.previous.status),
    ]),
  };
}

function ResponseTime({ time }: { time: ResponseTimePeriod }) {
  const note = responseTimeNote(time.status);
  const excluded = pageActionNote(time.status, time.pageActionAnswers);
  const explanations = {
    firstTokenMedianMs:
      "Typical time until the answer starts appearing. Half the answers started sooner.",
    firstTokenP90Ms: "9 in 10 answers started appearing within this time.",
    totalMedianMs: "Typical time until the whole answer was written.",
  };
  return (
    <section className="stack" aria-labelledby="response-time-heading">
      <div>
        <h2 id="response-time-heading" className="section-heading">
          Response time
        </h2>
        <p className="muted">
          How long visitors waited for an answer on your site. Try it and tests are not counted.
        </p>
        {note && <p className="muted">{note}</p>}
        {excluded && <p className="muted">{excluded}</p>}
      </div>
      <div className="overview-grid overview-grid-3">
        {RESPONSE_FIGURES.map(({ key, label }) => (
          <StatCard
            key={key}
            label={label}
            value={formatResponseTime(time[key], time.status)}
            explanation={explanations[key]}
            change={durationChange(time[key], time.previous[key], time.days)}
          />
        ))}
      </div>
    </section>
  );
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
      {empty ? <NoneInPeriod /> : <ul className="row-list">{children}</ul>}
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
  linkTo: (question: string) => { to: string; query: Record<string, string> };
}) {
  return (
    <ReportList heading={heading} explanation={explanation} empty={rows.length === 0}>
      {rows.map((item) => (
        <li key={item.question} className="row-item">
          <ScreenLink {...linkTo(item.question)}>{item.question}</ScreenLink>
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

const RANGE_OPTIONS = RANGES.map((value) => ({ value, label: `${value} days` }));

export function Reports({ assistantId }: ReportsProps) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const gapsShown = useAdminNavigation().pathFor("gaps") !== null;
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
          The CSV holds the figures and the four lists below, for {formatDate(report.from)} to{" "}
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
        <StatsSkeleton label="Loading report…" />
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
              <p className="muted">
                Share of answers your assistant could give from your content. Off-topic questions
                are not counted.
              </p>
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

          {report.responseTime && <ResponseTime time={report.responseTime} />}

          <div className="report-columns">
            <QuestionTable
              heading="Most asked questions"
              explanation="What visitors want to know, and how many times it was asked. Open one to read the conversations it was asked in."
              rows={report.topQuestions}
              linkTo={(question) => ({
                to: "conversations",
                query: questionConversationsQuery(assistantId, question, {
                  from: report.from,
                  to: report.to,
                }),
              })}
            />
            <QuestionTable
              heading="Most often unanswered"
              explanation={
                gapsShown
                  ? "Write an answer for these on the Gaps screen."
                  : "Questions your assistant could not answer from your content."
              }
              rows={report.topGaps}
              linkTo={() => ({ to: "gaps", query: { assistant: assistantId } })}
            />

            <ReportList
              heading="Pages used most"
              explanation="The content your assistant answers from."
              empty={report.topSources.length === 0}
            >
              {report.topSources.map((item) => (
                <li key={item.url} className="row-item">
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
                <li key={item.url} className="row-item">
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
