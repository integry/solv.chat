import {
  DEFAULT_SYNC_MAX_REMOVE_PERCENT,
  DEFAULT_SYNC_RECHECK_DAYS,
  MAX_SYNC_RECHECK_DAYS,
  type SyncSchedule,
} from "@solvchat/core";
import { BadRequest } from "../admin/errors.js";
import {
  extractSitemapEntries,
  fetchSitemapXml,
  hashUrlExternalId,
  type SitemapEntry,
} from "../admin/sitemap.js";
import type { DocumentSyncRow } from "../db/documents.js";
import {
  dueSitemapSources,
  recordSyncRefusal,
  type SyncPage,
  type SyncPageState,
} from "../db/sync.js";
import { forScheduledSync, type Tenant } from "../db/tenant.js";
import type { Retriever } from "../providers/retrieval.js";
import type { Limits, PageFetcher, SyncLimitDecision } from "../seams/types.js";
import type { HostResolver } from "../security/urlGuard.js";
import {
  type IngestQueueMessage,
  type PushDeps,
  pushDocuments,
  removeSourceDocuments,
  SyncRunEnded,
  TooLarge,
} from "./documents.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const SYNC_INTERVAL_MS: Record<Exclude<SyncSchedule, "off">, number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
};
// A source is due a little before a full interval has passed, so a cron that
// fires at the same minute every day does not miss "24 hours ago" by seconds
// and skip a day. Ours; the issue gives no number.
export const SYNC_DUE_SLACK_MS = 15 * 60 * 1000;
// How long one run holds its source. Long enough for the queue to work
// through a run's pages with retries; a run still unfinished after it is
// reported as interrupted and the next run may start. Ours.
export const SYNC_LEASE_MS = 6 * HOUR_MS;
// Pages fetched in one run. A larger sitemap is worked through over several
// runs, the pages queued longest ago first (never queued before all others),
// whether or not they could be fetched then. Ours.
export const DEFAULT_SYNC_MAX_PAGES = 200;
// Documents one sitemap source may hold, the same as the most pages the
// admin's sitemap preview lists. Ours.
export const DEFAULT_SYNC_MAX_DOCUMENTS = 500;
// The sitemap protocol allows at most 50,000 URLs per sitemap file; a larger
// one is read up to this many and nothing is removed in that run.
// Source: https://www.sitemaps.org/protocol.html — checked 2026-11-18
export const MAX_SYNC_SITEMAP_URLS = 50_000;
// Sources started per cron tick. Each start fetches one sitemap: up to four
// hops (the URL and three redirects) of two DNS-over-HTTPS lookups and the
// fetch, 12 external subrequests. Workers Free allows 50 per invocation, so
// three leave room; the rest start on the next tick.
// Source: https://developers.cloudflare.com/workers/platform/limits/ — checked 2026-11-18
export const MAX_SYNC_SOURCES_PER_TICK = 3;
// Due candidates read per tick, so sources of an org the auth seam refuses
// cannot keep every other source waiting.
const DUE_CANDIDATES_PER_TICK = MAX_SYNC_SOURCES_PER_TICK * 10;
// "100 (or 256KB in total)" messages per `sendBatch`; 128 KB per message.
// Source: https://developers.cloudflare.com/queues/platform/limits/ — checked 2026-11-18
const QUEUE_SEND_BATCH_MESSAGES = 100;
const QUEUE_SEND_BATCH_BYTES = 200_000;
// A page message tried this many times is recorded as failed rather than
// retried again, so the run can finish. The consumer's default is three
// retries (four attempts) before the dead-letter queue.
const SYNC_PAGE_MAX_ATTEMPTS = 3;

/**
 * One page of one sync run, sent on the ingest queue. The consumer fetches it
 * through the page-fetcher seam and writes it with `pushDocuments`, which
 * queues the usual chunk-and-embed message when the content changed.
 */
export interface SyncPageMessage {
  kind: "sync_page";
  orgId: string;
  sourceId: string;
  runId: string;
  url: string;
}

