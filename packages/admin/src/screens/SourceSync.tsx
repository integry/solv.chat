import {
  DEFAULT_SYNC_MAX_REMOVE_PERCENT,
  type SourceSyncStatus,
  type SyncCounts,
  type SyncErrorCode,
  type SyncSchedule,
} from "@solvchat/core";
import { useId } from "react";
import type { SourceSummary } from "../api/types.js";
import { RelativeTime } from "../ui/DateText.js";
import { StatusBadge } from "../ui/StatusBadge.js";

export const SCHEDULE_OPTIONS: ReadonlyArray<{ value: SyncSchedule; label: string }> = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
];

/**
 * How many documents "Sync anyway" would remove: those the last run kept
 * because it would have removed too many. Zero when there is nothing to offer.
 */
export function withheldRemovals(sync: SourceSyncStatus | undefined): number {
  const last = sync?.last;
  if (last?.outcome !== "failed" || last.error !== "too_many_removals") return 0;
  return last.counts.withheld;
}

/** True while a sync of the source is going. */
export function isSyncing(source: SourceSummary): boolean {
  return source.sync?.last?.outcome === "running";
}

function maxRemovePercent(source: Pick<SourceSummary, "settings"> | undefined): number {
  const value = source?.settings.maxRemovePercent;
  return typeof value === "number" ? value : DEFAULT_SYNC_MAX_REMOVE_PERCENT;
}

/**
 * Why a sync failed or was partial, in plain words. `source` gives the share
 * of pages a sync may remove; without it the sentence leaves the number out.
 */
export function syncErrorText(
  code: SyncErrorCode | null,
  source?: Pick<SourceSummary, "settings">,
): string {
  switch (code) {
    case "sitemap_unavailable":
      return "The sitemap could not be read. Check that its address still works.";
    case "sitemap_invalid":
      return "The sitemap is incomplete or not valid, so nothing was changed.";
    case "sitemap_empty":
      return "The sitemap lists no pages, so nothing was changed.";
    case "sitemap_index":
      return "This is a sitemap index; use one of the sitemaps it lists.";
    case "too_many_removals":
      return source
        ? `It would have removed more than ${maxRemovePercent(source)}% of this source's pages, so none were removed. Pages the sitemap lists were still added and updated. Check that the sitemap is complete, or choose Sync anyway.`
        : "It would have removed too many of this source's pages, so none were removed. Pages the sitemap lists were still added and updated. Check that the sitemap is complete, or choose Sync anyway.";
    case "limit_refused":
      return "Syncing is not available on this account right now.";
    case "pages_failed":
      return "Some pages could not be fetched. They are tried again on a later sync.";
    case "interrupted":
      return "The sync took too long and was stopped. The next sync tries again.";
    default:
      return "Something went wrong. Try Sync now again.";
  }
}

/** "2 added, 1 updated, 40 unchanged", leaving out what is zero. */
export function syncCountsText(counts: SyncCounts): string {
  const parts: string[] = [];
  if (counts.added > 0) parts.push(`${counts.added} added`);
  if (counts.updated > 0) parts.push(`${counts.updated} updated`);
  if (counts.unchanged > 0) parts.push(`${counts.unchanged} unchanged`);
  if (counts.removed > 0) parts.push(`${counts.removed} removed`);
  if (counts.failed > 0) parts.push(`${counts.failed} could not be fetched`);
  if (counts.deferred > 0) parts.push(`${counts.deferred} left for the next sync`);
  if (counts.withheld > 0) parts.push(`${counts.withheld} kept, not removed`);
  return parts.length > 0 ? parts.join(", ") : "nothing changed";
}

/** The Status column while a sync is going, shown like "Indexing…" and an import's progress. */
export function SyncingStatus({ sync }: { sync: SourceSyncStatus }) {
  const progress = sync.last?.progress;
  if (!progress || progress.total === 0) {
    return (
      <div className="source-status">
        <StatusBadge tone="info">Syncing…</StatusBadge>
        <span className="source-status-hint">Reading the sitemap.</span>
      </div>
    );
  }
  return (
    <div className="import-progress" role="status">
      <span>
        Syncing {progress.done} of {progress.total === 1 ? "1 page" : `${progress.total} pages`}…
      </span>
      <progress max={progress.total} value={progress.done} aria-label="Syncing" />
    </div>
  );
}

