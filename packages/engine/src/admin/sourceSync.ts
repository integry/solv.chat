import {
  isPlainObject,
  type SourceSyncRun,
  type SourceSyncStatus,
  SYNC_SCHEDULES,
  type SyncSchedule,
} from "@solvchat/core";
import type { SourceRow } from "../db/sources.js";
import type { SourceSyncState } from "../db/sync.js";
import type { Tenant } from "../db/tenant.js";
import {
  SYNC_DUE_SLACK_MS,
  SYNC_INTERVAL_MS,
  type SyncRunOptions,
  type SyncStartDeps,
  startSourceSyncFor,
} from "../ingest/sync.js";
import { BadRequest, Conflict, NotFound } from "./errors.js";

export type { SourceSyncStatus } from "@solvchat/core";

function scheduleOf(settings: Record<string, unknown>): SyncSchedule {
  const value = settings.sync;
  return SYNC_SCHEDULES.includes(value as SyncSchedule) ? (value as SyncSchedule) : "off";
}

function toRun(state: SourceSyncState): SourceSyncRun {
  return {
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    outcome: state.outcome,
    counts: state.counts,
    error: state.error,
    progress: state.progress,
  };
}

/**
 * A sitemap source's schedule, latest run and next due time, as the Sources
 * list shows them. The due time is the scheduler's own rule (a full interval
 * less the slack since the last run started); a source never synced is due
 * at once.
 */
export function syncStatusFor(
  source: Pick<SourceRow, "settings">,
  state: SourceSyncState | null,
  now: number,
): SourceSyncStatus {
  const schedule = scheduleOf(source.settings);
  const running = state !== null && state.outcome === "running";
  let nextSyncAt: number | null = null;
  if (schedule !== "off" && !running) {
    nextSyncAt =
      state === null ? now : state.startedAt + SYNC_INTERVAL_MS[schedule] - SYNC_DUE_SLACK_MS;
  }
  return { schedule, last: state ? toRun(state) : null, nextSyncAt };
}

async function sitemapSource(tenant: Tenant, sourceId: string): Promise<SourceRow> {
  const source = await tenant.sources.get(sourceId);
  if (source === null) throw new NotFound("source");
  if (source.kind !== "sitemap") {
    throw new BadRequest(["source: only sitemap sources sync"]);
  }
  return source;
}

/** `GET /api/admin/sources/:id/sync`. */
export async function getSourceSync(
  tenant: Tenant,
  sourceId: string,
  now: number = Date.now(),
): Promise<SourceSyncStatus> {
  const source = await sitemapSource(tenant, sourceId);
  return syncStatusFor(source, await tenant.sync.get(sourceId, now), now);
}

/**
 * `POST /api/admin/sources/:id/sync`: starts a run of the source now,
 * whatever its schedule, through the same steps as a scheduled run (lease,
 * Limits seam, wipe guard, caps). The sitemap is read in this request; its
 * pages are fetched by the queue afterwards. A run already going is a
 * conflict, not a second run. `options.allowRemovals` is "Sync anyway":
 * the removal-share guard is lifted for this run, up to that many removals.
 */
export async function syncSourceNow(
  deps: SyncStartDeps,
  tenant: Tenant,
  orgId: string,
  sourceId: string,
  options?: SyncRunOptions,
): Promise<SourceSyncStatus> {
  const source = await sitemapSource(tenant, sourceId);
  const started = await startSourceSyncFor(deps, tenant, orgId, source.id, options);
  if (started.status === "not_found") throw new NotFound("source");
  if (started.status === "busy") throw new Conflict("This source is already syncing.");
  const now = (deps.now ?? Date.now)();
  return syncStatusFor(source, await tenant.sync.get(source.id, now), now);
}

/**
 * Reads the optional body of `POST /api/admin/sources/:id/sync`: none (or
 * `{}`) for Sync now, `{ "allowRemovals": n }` for Sync anyway.
 */
export async function readSyncNowBody(request: Request): Promise<SyncRunOptions> {
  const text = await request.text();
  if (text.trim() === "") return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequest(["body: must be valid JSON"]);
  }
  if (!isPlainObject(body)) throw new BadRequest(["body: must be a JSON object"]);
  const value = body.allowRemovals;
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BadRequest(["allowRemovals: must be a whole number, 0 or more"]);
  }
  return { allowRemovals: value };
}