export function isSyncPageMessage(body: unknown): body is SyncPageMessage {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  return (
    record.kind === "sync_page" &&
    typeof record.orgId === "string" &&
    record.orgId !== "" &&
    typeof record.sourceId === "string" &&
    record.sourceId !== "" &&
    typeof record.runId === "string" &&
    record.runId !== "" &&
    typeof record.url === "string" &&
    record.url !== ""
  );
}

export interface SyncQueue {
  send(message: IngestQueueMessage): Promise<unknown>;
  sendBatch(messages: Array<{ body: SyncPageMessage }>): Promise<unknown>;
}

export interface SyncCaps {
  /** Pages fetched per run; the Limits seam may lower it. */
  maxPages?: number | undefined;
  /** Documents per source; the Limits seam may lower it. */
  maxDocuments?: number | undefined;
}

export interface SyncSchedulerDeps {
  db: D1Database;
  docs: PushDeps["docs"] & { delete(keys: string | string[]): Promise<unknown> };
  queue: SyncQueue;
  retriever: Pick<Retriever, "remove">;
  limits: Limits;
  /** `AuthProvider.resolveOrg` with `queued_ingest`; null skips the org. */
  resolveOrg: (claimedOrgId: string) => Promise<string | null>;
  /** For the sitemap itself; pages go through the page-fetcher seam in the consumer. */
  fetchImpl?: typeof fetch | undefined;
  resolveHost?: HostResolver | undefined;
  now?: (() => number) | undefined;
  caps?: SyncCaps | undefined;
  /** Sources started per call; defaults to `MAX_SYNC_SOURCES_PER_TICK`. */
  maxSources?: number | undefined;
}

/** What starting one run needs: the scheduler's deps less what only the cron uses. */
export type SyncStartDeps = Omit<SyncSchedulerDeps, "db" | "resolveOrg" | "maxSources">;

export type SyncStartResult =
  /** Pages were queued; the run finishes when the consumer has handled them. */
  | { status: "queued"; runId: string; queued: number }
  /** The run ended without queueing anything: nothing to fetch, refused, or failed. */
  | { status: "finished"; runId: string }
  /** Another run of this source holds it. */
  | { status: "busy" }
  /** No such sitemap source in this org. */
  | { status: "not_found" };

const positive = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

function lowest(...values: Array<number | undefined>): number {
  let out = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const v = positive(value);
    if (v !== undefined && v < out) out = v;
  }
  return out;
}

function maxRemovePercentOf(settings: Record<string, unknown>): number {
  const value = settings.maxRemovePercent;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100
    ? value
    : DEFAULT_SYNC_MAX_REMOVE_PERCENT;
}

/** How long an unchanged `<lastmod>` is trusted before the page is checked again, in ms. */
function recheckMsOf(settings: Record<string, unknown>): number {
  const value = settings.recheckDays;
  const days =
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_SYNC_RECHECK_DAYS
      ? value
      : DEFAULT_SYNC_RECHECK_DAYS;
  return days * DAY_MS;
}

/** Options for one run, given by the admin's "Sync anyway". */
export interface SyncRunOptions {
  /**
   * Lifts the removal-share guard for this run only, as long as it would
   * remove at most this many documents (the number the owner was shown). A
   * run that would remove more is refused as usual and reports the new
   * number. The other guards (unreadable, invalid or empty sitemap) stay.
   */
  allowRemovals?: number | undefined;
}

async function sendPageMessages(queue: SyncQueue, messages: SyncPageMessage[]): Promise<void> {
  let batch: Array<{ body: SyncPageMessage }> = [];
  let bytes = 0;
  for (const body of messages) {
    // Twice the JSON length bounds its UTF-8 size well enough for a cap.
    const size = JSON.stringify(body).length * 2 + 100;
    if (
      batch.length > 0 &&
      (batch.length >= QUEUE_SEND_BATCH_MESSAGES || bytes + size > QUEUE_SEND_BATCH_BYTES)
    ) {
      await queue.sendBatch(batch);
      batch = [];
      bytes = 0;
    }
    batch.push({ body });
    bytes += size;
  }
  if (batch.length > 0) await queue.sendBatch(batch);
}

interface Plan {
  removed: DocumentSyncRow[];
  unchanged: number;
  deferred: number;
  pages: SyncPage[];
}

