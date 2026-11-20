import type { ReviewFailure } from "@solvchat/core";
import { type SyntheticEvent, useState } from "react";
import type {
  AnswerTraceCandidate,
  AnswerTrace as AnswerTraceData,
  AnswerTracePart,
} from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { ScreenLink } from "../routing.js";
import { isSafeHttpUrl } from "../safeUrl.js";
import { DataTable, type DataTableColumn } from "../ui/DataTable.js";
import { ErrorState } from "../ui/ErrorState.js";
import { formatDateTime } from "../ui/format.js";
import { Skeleton } from "../ui/Skeleton.js";
import { StatusBadge, type StatusTone } from "../ui/StatusBadge.js";
import { formatCost } from "./figures.js";

export interface AnswerTraceProps {
  assistantId: string;
  /**
   * The visitor conversation the reply is in. Absent for a "Try it" or
   * test-run answer, whose trace is read by its id under the assistant.
   */
  conversationId?: string | undefined;
  messageId: string;
}

const PROVIDER_LABELS: Record<NonNullable<AnswerTracePart["model"]>["provider"], string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

const KEY_SOURCE_LABELS: Record<NonNullable<AnswerTracePart["model"]>["keySource"], string> = {
  stored: "key set in Settings → Providers",
  environment: "key set on the server",
  managed: "key included with your plan",
};

/** Why the answer check gave no result, in plain words. */
export const REVIEW_FAILURE_LABELS: Record<ReviewFailure, string> = {
  review_timeout: "It failed after a retry: the last try took too long.",
  review_provider_error: "It failed after a retry: the AI provider could not do the last try.",
  review_empty: "It failed after a retry: the last try came back empty.",
  review_unparseable: "It failed after a retry: the last try gave a reply we could not read.",
  review_skipped_spend_cap: "Skipped: the daily spend limit was reached.",
  review_error: "Something went wrong on our side while checking.",
};

function ReviewFailureNote({ failure }: { failure: ReviewFailure | null | undefined }) {
  if (failure === null || failure === undefined) return null;
  return (
    <dl className="trace-facts">
      <dt>Answer check</dt>
      <dd>Not checked. {REVIEW_FAILURE_LABELS[failure]}</dd>
    </dl>
  );
}

const STOP_LABELS: Record<AnswerTracePart["stop"], string> = {
  complete: "Finished",
  length: "Cut short at the length limit",
  tool: "Stopped while asking for a tool",
  refused: "The AI model declined to go on",
  spend_cap: "Stopped by the daily spend limit",
  error: "Stopped by an error",
  paused: "Waited for the visitor's page",
};

