import type { SyncCounts, SyncErrorCode, SyncOutcome } from "@solvchat/core";
import { prepare, prepareInsert } from "./sql.js";

// Declared in core so the admin words the same codes the engine records.
export type { SyncCounts, SyncErrorCode, SyncOutcome } from "@solvchat/core";

export type SyncPageState = "pending" | "added" | "updated" | "unchanged" | "failed";

export interface SourceSyncState {
  sourceId: string;
  runId: string;
  startedAt: number;
  finishedAt: number | null;
  outcome: SyncOutcome;
  /** While running, includes the pages handled so far. */
  counts: SyncCounts;
  error: SyncErrorCode | null;
  /**
   * While running: pages handled so far out of the pages the run queued (0
   * while the sitemap is still being read). Null once the run has ended.
   */
  progress: { done: number; total: number } | null;
}

export interface SyncPage {
  url: string;
  lastmod: string | null;
}

interface SyncRow {
  source_id: string;
  run_id: string;
  lease_until: number | null;
  started_at: number;
  finished_at: number | null;
  outcome: string;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  failed: number;
  deferred: number;
  error: string | null;
  live_added: number | null;
  live_updated: number | null;
  live_unchanged: number | null;
  live_failed: number | null;
  live_pages: number | null;
  live_pending: number | null;
}

const OUTCOMES: ReadonlySet<string> = new Set<SyncOutcome>([
  "running",
  "succeeded",
  "partial",
  "failed",
]);
const ERROR_CODES: ReadonlySet<string> = new Set<SyncErrorCode>([
  "sitemap_unavailable",
  "sitemap_invalid",
  "sitemap_empty",
  "too_many_removals",
  "limit_refused",
  "pages_failed",
  "interrupted",
]);

// Pages per insert statement. A URL may be a few kilobytes long, and D1 caps
// a statement at 100 KB.
// Source: https://developers.cloudflare.com/d1/platform/limits/ — checked 2026-11-18
// ("Maximum SQL statement length: 100,000 bytes (100 KB)").
const PAGES_PER_INSERT = 20;

/**
 * True while run `run` is the source's current run, unfinished, with its
 * lease not yet ended at `now`. Every write a page message makes carries
 * this in the same statement, so a run whose lease ran out while a page was
 * being fetched changes nothing, even if its check passed before the fetch.
 * The arguments are SQL parameter references such as `?1`.
 */
export function syncRunHolds(org: string, source: string, run: string, now: string): string {
  return `EXISTS (SELECT 1 FROM source_syncs f
                   WHERE f.org_id = ${org} AND f.source_id = ${source} AND f.run_id = ${run}
                     AND f.finished_at IS NULL AND f.lease_until > ${now})`;
}

/** The run a page message belongs to, checked at `now` when it writes. */
export interface SyncRunFence {
  runId: string;
  now: number;
}

const pageCount = (state: SyncPageState): string =>
  `(SELECT COUNT(*) FROM source_sync_pages p
     WHERE p.org_id = ?1 AND p.run_id = ?3 AND p.state = '${state}')`;

// The run's own row, with its pages added up while it is going. `?1` is the
// org; callers add their WHERE and GROUP BY.
const SYNC_STATE_SELECT = `SELECT y.source_id, y.run_id, y.lease_until, y.started_at, y.finished_at,
                y.outcome, y.added, y.updated, y.unchanged, y.removed, y.failed, y.deferred, y.error,
                SUM(CASE WHEN p.state = 'added' THEN 1 ELSE 0 END) AS live_added,
                SUM(CASE WHEN p.state = 'updated' THEN 1 ELSE 0 END) AS live_updated,
                SUM(CASE WHEN p.state = 'unchanged' THEN 1 ELSE 0 END) AS live_unchanged,
                SUM(CASE WHEN p.state = 'failed' THEN 1 ELSE 0 END) AS live_failed,
                COUNT(p.url) AS live_pages,
                SUM(CASE WHEN p.state = 'pending' THEN 1 ELSE 0 END) AS live_pending
           FROM source_syncs y
           LEFT JOIN source_sync_pages p
             ON p.org_id = y.org_id AND p.run_id = y.run_id AND y.finished_at IS NULL`;

/**
 * A run whose lease ran out before it finished is reported as `failed` with
 * `interrupted`; its late queue messages change nothing.
 */