/**
 * Decides what one run does, from the sitemap, the source's documents and
 * when each page was last queued: what to remove, what to skip on an
 * unchanged `<lastmod>`, and which pages to fetch, within the caps. An
 * unchanged `<lastmod>` is trusted only while the page was checked less than
 * `recheckMs` ago: a page served wrongly once (a maintenance page with a 200)
 * would otherwise be pinned by a date that never changes. Pages are
 * taken queued-longest-ago first (never queued first, new pages before
 * documents among those), so a page that failed last time goes behind the
 * ones that waited. Pages left out are counted as deferred.
 */
function planRun(
  entries: SitemapEntry[],
  documents: DocumentSyncRow[],
  attempts: ReadonlyMap<string, number>,
  options: {
    removeAllowed: boolean;
    maxPages: number;
    maxDocuments: number;
    now: number;
    recheckMs: number;
  },
): Plan {
  const listed = new Set(entries.map((entry) => entry.url));
  const byUrl = new Map(documents.map((doc) => [doc.url, doc]));
  const removed = options.removeAllowed ? documents.filter((doc) => !listed.has(doc.url)) : [];

  let unchanged = 0;
  const added: Array<{ page: SyncPage; isNew: boolean; attemptedAt: number }> = [];
  const checks: typeof added = [];
  for (const entry of entries) {
    const doc = byUrl.get(entry.url);
    const candidate = {
      page: { url: entry.url, lastmod: entry.lastmod },
      isNew: doc === undefined,
      attemptedAt: attempts.get(entry.url) ?? 0,
    };
    if (doc === undefined) {
      added.push(candidate);
    } else if (
      entry.lastmod !== null &&
      doc.sitemapLastmod === entry.lastmod &&
      doc.indexedHash === doc.contentHash &&
      doc.syncCheckedAt !== null &&
      options.now - doc.syncCheckedAt < options.recheckMs
    ) {
      // Skipped only once its content is indexed: a document whose indexing
      // failed is checked again, so the page's handler can queue it anew.
      // A check older than `recheckMs` is due again; it is a conditional
      // request, so an unchanged page costs a 304.
      unchanged++;
    } else {
      checks.push(candidate);
    }
  }
  // A stable sort: among pages queued at the same time, new pages come
  // first, then in sitemap order.
  const candidates = [...added, ...checks].sort((a, b) => a.attemptedAt - b.attemptedAt);

  let room = Math.max(0, options.maxDocuments - (documents.length - removed.length));
  const pages: SyncPage[] = [];
  let deferred = 0;
  for (const candidate of candidates) {
    if (pages.length >= options.maxPages || (candidate.isNew && room === 0)) {
      deferred++;
      continue;
    }
    if (candidate.isNew) room--;
    pages.push(candidate.page);
  }
  return { removed, unchanged, deferred, pages };
}

/**
 * Starts one sync run of a sitemap source in an org the auth seam vouched
 * for. Takes the source's lease (or answers `busy`), asks the Limits seam,
 * reads the sitemap, removes documents whose URL left it (unless the guard
 * trips), and queues one message per page to fetch.
 *
 * The guard: a sitemap that cannot be read, is not a complete, well-formed
 * `<urlset>` (a sitemap index is reported as `sitemap_index`), or lists no
 * page removes nothing, fetches nothing, and records the run as failed. One
 * that would remove more than the source's `maxRemovePercent` (default 50%)
 * of its documents changes nothing either: no additions, updates or
 * removals. The run is recorded as failed with `too_many_removals` and the
 * number it would have removed (`withheld`). It is refused on every run
 * until the owner chooses "Sync anyway" (`options.allowRemovals`) or raises
 * `maxRemovePercent`; a scheduled run never lifts it on its own.
 */
export async function startSourceSync(
  deps: SyncSchedulerDeps,
  orgId: string,
  sourceId: string,
  options?: SyncRunOptions,
): Promise<SyncStartResult> {
  return startSourceSyncFor(deps, forScheduledSync(deps.db, orgId), orgId, sourceId, options);
}

/**
 * `startSourceSync` through a `Tenant` the caller built from the auth seam:
 * the admin's "Sync now" passes the signed-in principal's tenant and org.
 */
