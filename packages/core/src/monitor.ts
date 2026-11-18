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
 * range) or `mostly_untimed` (most answers in the range were written before
 * answers were timed, so a number from the few timed ones would mislead).
 */
export type ResponseTimeStatus = "measured" | "no_answers" | "mostly_untimed";

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
  /** Visitor answers in the range. */
  answers: number;
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
}