function toSyncState(row: SyncRow, now: number): SourceSyncState {
  const running = row.finished_at === null;
  const live = (n: number | null) => (running ? Number(n ?? 0) : 0);
  const counts: SyncCounts = {
    added: Number(row.added) + live(row.live_added),
    updated: Number(row.updated) + live(row.live_updated),
    unchanged: Number(row.unchanged) + live(row.live_unchanged),
    removed: Number(row.removed),
    failed: Number(row.failed) + live(row.live_failed),
    deferred: Number(row.deferred),
  };
  const interrupted = running && (row.lease_until === null || row.lease_until <= now);
  const outcome = OUTCOMES.has(row.outcome) ? (row.outcome as SyncOutcome) : "failed";
  const total = live(row.live_pages);
  return {
    sourceId: row.source_id,
    runId: row.run_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: interrupted ? "failed" : outcome,
    counts,
    error: interrupted
      ? "interrupted"
      : row.error !== null && ERROR_CODES.has(row.error)
        ? (row.error as SyncErrorCode)
        : null,
    progress: running && !interrupted ? { done: total - live(row.live_pending), total } : null,
  };
}

/** Tenant-scoped data access for `source_syncs` and `source_sync_pages`. */
export function syncFor(db: D1Database, orgId: string) {
  return {
    /**
     * The source's current or latest run, or null if it never synced. A run
     * whose lease ran out before it finished is reported as `failed` with
     * `interrupted`; its late queue messages change nothing.
     */
    async get(sourceId: string, now: number = Date.now()): Promise<SourceSyncState | null> {
      const row = await prepare(
        db,
        `${SYNC_STATE_SELECT}
          WHERE y.org_id = ?1 AND y.source_id = ?2
          GROUP BY y.source_id`,
      )
        .bind(orgId, sourceId)
        .first<SyncRow>();
      return row ? toSyncState(row, now) : null;
    },

    /**
     * The current or latest run of every source of the assistant that ever
     * synced, by source id, in one statement (the Sources list reads it).
     */
    async listForAssistant(
      assistantId: string,
      now: number = Date.now(),
    ): Promise<Map<string, SourceSyncState>> {
      const res = await prepare(
        db,
        `${SYNC_STATE_SELECT}
           JOIN sources s ON s.org_id = y.org_id AND s.id = y.source_id
          WHERE y.org_id = ?1 AND s.assistant_id = ?2
          GROUP BY y.source_id`,
      )
        .bind(orgId, assistantId)
        .all<SyncRow>();
      return new Map(res.results.map((row) => [row.source_id, toSyncState(row, now)]));
    },

    /**
     * Starts run `runId` for the source unless another run holds an
     * unexpired lease. One statement, so two schedulers racing for the same
     * source cannot both win. Returns false when a run is already going.
     * Pages of earlier runs are deleted once this one has the lease.
     */
    async acquire(sourceId: string, runId: string, now: number, leaseMs: number): Promise<boolean> {
      const row = await prepareInsert(
        db,
        `INSERT INTO source_syncs (org_id, source_id, run_id, lease_until, started_at, outcome)
         VALUES (?1, ?2, ?3, ?4, ?5, 'running')
         ON CONFLICT(org_id, source_id) DO UPDATE SET
           run_id = excluded.run_id,
           lease_until = excluded.lease_until,
           started_at = excluded.started_at,
           finished_at = NULL,
           outcome = 'running',
           added = 0, updated = 0, unchanged = 0, removed = 0, failed = 0, deferred = 0,
           error = NULL
         WHERE source_syncs.lease_until IS NULL OR source_syncs.lease_until <= excluded.started_at
         RETURNING run_id`,
      )
        .bind(orgId, sourceId, runId, now + leaseMs, now)
        .first<{ run_id: string }>();
      if (row?.run_id !== runId) return false;
      await prepare(
        db,
        "DELETE FROM source_sync_pages WHERE org_id = ?1 AND source_id = ?2 AND run_id != ?3",
      )
        .bind(orgId, sourceId, runId)
        .run();
      return true;
    },

    /** Ends a run before any page was queued (refused, failed, or nothing to fetch). */
    async finish(
      sourceId: string,
      runId: string,
      now: number,
      result: { outcome: Exclude<SyncOutcome, "running">; error: SyncErrorCode | null } & Partial<
        Pick<SyncCounts, "unchanged" | "removed" | "deferred">
      >,
    ): Promise<void> {
      await prepare(
        db,
        `UPDATE source_syncs
            SET finished_at = ?4, lease_until = NULL, outcome = ?5, error = ?6,
                unchanged = ?7, removed = ?8, deferred = ?9
          WHERE org_id = ?1 AND source_id = ?2 AND run_id = ?3 AND finished_at IS NULL`,
      )
        .bind(
          orgId,
          sourceId,
          runId,
          now,
          result.outcome,
          result.error,
          result.unchanged ?? 0,
          result.removed ?? 0,
          result.deferred ?? 0,
        )
        .run();
    },

    /** When a run last queued each page of the source, by URL. */
    async attempts(sourceId: string): Promise<Map<string, number>> {
      const res = await prepare(
        db,
        "SELECT url, attempted_at FROM source_sync_attempts WHERE org_id = ?1 AND source_id = ?2",
      )
        .bind(orgId, sourceId)
        .all<{ url: string; attempted_at: number }>();
      return new Map(res.results.map((row) => [row.url, Number(row.attempted_at)]));
    },

    /** Forgets when pages were last queued, for pages the sitemap no longer lists. */
    async forgetAttempts(sourceId: string, urls: string[]): Promise<void> {
      if (urls.length === 0) return;
      const statements: D1PreparedStatement[] = [];
      for (let i = 0; i < urls.length; i += PAGES_PER_INSERT) {
        statements.push(
          prepare(
            db,
            `DELETE FROM source_sync_attempts
              WHERE org_id = ?1 AND source_id = ?2 AND url IN (SELECT value FROM json_each(?3))`,
          ).bind(orgId, sourceId, JSON.stringify(urls.slice(i, i + PAGES_PER_INSERT))),
        );
      }
      await db.batch(statements);
    },

    /**
     * True while run `runId` still holds the source at `now`: current,
     * unfinished, lease not ended. A page message checks it again after its
     * fetch; the writes themselves carry the same condition.
     */
    async holds(sourceId: string, runId: string, now: number): Promise<boolean> {
      const row = await prepare(db, `SELECT ${syncRunHolds("?1", "?2", "?3", "?4")} AS held`)
        .bind(orgId, sourceId, runId, now)
        .first<{ held: number }>();
      return Number(row?.held ?? 0) === 1;
    },

    /**
     * Records the counts known before any page is fetched and the pages
     * handed to the queue, all `pending`, and stamps each page as queued at
     * `attemptedAt` so the next capped run starts with other pages. Call
     * before sending the messages, so a message never arrives for a page
     * that is not recorded.
     */
    async plan(
      sourceId: string,
      runId: string,
      known: Pick<SyncCounts, "unchanged" | "removed" | "deferred">,
      pages: SyncPage[],
      attemptedAt: number,
    ): Promise<void> {
      const statements: D1PreparedStatement[] = [
        prepare(
          db,
          `UPDATE source_syncs SET unchanged = ?4, removed = ?5, deferred = ?6
            WHERE org_id = ?1 AND source_id = ?2 AND run_id = ?3 AND finished_at IS NULL`,
        ).bind(orgId, sourceId, runId, known.unchanged, known.removed, known.deferred),
      ];
      for (let i = 0; i < pages.length; i += PAGES_PER_INSERT) {
        statements.push(
          prepareInsert(
            db,
            `INSERT INTO source_sync_pages (org_id, run_id, source_id, url, lastmod)
             SELECT ?1, ?2, ?3, json_extract(value, '$.url'), json_extract(value, '$.lastmod')
               FROM json_each(?4)
             WHERE true
             ON CONFLICT(org_id, run_id, url) DO NOTHING`,
          ).bind(orgId, runId, sourceId, JSON.stringify(pages.slice(i, i + PAGES_PER_INSERT))),
          prepareInsert(
            db,
            `INSERT INTO source_sync_attempts (org_id, source_id, url, attempted_at)
             SELECT ?1, ?2, json_extract(value, '$.url'), ?4
               FROM json_each(?3)
             WHERE true
             ON CONFLICT(org_id, source_id, url) DO UPDATE SET attempted_at = excluded.attempted_at`,
          ).bind(
            orgId,
            sourceId,
            JSON.stringify(pages.slice(i, i + PAGES_PER_INSERT)),
            attemptedAt,
          ),
        );
      }
      await db.batch(statements);
    },

    /**
     * The page's row in a run that is still current and unfinished, or null:
     * a message for an older or finished run, or a page already handled, is
     * then acknowledged without doing anything.
     */
    async pendingPage(
      sourceId: string,
      runId: string,
      url: string,
      now: number,
    ): Promise<SyncPage | null> {
      const row = await prepare(
        db,
        `SELECT p.url, p.lastmod FROM source_sync_pages p
           JOIN source_syncs y ON y.org_id = p.org_id AND y.source_id = p.source_id
                              AND y.run_id = p.run_id
          WHERE p.org_id = ?1 AND p.source_id = ?2 AND p.run_id = ?3 AND p.url = ?4
            AND p.state = 'pending' AND y.finished_at IS NULL AND y.lease_until > ?5`,
      )
        .bind(orgId, sourceId, runId, url, now)
        .first<{ url: string; lastmod: string | null }>();
      return row ? { url: row.url, lastmod: row.lastmod } : null;
    },

    /**
     * Moves one page out of `pending` and, when it was the last, finishes the
     * run in the same D1 batch: the counts are added up once, from the pages,
     * so a retried message cannot count a page twice. Returns true when this
     * call finished the run.
     *
     * Both statements require the run to still hold the source at `now`: a
     * run whose lease ran out stays interrupted, and its last page cannot
     * turn it into `succeeded`.
     */
    async completePage(
      sourceId: string,
      runId: string,
      url: string,
      state: Exclude<SyncPageState, "pending">,
      now: number,
    ): Promise<boolean> {
      const results = await db.batch([
        prepare(
          db,
          `UPDATE source_sync_pages SET state = ?4
            WHERE org_id = ?1 AND run_id = ?2 AND url = ?3 AND state = 'pending'
              AND ${syncRunHolds("?1", "?6", "?2", "?5")}`,
        ).bind(orgId, runId, url, state, now, sourceId),
        prepare(
          db,
          `UPDATE source_syncs
              SET finished_at = ?4, lease_until = NULL,
                  added = added + ${pageCount("added")},
                  updated = updated + ${pageCount("updated")},
                  unchanged = unchanged + ${pageCount("unchanged")},
                  failed = failed + ${pageCount("failed")},
                  outcome = CASE WHEN ${pageCount("failed")} > 0 THEN 'partial' ELSE 'succeeded' END,
                  error = CASE WHEN ${pageCount("failed")} > 0 THEN 'pages_failed' ELSE NULL END
            WHERE org_id = ?1 AND source_id = ?2 AND run_id = ?3 AND finished_at IS NULL
              AND lease_until > ?4
              AND NOT EXISTS (SELECT 1 FROM source_sync_pages
                               WHERE org_id = ?1 AND run_id = ?3 AND state = 'pending')`,
        ).bind(orgId, sourceId, runId, now),
      ]);
      return (results[1]?.meta.changes ?? 0) > 0;
    },
  };
}

