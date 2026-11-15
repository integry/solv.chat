import { prepare } from "./sql.js";

interface Row {
  cost_micros: number;
  cost_unknown: number;
}

export interface DailyUsageSummary {
  costMicros: number;
  costUnknown: boolean;
}

/** Tenant-scoped data access for `usage_daily`. */
export function usageFor(db: D1Database, orgId: string) {
  return {
    async costMicrosFor(assistantId: string, day: string): Promise<number | null> {
      const row = await prepare(
        db,
        `SELECT cost_micros
         FROM usage_daily
         WHERE org_id = ?1 AND assistant_id = ?2 AND day = ?3`,
      )
        .bind(orgId, assistantId, day)
        .first<Pick<Row, "cost_micros">>();
      return row ? row.cost_micros : null;
    },

    async summaryFor(assistantId: string, day: string): Promise<DailyUsageSummary | null> {
      const row = await prepare(
        db,
        `SELECT cost_micros, cost_unknown
         FROM usage_daily
         WHERE org_id = ?1 AND assistant_id = ?2 AND day = ?3`,
      )
        .bind(orgId, assistantId, day)
        .first<Row>();
      return row ? { costMicros: row.cost_micros, costUnknown: row.cost_unknown > 0 } : null;
    },
  };
}
