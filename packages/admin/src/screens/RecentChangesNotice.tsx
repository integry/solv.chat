import { useEffect, useRef } from "react";
import { useResource } from "../api/useResource.js";

/** `GET /api/admin/assistants/:id/content-status`. */
export interface ContentStatus {
  settling: boolean;
  indexing: number;
  settlesAt: number | null;
}

/** How often the notice checks again while it is shown. */
export const CONTENT_STATUS_POLL_MS = 30_000;

export const RECENT_CHANGES_TEXT =
  "Recent changes to your content can take a few minutes to appear in answers.";

/**
 * Says that answers may not show the latest content changes yet: shown
 * while pages are waiting to be indexed and for a few minutes after content
 * was added, rebuilt or removed, because the search index catches up on its
 * own time. Checks again until that is over. `refresh` is any value that
 * changes when content may have changed (the Sources list, an answer), and
 * `active` false skips the check (a hidden pane).
 */
export function RecentChangesNotice({
  assistantId,
  refresh,
  active = true,
  className,
}: {
  assistantId: string;
  refresh?: unknown;
  active?: boolean;
  className?: string | undefined;
}) {
  const status = useResource<ContentStatus>(
    active ? `/api/admin/assistants/${assistantId}/content-status` : null,
  );
  const reload = status.reload;
  // A new list or answer: content may have changed since the last check.
  // The first value is what the mount's own load already reads.
  const lastRefresh = useRef(refresh);
  useEffect(() => {
    if (Object.is(lastRefresh.current, refresh)) return;
    lastRefresh.current = refresh;
    reload();
  }, [refresh, reload]);

  const value = status.value;
  const settling = active && value?.settling === true;
  useEffect(() => {
    if (!settling || value === undefined) return;
    // Checked again on the poll, or just after the notice is due to end.
    const untilEnd =
      value.settlesAt === null ? Number.POSITIVE_INFINITY : value.settlesAt - Date.now();
    const delay = Math.max(1_000, Math.min(CONTENT_STATUS_POLL_MS, untilEnd + 1_000));
    const timer = setTimeout(reload, delay);
    return () => clearTimeout(timer);
  }, [settling, value, reload]);

  if (!settling) return null;
  return (
    <p
      className={`notice notice-info recent-changes-notice${className ? ` ${className}` : ""}`}
      role="status"
    >
      {RECENT_CHANGES_TEXT}
    </p>
  );
}
