import { type ReactNode, useState } from "react";
import type { AssistantOverview, OverviewSetup } from "../api/types.js";
import { formatDate } from "../ui/format.js";
import { Icon } from "../ui/Icon.js";
import { ScreenLink } from "../ui/ScreenLink.js";
import type { Change } from "./figures.js";

/** Asks the shell to open the Try it pane (it owns the pane and its toggle). */
export const OPEN_TRY_IT_EVENT = "solvchat:open-try-it";

export function StatCard({
  label,
  value,
  explanation,
  change,
  children,
}: {
  label: string;
  value: string;
  explanation: string;
  change?: Change | undefined;
  children?: ReactNode;
}) {
  return (
    <section className="source-card stat-card" aria-label={label}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {change && (
        <div className={`stat-change stat-change-${change.direction}`}>
          <span aria-hidden="true" className="stat-change-arrow">
            {change.direction === "up" ? "▲" : change.direction === "down" ? "▼" : "•"}
          </span>
          {change.text}
        </div>
      )}
      <p className="muted stat-explanation">{explanation}</p>
      {children}
    </section>
  );
}

function weekday(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(date);
}

/**
 * Questions per day as bars. The bars are drawn in SVG; the day names and
 * counts under them are text, so they stay readable at any width. Screen
 * readers get the same numbers as a table.
 */
