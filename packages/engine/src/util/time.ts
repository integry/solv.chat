/**
 * Formats a UTC timestamp in milliseconds as `YYYY-MM-DD`.
 *
 * Lives outside `seams/open/` so the application (the admin Overview) and the
 * open seam implementations share one definition of "today" without the
 * application importing an open implementation.
 */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}