function LastRun({ source, sync }: { source: SourceSummary; sync: SourceSyncStatus }) {
  const last = sync.last;
  if (last === null) return <span className="source-sync-line muted">Never synced.</span>;
  if (last.outcome === "running") {
    return (
      <span className="source-sync-line muted">
        Started <RelativeTime value={last.startedAt} />.
      </span>
    );
  }
  const at = last.finishedAt ?? last.startedAt;
  if (last.outcome === "failed") {
    const withheld = withheldRemovals(sync);
    return (
      <>
        <span className="source-sync-line source-sync-failed">
          {withheld > 0 ? (
            <>
              Last sync failed <RelativeTime value={at} />: {syncCountsText(last.counts)}.
            </>
          ) : (
            <>
              Last sync failed <RelativeTime value={at} />.
            </>
          )}
        </span>
        <span className="source-sync-line source-sync-failed">
          {syncErrorText(last.error, source)}
        </span>
      </>
    );
  }
  return (
    <>
      <span className="source-sync-line">
        Last synced <RelativeTime value={at} />: {syncCountsText(last.counts)}.
      </span>
      {last.outcome === "partial" && (
        <span className="source-sync-line source-sync-failed">
          {syncErrorText(last.error, source)}
        </span>
      )}
    </>
  );
}

function NextRun({ sync, now }: { sync: SourceSyncStatus; now: number }) {
  if (sync.last?.outcome === "running") return null;
  if (sync.schedule === "off" || sync.nextSyncAt === null) {
    return <span className="source-sync-line muted">Syncs only when you choose Sync now.</span>;
  }
  if (sync.nextSyncAt <= now) {
    return <span className="source-sync-line muted">Next sync: soon.</span>;
  }
  return (
    <span className="source-sync-line muted">
      Next sync <RelativeTime value={sync.nextSyncAt} now={now} />.
    </span>
  );
}

export interface SyncCellProps {
  source: SourceSummary;
  sync: SourceSyncStatus;
  name: string;
  /** A schedule change or Sync now request for this source is in flight. */
  busy: boolean;
  onScheduleChange: (schedule: SyncSchedule) => void;
  onSyncNow: () => void;
  /**
   * Offered after a sync kept pages because it would have removed too many:
   * one sync with that limit lifted. Left out, the button is not shown.
   */
  onSyncAnyway?: (() => void) | undefined;
  now?: number;
}

/** The Sync column of a sitemap source: its schedule, latest run, next run and Sync now. */
export function SyncCell({
  source,
  sync,
  name,
  busy,
  onScheduleChange,
  onSyncNow,
  onSyncAnyway,
  now = Date.now(),
}: SyncCellProps) {
  const selectId = useId();
  const running = sync.last?.outcome === "running";
  const withheld = withheldRemovals(sync);
  return (
    <div className="source-sync">
      <div className="source-sync-controls">
        <label htmlFor={selectId} className="sr-only">
          How often {name} syncs
        </label>
        <select
          id={selectId}
          className="select"
          value={sync.schedule}
          disabled={busy}
          onChange={(e) => onScheduleChange(e.target.value as SyncSchedule)}
        >
          {SCHEDULE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          aria-label={`Sync ${name} now`}
          disabled={busy || running}
          onClick={onSyncNow}
        >
          {running ? "Syncing…" : "Sync now"}
        </button>
        {onSyncAnyway && withheld > 0 && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-label={`Sync ${name} anyway`}
            disabled={busy || running}
            onClick={onSyncAnyway}
          >
            Sync anyway
          </button>
        )}
      </div>
      <LastRun source={source} sync={sync} />
      <NextRun sync={sync} now={now} />
    </div>
  );
}
