import { type ReactNode, useState } from "react";
import type {
  AssistantReport,
  ReportContent,
  ResponseTimePeriod,
  TopGap,
  TopicsReport,
} from "../api/types.js";
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
  noContentNote,
  pageActionNote,
  responseTimeNote,
} from "./figures.js";
import { StatCard } from "./OverviewParts.js";
import { StatsSkeleton } from "./StatsSkeleton.js";
import { TopicsDialog } from "./TopicsDialog.js";

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
    ...(report.topics
      ? [
          {
            title: "Topics",
            header: ["Topic", "Questions", "Could not answer"],
            rows: report.topics.rows.map((item) => [
              item.name,
              item.questions,
              formatPercent(item.unansweredShare),
            ]),
          },
        ]
      : []),
    {
      title: "Most often unanswered",
      header: ["Question", "Topic", "Times"],
      rows: report.topGaps.map((item) => [item.question, item.topic?.name ?? "", item.count]),
    },
    {
      title: "Content used most",
      header: ["Content", "Type", "Address", "Times"],
      rows: report.topSources.map((item) => [item.title, contentType(item), item.url, item.count]),
    },
    {
      title: "Content never used",
      header: ["Content", "Type", "Address"],
      rows: report.uncitedSources.map((item) => [item.title, contentType(item), item.url]),
    },
  ]);
}

function contentType(item: ReportContent): string {
  return item.kind === "answer" ? "Written answer" : "Page";
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
  const noContent = noContentNote(time.noContentAnswers);
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
        {noContent && <p className="muted">{noContent}</p>}
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
  rows: readonly TopGap[];
  linkTo: (question: string) => { to: string; query: Record<string, string> };
}) {
  return (
    <ReportList heading={heading} explanation={explanation} empty={rows.length === 0}>
      {rows.map((item) => (
        <li key={item.question} className="row-item">
          <span className="report-question">
            <ScreenLink {...linkTo(item.question)}>{item.question}</ScreenLink>
            {item.topic && (
              <span className="badge badge-tone-info topic-label">
                <span className="sr-only">Topic: </span>
                {item.topic.name}
              </span>
            )}
          </span>
          <span className="badge">{formatTimes(item.count)}</span>
        </li>
      ))}
    </ReportList>
  );
}

/** "1 question", "12 questions". */
function formatQuestions(count: number): string {
  return count === 1 ? "1 question" : `${count} questions`;
}

/** Reports' Topics list: each topic's questions in the period, most asked first. */
function TopicsList({
  topics,
  assistantId,
  period,
  onManage,
}: {
  topics: TopicsReport;
  assistantId: string;
  period: { from: string; to: string };
  onManage: () => void;
}) {
  const empty = topics.rows.length === 0;
  return (
    <section className="source-card stack" aria-label="Topics">
      <div className="report-list-heading">
        <div>
          <h2 className="section-heading">Topics</h2>
          <p className="muted">
            What visitors ask about, and the share your assistant could not answer. Open one to read
            its conversations.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onManage}>
          Manage topics
        </button>
      </div>
      {!topics.reviewAnswers && (
        <p className="muted">
          Review answers is off in Settings, so new questions get no topic. Turn it on to see topics
          here.
        </p>
      )}
      {empty ? (
        topics.reviewAnswers ? (
          <NoneInPeriod />
        ) : null
      ) : (
        <ul className="row-list">
          {topics.rows.map((item) => (
            <li key={item.id} className="row-item topic-row">
              <ScreenLink
                to="conversations"
                query={{
                  topic: item.id,
                  askedFrom: period.from,
                  askedTo: period.to,
                  assistant: assistantId,
                }}
              >
                {item.name}
              </ScreenLink>
              <span className="topic-figures">
                <span className="badge">{formatQuestions(item.questions)}</span>
                <span className={item.unanswered > 0 ? "badge badge-tone-warning" : "badge"}>
                  {formatPercent(item.unansweredShare)} not answered
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ContentLink({ item, assistantId }: { item: ReportContent; assistantId: string }) {
  if (item.kind === "answer") {
    // A written answer has no public address: it lives in Sources.
    return (
      <div>
        <ScreenLink to="sources" query={{ assistant: assistantId }}>
          {item.title || "Written answer"}
        </ScreenLink>
        <div className="muted">Written answer</div>
      </div>
    );
  }
  return <PageLink url={item.url} title={item.title} />;
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
  const [managing, setManaging] = useState(false);
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
          The CSV holds the figures and the lists below, for {formatDate(report.from)} to{" "}
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
          action={
            // Topics outlast a quiet period: they can still be managed.
            report.topics ? (
              <button type="button" className="btn btn-secondary" onClick={() => setManaging(true)}>
                Manage topics
              </button>
            ) : undefined
          }
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
                Share of answers your assistant could give from your content. A partial answer
                counts as half. Off-topic questions are not counted.
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

          {report.topics && (
            <TopicsList
              topics={report.topics}
              assistantId={assistantId}
              period={{ from: report.from, to: report.to }}
              onManage={() => setManaging(true)}
            />
          )}

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
              heading="Content used most"
              explanation="The pages and written answers your assistant answers from."
              empty={report.topSources.length === 0}
            >
              {report.topSources.map((item) => (
                <li key={item.documentId ?? item.url} className="row-item">
                  <ContentLink item={item} assistantId={assistantId} />
                  <span className="badge">{formatTimes(item.count)}</span>
                </li>
              ))}
            </ReportList>

            <ReportList
              heading="Content never used"
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
                <li key={item.documentId ?? item.url} className="row-item">
                  <ContentLink item={item} assistantId={assistantId} />
                </li>
              ))}
            </ReportList>
          </div>
        </div>
      )}
      <TopicsDialog
        assistantId={assistantId}
        open={managing}
        onClose={() => setManaging(false)}
        onChanged={reportRes.reload}
      />
    </div>
  );
}