export async function startSourceSyncFor(
  deps: SyncStartDeps,
  tenant: Tenant,
  orgId: string,
  sourceId: string,
  options?: SyncRunOptions,
): Promise<SyncStartResult> {
  const now = deps.now ?? Date.now;
  const source = await tenant.sources.get(sourceId);
  if (source === null || source.kind !== "sitemap") return { status: "not_found" };

  const runId = crypto.randomUUID();
  const startedAt = now();
  if (!(await tenant.sync.acquire(source.id, runId, startedAt, SYNC_LEASE_MS))) {
    return { status: "busy" };
  }
  const fail = async (
    error:
      | "sitemap_unavailable"
      | "sitemap_invalid"
      | "sitemap_empty"
      | "sitemap_index"
      | "limit_refused",
  ): Promise<SyncStartResult> => {
    await tenant.sync.finish(source.id, runId, now(), { outcome: "failed", error });
    return { status: "finished", runId };
  };

  const decision: SyncLimitDecision = deps.limits.checkSync
    ? await deps.limits.checkSync(orgId, source.assistantId, { sourceId: source.id })
    : { ok: true };
  if (!decision.ok) return fail("limit_refused");
  const maxPages = lowest(DEFAULT_SYNC_MAX_PAGES, deps.caps?.maxPages, decision.maxPages);
  const maxDocuments = lowest(
    DEFAULT_SYNC_MAX_DOCUMENTS,
    deps.caps?.maxDocuments,
    decision.maxDocuments,
  );

  const sitemapUrl = typeof source.settings.url === "string" ? source.settings.url : "";
  let xml: string;
  try {
    xml = await fetchSitemapXml(sitemapUrl, deps.fetchImpl ?? fetch, {
      resolveHost: deps.resolveHost,
    });
  } catch {
    // The reason may quote the remote server; only the code is stored.
    return fail("sitemap_unavailable");
  }
  const { entries, truncated, isIndex, wellFormed } = extractSitemapEntries(
    xml,
    MAX_SYNC_SITEMAP_URLS,
  );
  // An index lists other sitemaps, not pages; following it is not done.
  if (isIndex) return fail("sitemap_index");
  // A body that ended early or is broken XML may have lost its last entries;
  // reading it would remove their documents. The preview stays lenient.
  if (!wellFormed) return fail("sitemap_invalid");
  if (entries.length === 0) return fail("sitemap_empty");

  const documents = await tenant.documents.listForSync(source.id);
  const attempts = await tenant.sync.attempts(source.id);
  const planOptions = {
    // A sitemap read only in part says nothing about the pages after the cut.
    removeAllowed: !truncated,
    maxPages,
    maxDocuments,
    now: startedAt,
    recheckMs: recheckMsOf(source.settings),
  };
  const plan = planRun(entries, documents, attempts, planOptions);
  const maxRemovePercent = maxRemovePercentOf(source.settings);
  const allowRemovals = positive(options?.allowRemovals);
  if (
    plan.removed.length * 100 > maxRemovePercent * documents.length &&
    !(allowRemovals !== undefined && plan.removed.length <= allowRemovals)
  ) {
    // Too many would go: change nothing at all. Adding the listed pages
    // while keeping the old ones would grow the source, so the same
    // removals would pass the share check on a later run with nobody
    // looking (a wrong sitemap of the same size would replace every real
    // document in two runs). Only the owner lifts this: "Sync anyway"
    // (`allowRemovals`) or a higher `maxRemovePercent`.
    await tenant.sync.finish(source.id, runId, now(), {
      outcome: "failed",
      error: "too_many_removals",
      withheld: plan.removed.length,
    });
    return { status: "finished", runId };
  }

  const removed =
    plan.removed.length > 0
      ? await removeSourceDocuments(
          { tenant, docs: deps.docs, retriever: deps.retriever },
          source.id,
          plan.removed,
        )
      : 0;
  if (!truncated) {
    // Pages no longer listed need no place in the order.
    const listed = new Set(entries.map((entry) => entry.url));
    await tenant.sync.forgetAttempts(
      source.id,
      [...attempts.keys()].filter((url) => !listed.has(url)),
    );
  }
  const known = { unchanged: plan.unchanged, removed, deferred: plan.deferred };

  if (plan.pages.length === 0) {
    await tenant.sync.finish(source.id, runId, now(), {
      outcome: "succeeded",
      error: null,
      ...known,
    });
    return { status: "finished", runId };
  }

  // Recorded before sending, so every message finds its page.
  await tenant.sync.plan(source.id, runId, known, plan.pages, startedAt);
  await sendPageMessages(
    deps.queue,
    plan.pages.map((page) => ({
      kind: "sync_page",
      orgId,
      sourceId: source.id,
      runId,
      url: page.url,
    })),
  );
  return { status: "queued", runId, queued: plan.pages.length };
}

