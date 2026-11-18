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
