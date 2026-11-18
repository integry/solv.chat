import type { SyncSchedule } from "./schemas/source.js";

/**
 * Shapes of a sitemap source's scheduled sync, shared by the engine (which
 * records and sends them) and the admin (which words them). Declared once
 * here so the two sides cannot drift apart.
 */

/** `partial`: the run finished but some pages could not be fetched or written. */
export type SyncOutcome = "running" | "succeeded" | "partial" | "failed";

/**
 * Why a run failed or was partial. Codes, not messages: the admin words them,
 * and a remote server's own text never reaches the database.
 *
 * - `sitemap_unavailable`: the sitemap could not be fetched or was refused.
 * - `sitemap_invalid`: the sitemap was not a complete, well-formed `<urlset>`
 *   (cut short, broken XML, or another kind of document), so its list of
 *   pages cannot be trusted to say which pages left it.
 * - `sitemap_empty`: the sitemap listed no usable page.
 * - `sitemap_index`: the address is a sitemap index, which lists other
 *   sitemaps rather than pages; the owner should use one of those.
 * - `too_many_removals`: the run would have removed more than the allowed
 *   share, so it changed nothing: no page was added, updated or removed.
 *   `SyncCounts.withheld` is how many it would have removed; only the owner
 *   lifts this ("Sync anyway", or a higher `maxRemovePercent`).
 * - `limit_refused`: the Limits seam refused the run (a suspended org, a plan).
 * - `pages_failed`: the run finished, but some pages could not be fetched or written.
 * - `interrupted`: the run's lease ran out before every page was handled.
 */
export type SyncErrorCode =
  | "sitemap_unavailable"
  | "sitemap_invalid"
  | "sitemap_empty"
  | "sitemap_index"
  | "too_many_removals"
  | "limit_refused"
  | "pages_failed"
  | "interrupted";

export interface SyncCounts {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  failed: number;
  /** Pages left for a later run by a cap. */
  deferred: number;
  /**
   * Documents the sitemap no longer lists that a refused run
   * (`too_many_removals`) would have removed; a run with the guard lifted
   * would remove them.
   */
  withheld: number;
}

/** One sync run as the admin API reports it. */
export interface SourceSyncRun {
  startedAt: number;
  /** Null while the run is going. */
  finishedAt: number | null;
  outcome: SyncOutcome;
  /** While running, includes the pages handled so far. */
  counts: SyncCounts;
  error: SyncErrorCode | null;
  /**
   * While running: pages handled so far (`done`) out of the pages the run
   * queued (`total`; 0 while the sitemap is still being read). Null once the
   * run has ended.
   */
  progress: { done: number; total: number } | null;
}

/** A sitemap source's sync schedule and its latest run, on the admin's Sources list. */
export interface SourceSyncStatus {
  schedule: SyncSchedule;
  /** The current or latest run; null if the source never synced. */
  last: SourceSyncRun | null;
  /**
   * The earliest time the scheduler takes the source up again (it runs on a
   * cron, so the run starts at its next check after this). A time already
   * passed means at the next check. Null while the schedule is off or a run
   * is going.
   */
  nextSyncAt: number | null;
}
