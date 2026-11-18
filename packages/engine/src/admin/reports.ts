import type {
  PeriodFigures,
  ResponseTimeFigures,
  ResponseTimePeriod,
  TopicsReport,
} from "@solvchat/core";
import type {
  GapQuestionCount,
  QuestionCount,
  ReportRange,
  SourceCitationCount,
  UnusedDocument,
} from "../db/reports.js";
import type { Tenant } from "../db/tenant.js";
import { DAY_MS, utcDay } from "../util/time.js";
import { BadRequest, NotFound } from "./errors.js";

/**
 * The three the specification names. An open range is how one click scans
 * everything, so there is no "all time" option.
 */
export const REPORT_DAY_OPTIONS = [7, 30, 90] as const;
export type ReportDays = (typeof REPORT_DAY_OPTIONS)[number];

export interface AssistantReport extends PeriodFigures {
  days: ReportDays;
  topQuestions: QuestionCount[];
  topGaps: GapQuestionCount[];
  topics: TopicsReport;
  topSources: SourceCitationCount[];
  uncitedSources: UnusedDocument[];
  uncitedTotal: number;
  responseTime: ResponseTimePeriod;
}

/**
 * The last `days` UTC days, including today.
 *
 * Computed once and passed to every query: `usage_daily` is keyed by UTC day
 * and the message tables by millisecond, and a report that asked the clock
 * twice would, at midnight, show a cost from one range beside counts from
 * another.
 */
export function rangeFor(days: number, at: number = Date.now()): ReportRange {
  const now = new Date(at);
  const endOfToday =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS - 1;
  const fromMs = endOfToday + 1 - days * DAY_MS;
  return { fromDay: utcDay(fromMs), toDay: utcDay(endOfToday), fromMs, toMs: endOfToday };
}

export function parseReportDays(raw: string | null): ReportDays {
  // Defaults to 30: the middle option, and the one that answers "is it
  // working" without a quiet week looking like a problem.
  if (raw === null) return 30;
  const days = Number(raw);
  if (!REPORT_DAY_OPTIONS.includes(days as ReportDays)) {
    throw new BadRequest([`days: must be ${REPORT_DAY_OPTIONS.join(", ")}`]);
  }
  return days as ReportDays;
}

export type { PeriodFigures } from "@solvchat/core";

export async function periodFigures(
  tenant: Tenant,
  assistantId: string,
  range: ReportRange,
): Promise<PeriodFigures> {
  const [questions, shares, costMicros] = await Promise.all([
    tenant.reports.questionCount(assistantId, range),
    tenant.reports.replyShares(assistantId, range),
    tenant.reports.costMicros(assistantId, range),
  ]);
  return {
    from: range.fromDay,
    to: range.toDay,
    questions,
    replies: shares.replies,
    // Zero rather than null on an empty range: the screen shows a number with
    // a plain sentence, and a dash makes an owner wonder if it is broken.
    // Off-topic replies are not in the answered share's denominator: see
    // `replyShares`.
    answeredShare: shares.answerable === 0 ? 0 : shares.answered / shares.answerable,
    thumbsDownShare: shares.replies === 0 ? 0 : shares.thumbsDown / shares.replies,
    costMicros,
  };
}

/**
 * Response time for one range. A number is given only when at least half the
 * range's answers were timed: answers written before timings existed have
 * none, and a median of the few timed ones beside many untimed ones would
 * describe a different period than the one the owner picked. Answers that
 * used a page action are left out of all of it (see `replyTiming`), and
 * counted on their own so the screen can say so.
 */
export async function responseTimeFigures(
  tenant: Tenant,
  assistantId: string,
  range: ReportRange,
): Promise<ResponseTimeFigures> {
  const timing = await tenant.reports.replyTiming(assistantId, range);
  const status =
    timing.replies === 0
      ? timing.pageActionReplies > 0
        ? "page_actions_only"
        : "no_answers"
      : timing.timed === 0 || timing.timed * 2 < timing.replies
        ? "mostly_untimed"
        : "measured";
  const measured = status === "measured";
  return {
    from: range.fromDay,
    to: range.toDay,
    status,
    answers: timing.replies,
    pageActionAnswers: timing.pageActionReplies,
    timed: timing.timed,
    firstTokenMedianMs: measured ? timing.firstTokenMedianMs : null,
    firstTokenP90Ms: measured ? timing.firstTokenP90Ms : null,
    totalMedianMs: measured ? timing.totalMedianMs : null,
  };
}

/**
 * The last `days` UTC days' response time, and the `days` before them. One
 * clock for both, so the two ranges meet exactly at midnight.
 */
export async function responseTimePeriod(
  tenant: Tenant,
  assistantId: string,
  days: number,
  at: number = Date.now(),
): Promise<ResponseTimePeriod> {
  const [current, previous] = await Promise.all([
    responseTimeFigures(tenant, assistantId, rangeFor(days, at)),
    responseTimeFigures(tenant, assistantId, rangeFor(days, at - days * DAY_MS)),
  ]);
  return { days, ...current, previous };
}

export async function reportFor(
  tenant: Tenant,
  assistantId: string,
  days: ReportDays,
  at?: number,
): Promise<AssistantReport> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  const clock = at ?? Date.now();
  const range = rangeFor(days, clock);

  // In parallel, as the Overview screen already does, so the figures are one
  // consistent read rather than sequential ones. The headline figures come
  // from the same function as Overview's, so the two screens cannot drift.
  const [figures, topQuestions, topGaps, topSources, uncited, responseTime, topicRows, settings] =
    await Promise.all([
      periodFigures(tenant, assistantId, range),
      tenant.reports.topQuestions(assistantId, range, { unansweredOnly: false }),
      tenant.reports.topGaps(assistantId, range),
      tenant.reports.topSources(assistantId, range),
      tenant.reports.uncitedSources(assistantId, range),
      responseTimePeriod(tenant, assistantId, days, clock),
      tenant.reports.topicCounts(assistantId, range),
      tenant.providerSettings.get(),
    ]);

  return {
    days,
    ...figures,
    topQuestions,
    topGaps,
    // Topics are named by the answer review: with "Review answers" off (on
    // unless switched off) none is assigned, and the screen says so.
    topics: { reviewAnswers: settings?.reviewAnswers !== false, rows: topicRows },
    topSources,
    uncitedSources: uncited.documents,
    uncitedTotal: uncited.total,
    responseTime,
  };
}
