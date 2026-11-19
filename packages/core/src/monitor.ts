import type { SyncErrorCode } from "./sync.js";

/**
 * Shapes the engine's Overview and Reports endpoints send and the admin reads.
 * Declared once here so the two sides cannot drift apart.
 */

/** The four headline figures for one range, shared by Reports and Overview. */
export interface PeriodFigures {
  /** First UTC day of the range, `YYYY-MM-DD`. */
  from: string;
  /** Last UTC day of the range, `YYYY-MM-DD`. */
  to: string;
  questions: number;
  replies: number;
  answeredShare: number;
  thumbsDownShare: number;
  costMicros: number;
}

/** The Overview's stated period, with the same figures for the one before it. */
export interface OverviewPeriod extends PeriodFigures {
  days: number;
  previous: PeriodFigures;
}

/**
 * Why a response-time figure has no number: `no_answers` (no answer in the
 * range), `page_actions_only` (every answer in the range used a page action,
 * and those are left out), or `mostly_untimed` (most answers in the range were
 * written before answers were timed, so a number from the few timed ones would
 * mislead).
 */
export type ResponseTimeStatus = "measured" | "no_answers" | "page_actions_only" | "mostly_untimed";

/**
 * How fast visitor answers came over one range. The three times are whole
 * milliseconds, and `null` unless `status` is `measured`.
 */
export interface ResponseTimeFigures {
  /** First UTC day of the range, `YYYY-MM-DD`. */
  from: string;
  /** Last UTC day of the range, `YYYY-MM-DD`. */
  to: string;
  status: ResponseTimeStatus;
  /** Visitor answers in the range the figures are about: page-action answers are not among them. */
  answers: number;
  /**
   * Visitor answers in the range that used a page action, left out of every
   * figure: their stored times cover only the request before the page action,
   * not the rest of the answer written after it.
   */
  pageActionAnswers: number;
  /**
   * Visitor replies in the range that found nothing to answer from, left out
   * of every figure: they are the fixed fallback, sent with no model call.
   */
  noContentAnswers: number;
  /** Of those, answers that have timings. */
  timed: number;
  /** Median time until the answer starts appearing. */
  firstTokenMedianMs: number | null;
  /** 90th percentile of the time until the answer starts appearing. */
  firstTokenP90Ms: number | null;
  /** Median time until the answer is complete. */
  totalMedianMs: number | null;
}

/** Response time for a period, with the same figures for the period of the same length before it. */
export interface ResponseTimePeriod extends ResponseTimeFigures {
  days: number;
  previous: ResponseTimeFigures;
}

/** The getting-started checklist, each step read from stored state. */
export interface OverviewSetup {
  hasContent: boolean;
  tried: boolean;
  published: boolean;
  installed: boolean;
  visitorQuestion: boolean;
}

/** Things the owner should act on. Every list or count is empty or zero when there is nothing. */
export interface OverviewAttention {
  /** Unanswered question groups with no written answer and not dismissed. */
  openGaps: number;
  /** Failed tests in the latest test run. */
  failingTests: number;
  /**
   * Sources with documents that did not get indexed: `failed` ones as soon as
   * indexing records the failure, `waiting` ones once they are overdue (none
   * recorded, but still not indexed well after their last write).
   */
  notIndexed: Array<{ sourceId: string; label: string; failed: number; waiting: number }>;
  /**
   * Sitemap sources whose latest sync failed (including one that ran out of
   * time), with the reason as a code the admin words. A partial run (some
   * pages could not be fetched) is not listed. Absent from engines older
   * than this field.
   */
  syncFailed?: Array<{ sourceId: string; label: string; error: SyncErrorCode | null }>;
}

/**
 * What the answer reviewer decided an assistant reply to a visitor did. Stored
 * on the reply; absent (null) when it was not reviewed.
 *
 * - `answered`: gave the information asked for.
 * - `partial`: gave some of it, or hedged.
 * - `declined`: said it does not know or cannot help, or gave the fallback.
 * - `off_topic`: the question was not about the site's subject.
 * - `wants_human`: the visitor asked for a person, a call back, or to complain.
 */
export const ANSWER_OUTCOMES = [
  "answered",
  "partial",
  "declined",
  "off_topic",
  "wants_human",
] as const;
export type AnswerOutcome = (typeof ANSWER_OUTCOMES)[number];

/** True for exactly the five outcome labels. */
export function isAnswerOutcome(value: unknown): value is AnswerOutcome {
  return typeof value === "string" && (ANSWER_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Why an answer review gave no usable result, recorded in the answer's trace
 * once its attempts are used up. Fixed codes only: never the provider's
 * response text or anything the visitor wrote.
 *
 * - `review_timeout`: the model did not reply in time.
 * - `review_provider_error`: the provider refused or failed the call (or no
 *   reviewer could be built, a missing key say).
 * - `review_unparseable`: the reply was not one of the five labels.
 * - `review_skipped_spend_cap`: the daily spend limit was reached first.
 * - `review_error`: something on our side failed (the spend limit could not
 *   be read, or the result could not be saved).
 */
export const REVIEW_FAILURES = [
  "review_timeout",
  "review_provider_error",
  "review_unparseable",
  "review_skipped_spend_cap",
  "review_error",
] as const;
export type ReviewFailure = (typeof REVIEW_FAILURES)[number];

/** True for exactly the review failure codes. */
export function isReviewFailure(value: unknown): value is ReviewFailure {
  return typeof value === "string" && (REVIEW_FAILURES as readonly string[]).includes(value);
}

/** One of an assistant's topics, as the topic list and the Conversations filter read it. */
export interface TopicItem {
  id: string;
  name: string;
  createdAt: number;
}

/** One row of Reports' Topics list: a topic's questions in the period. */
export interface TopicReportRow {
  id: string;
  name: string;
  /** Visitor questions in the period with this topic. */
  questions: number;
  /** Of those, questions whose reply could not answer them (as Gaps counts one). */
  unanswered: number;
  /** `unanswered / questions`, 0 to 1. */
  unansweredShare: number;
}

/**
 * Reports' Topics list. `reviewAnswers` is the "Review answers" switch: off,
 * no topic is assigned, and the screen says why the list is empty.
 */
export interface TopicsReport {
  reviewAnswers: boolean;
  rows: TopicReportRow[];
}
