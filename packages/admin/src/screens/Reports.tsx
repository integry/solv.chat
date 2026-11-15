import { useState } from "react";
import type { AssistantReport, TopQuestion } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { buildCsv } from "../csv.js";
import { isSafeHttpUrl } from "../safeUrl.js";

export interface ReportsProps {
  assistantId: string;
}

/** The three the specification names. */
const RANGES = [7, 30, 90] as const;

// Same shapes as the Overview screen: one number should not be written two
// ways in one product.
function formatUsd(costMicros: number): string {
  const dollars = costMicros / 1_000_000;
  if (costMicros > 0 && dollars < 0.01) return "< $0.01";
  return `$${dollars.toFixed(2)}`;
}

function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

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

function QuestionTable({
  heading,
  explanation,
  rows,
}: {
  heading: string;
  explanation: string;
  rows: readonly TopQuestion[];
}) {
  return (
    <section className="source-card stack" aria-label={heading}>
      <div>
        <h2 className="section-heading">{heading}</h2>
        <p className="muted">{explanation}</p>
      </div>
      {rows.length === 0 ? (
        <p className="muted">None in this period.</p>
      ) : (
        <ul className="history-list">
          {rows.map((item) => (
            <li key={item.question} className="history-item">
              <span>{item.question}</span>
              <span className="badge">{item.count === 1 ? "1 time" : `${item.count} times`}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Reports({ assistantId }: ReportsProps) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const reportRes = useResource<AssistantReport>(
    `/api/admin/assistants/${assistantId}/report?days=${days}`,
  );
  const report = reportRes.value;

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
    <div className="screen">
      <div className="screen-header">
        <div>
          <h1>Reports</h1>
          <p className="muted">
            {report
              ? `How your assistant did from ${report.from} to ${report.to}.`
              : "How your assistant did over time."}
          </p>
        </div>
        <div className="screen-actions">
          <label htmlFor="report-range" className="sr-only">
            Period
          </label>
          <select
            id="report-range"
            className="select"
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as (typeof RANGES)[number])}
          >
            {RANGES.map((option) => (
              <option key={option} value={option}>
                Last {option} days
              </option>
            ))}
          </select>
          {/* Offered only with something to download: an empty CSV is a
              support question, not a feature. */}
          {report && !empty && (
            <button type="button" className="btn btn-secondary" onClick={download}>
              Download CSV
            </button>
          )}
        </div>
      </div>

      {reportRes.status === "loading" && !report ? (
        <p className="muted">Loading report…</p>
      ) : reportRes.status === "error" ? (
        <p className="error-text" role="alert">
          {reportRes.error}
        </p>
      ) : empty ? (
        <p className="muted">
          Nothing yet for this period. Once visitors ask questions, their answers show up here.
        </p>
      ) : report ? (
        <div className="stack">
          <div className="overview-grid">
            <section className="source-card stack" aria-label="Questions asked">
              <div className="stat-label">Questions asked</div>
              <div className="stat-value">{report.questions}</div>
              <p className="muted">How many questions visitors asked in this period.</p>
            </section>
            <section className="source-card stack" aria-label="Answered share">
              <div className="stat-label">Answered share</div>
              <div className="stat-value">{formatPercent(report.answeredShare)}</div>
              <p className="muted">Share of answers your assistant could give from your content.</p>
            </section>
            <section className="source-card stack" aria-label="Marked not helpful">
              <div className="stat-label">Marked not helpful</div>
              <div className="stat-value">{formatPercent(report.thumbsDownShare)}</div>
              <p className="muted">Share of answers a visitor said did not help.</p>
            </section>
            <section className="source-card stack" aria-label="Cost">
              <div className="stat-label">Cost</div>
              <div className="stat-value">{formatUsd(report.costMicros)}</div>
              <p className="muted">Estimated cost for this period.</p>
            </section>
          </div>

          <QuestionTable
            heading="Most asked questions"
            explanation="What visitors want to know."
            rows={report.topQuestions}
          />
          <QuestionTable
            heading="Most often unanswered"
            explanation="Write an answer for these on the Gaps screen."
            rows={report.topGaps}
          />

          <section className="source-card stack" aria-label="Pages used most">
            <div>
              <h2 className="section-heading">Pages used most</h2>
              <p className="muted">The content your assistant answers from.</p>
            </div>
            {report.topSources.length === 0 ? (
              <p className="muted">None in this period.</p>
            ) : (
              <ul className="history-list">
                {report.topSources.map((item) => (
                  <li key={item.url} className="history-item">
                    {/* Filtered like every other citation link in the admin: the
                        URL came from ingested content. */}
                    {isSafeHttpUrl(item.url) ? (
                      <a href={item.url} target="_blank" rel="noreferrer">
                        {item.title || item.url}
                      </a>
                    ) : (
                      <span>{item.title || item.url}</span>
                    )}
                    <span className="badge">
                      {item.count === 1 ? "1 time" : `${item.count} times`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="source-card stack" aria-label="Pages never used">
            <div>
              <h2 className="section-heading">Pages never used</h2>
              <p className="muted">
                Nobody was shown these in this period. They may be out of date, or nobody asks about
                them.
              </p>
            </div>
            {report.uncitedSources.length === 0 ? (
              <p className="muted">None in this period.</p>
            ) : (
              <ul className="history-list">
                {report.uncitedSources.map((item) => (
                  <li key={item.url} className="history-item">
                    <span>{item.title || item.url}</span>
                  </li>
                ))}
              </ul>
            )}
            {report.uncitedTotal > report.uncitedSources.length && (
              <p className="muted">and {report.uncitedTotal - report.uncitedSources.length} more</p>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
