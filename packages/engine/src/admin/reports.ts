import type { QuestionCount, ReportRange, SourceCitationCount } from "../db/reports.js";
import type { Tenant } from "../db/tenant.js";
import { utcDay } from "../util/time.js";
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
  topGaps: QuestionCount[];
  topSources: SourceCitationCount[];
  uncitedSources: Array<{ url: string; title: string }>;
  uncitedTotal: number;
}

const DAY_MS = 86_400_000;

/**
 * The last `days` UTC days, including today.
 *
 * Computed once and passed to every query: `usage_daily` is keyed by UTC day
 * and the message tables by millisecond, and a report that asked the clock
 * twice would, at midnight, show a cost from one range beside counts from
 * another.
 */
export function rangeFor(days: ReportDays, at: number = Date.now()): ReportRange {
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

/** The four headline figures for one range, shared by Reports and Overview. */
export interface PeriodFigures {
  from: string;
  to: string;
  questions: number;
  replies: number;
  answeredShare: number;
  thumbsDownShare: number;
  costMicros: number;
}

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
    answeredShare: shares.replies === 0 ? 0 : shares.answered / shares.replies,
    thumbsDownShare: shares.replies === 0 ? 0 : shares.thumbsDown / shares.replies,
    costMicros,
  };
}

export async function reportFor(
  tenant: Tenant,
  assistantId: string,
  days: ReportDays,
  at?: number,
): Promise<AssistantReport> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  const range = rangeFor(days, at);

  // In parallel, as the Overview screen already does, so the figures are one
  // consistent read rather than sequential ones. The headline figures come
  // from the same function as Overview's, so the two screens cannot drift.
  const [figures, topQuestions, topGaps, topSources, uncited] = await Promise.all([
    periodFigures(tenant, assistantId, range),
    tenant.reports.topQuestions(assistantId, range, { unansweredOnly: false }),
    tenant.reports.topQuestions(assistantId, range, { unansweredOnly: true }),
    tenant.reports.topSources(assistantId, range),
    tenant.reports.uncitedSources(assistantId, range),
  ]);

  return {
    days,
    ...figures,
    topQuestions,
    topGaps,
    topSources,
    uncitedSources: uncited.documents,
    uncitedTotal: uncited.total,
  };
}