/** `120 ms`, `2.4 s`: one way of writing a duration. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function statusFor(candidate: AnswerTraceCandidate): { tone: StatusTone; label: string } {
  if (candidate.used) return { tone: "success", label: "Used" };
  switch (candidate.dropped) {
    case "not_found":
      return { tone: "warning", label: "Not used: content gone" };
    case "duplicate":
      return { tone: "neutral", label: "Not used: same as a better match" };
    case "document_cap":
      return { tone: "neutral", label: "Not used: enough from this page" };
    case "rank":
      return { tone: "neutral", label: "Not used: better matches filled the space" };
    default:
      return { tone: "neutral", label: "Not used: weak match" };
  }
}

function ContentCell({ candidate }: { candidate: AnswerTraceCandidate }) {
  const content = candidate.content;
  if (content === null) {
    return <span className="muted">This content has since changed or been removed.</span>;
  }
  // An entry's URL is an admin address, and any other must be http(s) to be a link.
  const linkable = content.sourceKind !== "entry" && isSafeHttpUrl(content.url);
  return (
    <div className="trace-content">
      <span className="trace-content-title">
        {linkable ? (
          <a href={content.url} target="_blank" rel="noreferrer">
            {content.title || content.url}
          </a>
        ) : (
          content.title || "Untitled"
        )}
      </span>
      {content.headingPath && <span className="trace-content-section">{content.headingPath}</span>}
      <span className="trace-content-excerpt">{content.excerpt}</span>
    </div>
  );
}

const COLUMNS: readonly DataTableColumn<AnswerTraceCandidate & { rank: number }>[] = [
  { key: "rank", header: "Rank", render: (row) => row.rank, align: "end" },
  { key: "content", header: "Content", render: (row) => <ContentCell candidate={row} /> },
  { key: "score", header: "Match", render: (row) => row.score.toFixed(2), align: "end" },
  {
    key: "status",
    header: "Status",
    render: (row) => {
      const status = statusFor(row);
      return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
    },
  },
];

function VersionText({
  assistantId,
  version,
  source,
}: {
  assistantId: string;
  version: AnswerTracePart["version"];
  source: AnswerTraceData["source"];
}) {
  const current = version.current;
  const label =
    version.state === "draft"
      ? source === "test_run"
        ? "The draft (test run)"
        : "The draft (Try it)"
      : current === null
        ? "A published version that no longer exists"
        : `Published version from ${formatDateTime(current.publishedAt ?? current.createdAt)}`;
  return (
    <>
      {label}
      {current !== null && (
        <>
          {" · "}
          <ScreenLink to="behaviour" query={{ assistant: assistantId, history: "open" }}>
            See History
          </ScreenLink>
        </>
      )}
    </>
  );
}

function TracePartView({
  assistantId,
  part,
  heading,
  source,
}: {
  assistantId: string;
  part: AnswerTracePart;
  heading: string | null;
  source: AnswerTraceData["source"];
}) {
  const rows = part.retrieval.candidates.map((c, i) => ({ ...c, rank: i + 1 }));
  return (
    <section className="trace-part" aria-label={heading ?? "How this answer was made"}>
      {heading && <p className="trace-part-heading">{heading}</p>}
      <p className="trace-heading">The content it was given</p>
      <DataTable
        className="trace-table"
        caption="Content found for this question, best match first"
        columns={COLUMNS}
        rows={rows}
        rowKey={(row) => `${row.rank}:${row.chunkId}`}
        empty={<p className="muted">Nothing in your content matched this question.</p>}
      />
      <dl className="trace-facts">
        <dt>Settings</dt>
        <dd>
          <VersionText assistantId={assistantId} version={part.version} source={source} />
        </dd>
        <dt>Model</dt>
        <dd>
          {part.model === null
            ? "No model was asked: nothing relevant was found."
            : `${PROVIDER_LABELS[part.model.provider]} ${part.model.id} (${KEY_SOURCE_LABELS[part.model.keySource]})`}
        </dd>
        <dt>Searching your content</dt>
        <dd>{formatMs(part.retrieval.ms)}</dd>
        <dt>First words shown</dt>
        <dd>
          {part.timing.firstTokenMs === null
            ? "No words were shown"
            : formatMs(part.timing.firstTokenMs)}
        </dd>
        <dt>Whole answer</dt>
        <dd>{formatMs(part.timing.totalMs)}</dd>
        {part.tools.rounds > 0 && (
          <>
            <dt>Tools</dt>
            <dd>
              {part.tools.rounds === 1 ? "1 round" : `${part.tools.rounds} rounds`},{" "}
              {formatMs(part.tools.ms)}
            </dd>
          </>
        )}
        <dt>Ended</dt>
        <dd>{STOP_LABELS[part.stop] ?? "Finished"}</dd>
      </dl>
    </section>
  );
}

function TraceBody({ assistantId, data }: { assistantId: string; data: AnswerTraceData }) {
  if (data.trace === null) {
    return (
      <div className="trace-body">
        <p className="muted">No details were recorded for this answer.</p>
        <ReviewFailureNote failure={data.reviewFailure} />
      </div>
    );
  }
  const { parts, truncated } = data.trace;
  // OpenRouter reports cost in its own credits, as Overview and Reports say.
  const unit = parts.some((p) => p.model?.provider === "openrouter") ? "credits" : "usd";
  return (
    <div className="trace-body">
      {parts.map((part, index) => (
        <TracePartView
          // Parts never reorder: a resume is only ever appended.
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only
          key={index}
          assistantId={assistantId}
          part={part}
          source={data.source}
          heading={
            parts.length === 1
              ? null
              : part.kind === "answer"
                ? "First reply"
                : `After page action ${index}`
          }
        />
      ))}
      <dl className="trace-facts">
        <dt>Tokens</dt>
        <dd>
          {data.tokensIn.toLocaleString()} in · {data.tokensOut.toLocaleString()} out
        </dd>
        <dt>Cost</dt>
        <dd>{data.costMicros === null ? "Unknown" : formatCost(data.costMicros, unit)}</dd>
      </dl>
      <ReviewFailureNote failure={data.reviewFailure} />
      {truncated && <p className="muted">Some details were left out to keep this record small.</p>}
    </div>
  );
}

/**
 * "How this answer was made" under an assistant reply. Closed by default;
 * the details are read the first time it is opened and kept after that.
 */
export function AnswerTrace({ assistantId, conversationId, messageId }: AnswerTraceProps) {
  const [opened, setOpened] = useState(false);
  const path =
    conversationId === undefined
      ? `/api/admin/assistants/${assistantId}/preview-traces/${messageId}`
      : `/api/admin/conversations/${conversationId}/messages/${messageId}/trace`;
  const res = useResource<AnswerTraceData>(opened ? path : null);
  return (
    <details
      className="disclosure answer-trace"
      onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary>How this answer was made</summary>
      {opened &&
        (res.status === "error" ? (
          <ErrorState title="Could not load the details." detail={res.error} onRetry={res.reload} />
        ) : res.value === undefined ? (
          <Skeleton label="Loading details…" lines={3} />
        ) : (
          <TraceBody assistantId={assistantId} data={res.value} />
        ))}
    </details>
  );
}
