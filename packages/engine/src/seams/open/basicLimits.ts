import { usageFor } from "../../db/usage.js";
import { utcDay } from "../../util/time.js";
import type { Limits } from "../types.js";

// 20 per minute per IP: a real person never notices, a script does. The spec
// says "per-IP rate limit" and gives no number, so this one is ours.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
export const DEFAULT_DAILY_CAP_MICROS = 2_000_000;

export type CapMicrosResolver = (orgId: string, assistantId: string) => Promise<number>;

async function todaysSpend(db: D1Database, orgId: string, assistantId: string): Promise<number> {
  return (await usageFor(db, orgId).costMicrosFor(assistantId, utcDay(Date.now()))) ?? 0;
}

/**
 * Enforces per-IP chat rate limits and daily assistant spend caps.
 *
 * The spend cap applies to chat only. Ingest (`solv push`, `solv apply`) is
 * the owner's own content and configuration: refusing it because visitors
 * used up the day's chat budget would block the owner from fixing the very
 * answers that are costing money. Embedding spend is still metered into
 * `usage_daily`, so it counts towards the next chat check.
 */
export function basicLimits(
  db: D1Database,
  // Injected so this can land before assistant_versions exists; the admin API
  // task swaps in the published version's cap.
  capMicrosFor: CapMicrosResolver = async () => DEFAULT_DAILY_CAP_MICROS,
): Limits {
  return {
    async check(orgId, assistantId, action) {
      if (action.kind === "chat") {
        const windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
        // Increment and read in one statement: two statements would let two
        // simultaneous requests both see the pre-increment count and pass.
        const row = await db
          .prepare(
            `INSERT INTO rate_counters (org_id, assistant_id, ip, window_start, hits)
             VALUES (?1, ?2, ?3, ?4, 1)
             ON CONFLICT(org_id, assistant_id, ip, window_start) DO UPDATE SET hits = hits + 1
             RETURNING hits`,
          )
          .bind(orgId, assistantId, action.ip, windowStart)
          .first<{ hits: number }>();
        if (row?.hits === 1) {
          // The first hit of a new window for this IP: a cheap moment to drop
          // windows that can no longer limit anything, so the table holds
          // roughly one minute of visitors instead of every minute ever.
          await db
            .prepare("DELETE FROM rate_counters WHERE org_id = ?1 AND window_start < ?2")
            .bind(orgId, windowStart)
            .run();
        }
        if ((row?.hits ?? 0) > MAX_PER_WINDOW) {
          return { ok: false, reason: "rate_limit" };
        }
      }
      if (action.kind !== "chat") return { ok: true };
      const cap = await capMicrosFor(orgId, assistantId);
      // 0 means "no cap": an owner who never set one should not be locked out.
      if (cap > 0 && (await todaysSpend(db, orgId, assistantId)) >= cap) {
        return { ok: false, reason: "spend_cap" };
      }
      return { ok: true };
    },
  };
}