export function QuestionsChart({ daily }: { daily: Array<{ day: string; questions: number }> }) {
  const max = Math.max(1, ...daily.map((d) => d.questions));
  const total = daily.reduce((sum, d) => sum + d.questions, 0);
  const slot = 10;
  const height = 40;
  return (
    <section className="source-card stack" aria-labelledby="questions-chart-heading">
      <div>
        <h2 id="questions-chart-heading" className="section-heading">
          Questions per day
        </h2>
        <p className="muted">
          {total === 0 ? "No questions in the last 7 days." : "Visitor questions each day."}
        </p>
      </div>
      <div className="chart" aria-hidden="true">
        <svg
          className="chart-bars"
          viewBox={`0 0 ${daily.length * slot} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <line x1="0" y1={height} x2={daily.length * slot} y2={height} className="chart-axis" />
          {daily.map((d, i) => {
            const h = d.questions === 0 ? 0 : Math.max(1, (d.questions / max) * (height - 2));
            return (
              <rect
                key={d.day}
                x={i * slot + 2}
                y={height - h}
                width={slot - 4}
                height={h}
                rx="0.6"
                className="chart-bar"
              />
            );
          })}
        </svg>
        <div
          className="chart-labels"
          style={{ gridTemplateColumns: `repeat(${daily.length}, 1fr)` }}
        >
          {daily.map((d) => (
            <div key={d.day} className="chart-label">
              <span className="chart-label-value">{d.questions}</span>
              <span className="chart-label-day">{weekday(d.day)}</span>
            </div>
          ))}
        </div>
      </div>
      <table className="sr-only">
        <caption>Questions per day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Questions</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((d) => (
            <tr key={d.day}>
              <td>{formatDate(d.day)}</td>
              <td>{d.questions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const STEPS: Array<{
  key: keyof OverviewSetup;
  label: string;
  hint: string;
  to?: string;
  action?: string;
}> = [
  {
    key: "hasContent",
    label: "Add content",
    hint: "Pages or answers your assistant replies from.",
    to: "/admin/sources",
  },
  {
    key: "tried",
    label: "Try a question",
    hint: "Ask something in the Try it pane.",
    action: "Open Try it",
  },
  {
    key: "published",
    label: "Publish",
    hint: "Publish is at the top of the Build screens.",
    to: "/admin/behaviour",
  },
  {
    key: "installed",
    label: "Install on your site",
    hint: "Paste the snippet into your site.",
    to: "/admin/install",
  },
  {
    key: "visitorQuestion",
    label: "First visitor question",
    hint: "Shows up in Conversations when it arrives.",
    to: "/admin/conversations",
  },
];

function checklistKey(assistantId: string): string {
  return `solvchat.admin.checklistHidden.${assistantId}`;
}

function readHidden(assistantId: string): boolean {
  try {
    return window.localStorage.getItem(checklistKey(assistantId)) === "1";
  } catch {
    return false;
  }
}

/** The getting-started checklist. Gone once every step is done, or when hidden. */
export function GettingStarted({
  assistantId,
  setup,
}: {
  assistantId: string;
  setup: OverviewSetup;
}) {
  const [hidden, setHidden] = useState(() => readHidden(assistantId));
  const done = STEPS.filter((step) => setup[step.key]).length;
  if (hidden || done === STEPS.length) return null;

  function hide() {
    try {
      window.localStorage.setItem(checklistKey(assistantId), "1");
    } catch {
      // Storage can be blocked; it then stays hidden for this visit only.
    }
    setHidden(true);
  }

  return (
    <section className="source-card stack checklist" aria-labelledby="checklist-heading">
      <div className="checklist-header">
        <div>
          <h2 id="checklist-heading" className="section-heading">
            Getting started
          </h2>
          <p className="muted">
            {done} of {STEPS.length} done
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={hide}>
          Hide checklist
        </button>
      </div>
      <div
        className="checklist-progress"
        role="progressbar"
        aria-label="Getting started progress"
        aria-valuemin={0}
        aria-valuemax={STEPS.length}
        aria-valuenow={done}
      >
        <span style={{ width: `${(done / STEPS.length) * 100}%` }} />
      </div>
      <ol className="checklist-steps">
        {STEPS.map((step) => {
          const complete = setup[step.key];
          return (
            <li key={step.key} className={complete ? "checklist-step is-done" : "checklist-step"}>
              <span className="checklist-mark" aria-hidden="true">
                {complete && <Icon name="check" size={14} />}
              </span>
              <div className="checklist-text">
                <span className="checklist-label">
                  {step.to ? <ScreenLink to={step.to}>{step.label}</ScreenLink> : step.label}
                  <span className="sr-only">{complete ? " (done)" : " (to do)"}</span>
                </span>
                <span className="muted">{step.hint}</span>
              </div>
              {step.action && !complete && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => window.dispatchEvent(new Event(OPEN_TRY_IT_EVENT))}
                >
                  {step.action}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** What needs the owner now. Not rendered when there is nothing. */
export function NeedsAttention({ overview }: { overview: AssistantOverview }) {
  const attention = overview.attention;
  const items: Array<{ key: string; tone: "warning" | "danger"; body: ReactNode }> = [];
  if (overview.configError) {
    items.push({
      key: "config",
      tone: "danger",
      body: (
        <>
          <span>{overview.configError}</span>{" "}
          <ScreenLink to="/admin/providers">Check providers</ScreenLink>
        </>
      ),
    });
  }
  if (attention && attention.openGaps > 0) {
    items.push({
      key: "gaps",
      tone: "warning",
      body: (
        <ScreenLink to="/admin/gaps">
          {attention.openGaps}{" "}
          {plural(
            attention.openGaps,
            "unanswered question is waiting for an answer",
            "unanswered questions are waiting for an answer",
          )}
        </ScreenLink>
      ),
    });
  }
  if (attention && attention.failingTests > 0) {
    items.push({
      key: "tests",
      tone: "danger",
      body: (
        <ScreenLink to="/admin/tests">
          {attention.failingTests} {plural(attention.failingTests, "test failed", "tests failed")}{" "}
          in the last run
        </ScreenLink>
      ),
    });
  }
  for (const source of attention?.notIndexed ?? []) {
    items.push({
      key: `source-${source.sourceId}`,
      tone: "warning",
      body: (
        <ScreenLink to="/admin/sources">
          {source.label}: {source.documents}{" "}
          {plural(source.documents, "page was not indexed", "pages were not indexed")}
        </ScreenLink>
      ),
    });
  }
  if (items.length === 0) return null;
  return (
    <section className="source-card stack attention" aria-labelledby="attention-heading">
      <h2 id="attention-heading" className="section-heading">
        Needs attention
      </h2>
      <ul className="attention-list">
        {items.map((item) => (
          <li key={item.key} className={`attention-item attention-${item.tone}`}>
            <Icon name="alert" className="attention-icon" />
            <div>{item.body}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