export interface DueSyncsResult {
  /** Sources a run was started for (queued or finished at once). */
  started: string[];
  /** Due sources whose org the auth seam refused. */
  refusedOrgs: number;
}

/**
 * Starts the sitemap sources that are due: schedule `daily` or `weekly`, no
 * run holding them, and a full interval (less `SYNC_DUE_SLACK_MS`) since the
 * last run started. At most `maxSources` per call, oldest first; call it from
 * a cron. Each org is passed to the auth seam first, and an org it refuses is
 * skipped without reading anything of it; the refusal is recorded so that
 * the next calls take every other due source before asking about it again.
 * Safe to call twice at once: the lease lets only one run per source start.
 */
export async function runDueSyncs(deps: SyncSchedulerDeps): Promise<DueSyncsResult> {
  const now = (deps.now ?? Date.now)();
  const maxSources = positive(deps.maxSources) ?? MAX_SYNC_SOURCES_PER_TICK;
  const due = await dueSitemapSources(deps.db, {
    now,
    dailyMs: SYNC_INTERVAL_MS.daily - SYNC_DUE_SLACK_MS,
    weeklyMs: SYNC_INTERVAL_MS.weekly - SYNC_DUE_SLACK_MS,
    limit: Math.max(maxSources, DUE_CANDIDATES_PER_TICK),
  });

  const result: DueSyncsResult = { started: [], refusedOrgs: 0 };
  const vouched = new Map<string, string | null>();
  for (const candidate of due) {
    if (result.started.length >= maxSources) break;
    let orgId = vouched.get(candidate.claimedOrgId);
    if (orgId === undefined) {
      orgId = await deps.resolveOrg(candidate.claimedOrgId);
      vouched.set(candidate.claimedOrgId, orgId);
      if (orgId === null) {
        result.refusedOrgs++;
        try {
          await recordSyncRefusal(deps.db, candidate.claimedOrgId, now);
        } catch (err) {
          console.warn("sync: could not record a refused org", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    if (orgId === null) continue;
    try {
      const started = await startSourceSync(deps, orgId, candidate.sourceId);
      if (started.status === "queued" || started.status === "finished") {
        result.started.push(candidate.sourceId);
      }
    } catch (err) {
      // One source's failure must not stop the others; its lease runs out
      // and the run is then reported as interrupted.
      console.warn("sync: could not start a run", {
        sourceId: candidate.sourceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

export interface SyncPageDeps {
  tenant: Tenant;
  orgId: string;
  docs: PushDeps["docs"];
  queue: PushDeps["queue"];
  pages: PageFetcher;
  now?: (() => number) | undefined;
}

/**
 * Handles one page of a run: fetches it through the page-fetcher seam with
 * the validators stored last time, writes it through `pushDocuments` (whose
 * unchanged `content_hash` is a no-op, so nothing is re-embedded), stores the
 * new validators, and marks the page done. A message for a run that is no
 * longer current, or a page already handled, does nothing. So does one whose
 * run's lease ran out while the page was being fetched: the run is checked
 * again after the fetch, and every write (the document, its validators, the
 * page's state and the run's end) carries the same check itself.
 *
 * Throws only for a fault worth retrying (D1, R2, the queue); a page that
 * cannot be fetched or is not a page is recorded as failed.
 */
export async function processSyncPage(
  message: SyncPageMessage,
  deps: SyncPageDeps,
  attempts = 1,
): Promise<SyncPageState | null> {
  const now = deps.now ?? Date.now;
  const { tenant } = deps;
  const page = await tenant.sync.pendingPage(message.sourceId, message.runId, message.url, now());
  if (page === null) return null;
  const source = await tenant.sources.get(message.sourceId);
  if (source === null || source.kind !== "sitemap") return null;

  const complete = async (state: Exclude<SyncPageState, "pending">) => {
    await tenant.sync.completePage(source.id, message.runId, page.url, state, now());
    return state;
  };
  const fence = () => ({ runId: message.runId, now: now() });

  try {
    const externalId = await hashUrlExternalId(page.url);
    const prev = await tenant.documents.syncValidators(source.id, externalId);
    let fetched: Awaited<ReturnType<PageFetcher["fetchPage"]>>;
    try {
      fetched = await deps.pages.fetchPage(
        page.url,
        prev ? { etag: prev.etag, lastModified: prev.lastModified } : undefined,
      );
    } catch {
      // Refused, timed out or unreachable: the next run tries again.
      return complete("failed");
    }
    // The fetch may have outlasted the run's lease.
    if (!(await tenant.sync.holds(source.id, message.runId, now()))) return null;

    let title: string;
    let markdown: string;
    if (fetched.kind === "not_modified") {
      if (prev === null) return complete("failed");
      // Unchanged content still owed its indexing (an earlier attempt failed
      // and its retries ran out) is queued again, as `pushDocuments` does for
      // an unchanged push; the consumer ignores it once indexed.
      if (prev.indexedHash !== prev.contentHash && prev.bodyKey !== null) {
        await deps.queue.send({
          orgId: deps.orgId,
          documentId: prev.id,
          contentHash: prev.contentHash,
        });
      }
      await tenant.documents.recordSyncCheck(
        source.id,
        externalId,
        {
          etag: fetched.etag,
          lastModified: fetched.lastModified,
          sitemapLastmod: page.lastmod,
          checkedAt: now(),
        },
        fence(),
      );
      return complete("unchanged");
    }
    if (fetched.kind === "page") {
      ({ title, markdown } = fetched);
    } else if (fetched.reason === "empty") {
      // As the one-time import does: a page that lost its text replaces the
      // old copy rather than leaving it searchable.
      title = fetched.title ?? new URL(page.url).pathname;
      markdown = `# ${title}`;
    } else {
      return complete("failed");
    }

    let counts: { written: number; unchanged: number };
    try {
      counts = await pushDocuments(
        { tenant, docs: deps.docs, queue: deps.queue },
        { orgId: deps.orgId, assistantId: source.assistantId },
        { sourceId: source.id, documents: [{ externalId, url: page.url, title, markdown }] },
        { syncRun: { runId: message.runId, now } },
      );
    } catch (err) {
      if (err instanceof SyncRunEnded) return null;
      if (err instanceof BadRequest || err instanceof TooLarge) return complete("failed");
      throw err;
    }
    await tenant.documents.recordSyncCheck(
      source.id,
      externalId,
      {
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        sitemapLastmod: page.lastmod,
        checkedAt: now(),
      },
      fence(),
    );
    if (counts.written === 0) return complete("unchanged");
    return complete(prev === null ? "added" : "updated");
  } catch (err) {
    if (attempts >= SYNC_PAGE_MAX_ATTEMPTS) return complete("failed");
    throw err;
  }
}

/** Runs `processSyncPage` for each message, acknowledging or retrying each on its own. */
export async function runSyncPageBatch(
  messages: ReadonlyArray<Message<unknown>>,
  deps: SyncPageDeps,
): Promise<void> {
  for (const message of messages) {
    // The org was resolved for the whole group by the caller; a message whose
    // run is not in that org finds no pending page and does nothing.
    if (!isSyncPageMessage(message.body)) {
      message.ack();
      continue;
    }
    try {
      await processSyncPage(message.body, deps, message.attempts);
      message.ack();
    } catch (err) {
      console.warn("sync: page message failed, scheduling retry", {
        messageId: message.id,
        error: err instanceof Error ? err.message : String(err),
      });
      message.retry();
    }
  }
}
