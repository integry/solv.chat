import { DEFAULT_SYNC_MAX_REMOVE_PERCENT, type SyncSchedule } from "@solvchat/core";
import { BadRequest } from "../admin/errors.js";
import {
  extractSitemapEntries,
  fetchSitemapXml,
  hashUrlExternalId,
  type SitemapEntry,
} from "../admin/sitemap.js";
import type { DocumentSyncRow } from "../db/documents.js";
import { dueSitemapSources, type SyncPage, type SyncPageState } from "../db/sync.js";
import { forScheduledSync, type Tenant } from "../db/tenant.js";
import type { Retriever } from "../providers/retrieval.js";
import type { Limits, PageFetcher, SyncLimitDecision } from "../seams/types.js";
import type { HostResolver } from "../security/urlGuard.js";
import {
  type IngestQueueMessage,
  type PushDeps,
  pushDocuments,
  removeSourceDocuments,
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
// runs, the pages checked longest ago first. Ours.
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
 * Decides what one run does, from the sitemap and the source's documents:
 * what to remove, what to skip on an unchanged `<lastmod>`, and which pages
 * to fetch (new pages first, then the ones checked longest ago), within the
 * caps. Pages left out are counted as deferred.
 */
function planRun(
  entries: SitemapEntry[],
  documents: DocumentSyncRow[],
  options: { removeAllowed: boolean; maxPages: number; maxDocuments: number },
): Plan {
  const listed = new Set(entries.map((entry) => entry.url));
  const byUrl = new Map(documents.map((doc) => [doc.url, doc]));
  const removed = options.removeAllowed ? documents.filter((doc) => !listed.has(doc.url)) : [];

  let unchanged = 0;
  const added: SyncPage[] = [];
  const checks: Array<{ page: SyncPage; checkedAt: number }> = [];
  for (const entry of entries) {
    const doc = byUrl.get(entry.url);
    if (doc === undefined) {
      added.push({ url: entry.url, lastmod: entry.lastmod });
    } else if (entry.lastmod !== null && doc.sitemapLastmod === entry.lastmod) {
      unchanged++;
    } else {
      checks.push({
        page: { url: entry.url, lastmod: entry.lastmod },
        checkedAt: doc.syncCheckedAt ?? 0,
      });
    }
  }
  checks.sort((a, b) => a.checkedAt - b.checkedAt);

  const room = Math.max(0, options.maxDocuments - (documents.length - removed.length));
  const addable = added.slice(0, room);
  const queue = [...addable, ...checks.map((c) => c.page)];
  const pages = queue.slice(0, options.maxPages);
  const deferred = added.length - addable.length + (queue.length - pages.length);
  return { removed, unchanged, deferred, pages };
}

/**
 * Starts one sync run of a sitemap source in an org the auth seam vouched
 * for. Takes the source's lease (or answers `busy`), asks the Limits seam,
 * reads the sitemap, removes documents whose URL left it (unless the guard
 * trips), and queues one message per page to fetch.
 *
 * The guard: a sitemap that cannot be read, lists no page, or would remove
 * more than the source's `maxRemovePercent` (default 50%) of its documents
 * removes nothing, fetches nothing, and records the run as failed.
 */
export async function startSourceSync(
  deps: SyncSchedulerDeps,
  orgId: string,
  sourceId: string,
): Promise<SyncStartResult> {
  const now = deps.now ?? Date.now;
  const tenant = forScheduledSync(deps.db, orgId);
  const source = await tenant.sources.get(sourceId);
  if (source === null || source.kind !== "sitemap") return { status: "not_found" };

  const runId = crypto.randomUUID();
  const startedAt = now();
  if (!(await tenant.sync.acquire(source.id, runId, startedAt, SYNC_LEASE_MS))) {
    return { status: "busy" };
  }
  const fail = async (
    error: "sitemap_unavailable" | "sitemap_empty" | "too_many_removals" | "limit_refused",
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
  const { entries, truncated, isIndex } = extractSitemapEntries(xml, MAX_SYNC_SITEMAP_URLS);
  if (entries.length === 0 || isIndex) return fail("sitemap_empty");

  const documents = await tenant.documents.listForSync(source.id);
  const plan = planRun(entries, documents, {
    // A sitemap read only in part says nothing about the pages after the cut.
    removeAllowed: !truncated,
    maxPages,
    maxDocuments,
  });
  const maxRemovePercent = maxRemovePercentOf(source.settings);
  if (plan.removed.length * 100 > maxRemovePercent * documents.length) {
    return fail("too_many_removals");
  }

  const removed =
    plan.removed.length > 0
      ? await removeSourceDocuments(
          { tenant, docs: deps.docs, retriever: deps.retriever },
          source.id,
          plan.removed,
        )
      : 0;
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
  await tenant.sync.plan(source.id, runId, known, plan.pages);
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
 * skipped without reading anything of it. Safe to call twice at once: the
 * lease lets only one run per source start.
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
      if (orgId === null) result.refusedOrgs++;
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
 * longer current, or a page already handled, does nothing.
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

    let title: string;
    let markdown: string;
    if (fetched.kind === "not_modified") {
      if (prev === null) return complete("failed");
      await tenant.documents.recordSyncCheck(source.id, externalId, {
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        sitemapLastmod: page.lastmod,
        checkedAt: now(),
      });
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
      );
    } catch (err) {
      if (err instanceof BadRequest || err instanceof TooLarge) return complete("failed");
      throw err;
    }
    await tenant.documents.recordSyncCheck(source.id, externalId, {
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      sitemapLastmod: page.lastmod,
      checkedAt: now(),
    });
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