export interface DueSource {
  /** Read from the `sources` row; a claim until the auth seam vouches for it. */
  claimedOrgId: string;
  sourceId: string;
}

/**
 * Sitemap sources whose schedule says a run is due and that no run holds,
 * across every org, oldest first by the later of their last run start and
 * their org's last refusal by the auth seam (`recordSyncRefusal`): a refused
 * org goes behind every other due source, so a tick never reads the same
 * refused sources again while others wait. The one statement in the engine without an
 * org filter, and on purpose: a cron has no request and so no org. It reads
 * only ids; the caller passes each org to `AuthProvider.resolveOrg` (as for a
 * queued ingest message) and does everything else through that org's
 * `Tenant`, so a refused org is never read.
 *
 * Malformed `settings` JSON is skipped rather than failing the whole query.
 */
export async function dueSitemapSources(
  db: D1Database,
  options: { now: number; dailyMs: number; weeklyMs: number; limit: number },
): Promise<DueSource[]> {
  const res = await db
    .prepare(
      `SELECT s.org_id, s.id
         FROM (SELECT org_id, id,
                      CASE WHEN json_valid(settings) THEN json_extract(settings, '$.sync') END AS sync
                 FROM sources WHERE kind = 'sitemap') s
         LEFT JOIN source_syncs y ON y.org_id = s.org_id AND y.source_id = s.id
         LEFT JOIN sync_org_refusals r ON r.org_id = s.org_id
        WHERE s.sync IN ('daily', 'weekly')
          AND (y.lease_until IS NULL OR y.lease_until <= ?1)
          AND (y.started_at IS NULL
               OR y.started_at <= ?1 - CASE s.sync WHEN 'daily' THEN ?2 ELSE ?3 END)
        ORDER BY MAX(COALESCE(y.started_at, 0), COALESCE(r.refused_at, 0)) ASC, s.id ASC
        LIMIT ?4`,
    )
    .bind(options.now, options.dailyMs, options.weeklyMs, options.limit)
    .all<{ org_id: string; id: string }>();
  return res.results.map((row) => ({ claimedOrgId: row.org_id, sourceId: row.id }));
}

/**
 * Records that the auth seam refused `orgId` at `now`, so the next ticks take
 * other due sources first (see `dueSitemapSources`). Keyed by the org; it
 * stores the scheduler's own answer and reads nothing of the org.
 */
export async function recordSyncRefusal(db: D1Database, orgId: string, now: number): Promise<void> {
  await prepareInsert(
    db,
    `INSERT INTO sync_org_refusals (org_id, refused_at) VALUES (?1, ?2)
     ON CONFLICT(org_id) DO UPDATE SET refused_at = excluded.refused_at`,
  )
    .bind(orgId, now)
    .run();
}
