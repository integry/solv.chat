import { prepare } from "./sql.js";

interface Row {
  cost_micros: number;
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
        .first<Row>();
      return row ? row.cost_micros : null;
    },
  };
}
