import { utcDay } from "../../util/time.js";
import type { UsageSink } from "../types.js";

/** Records usage into `usage_daily` with an atomic upsert. */
export function usageDaily(db: D1Database): UsageSink {
  return {
    async record(event) {
      const day = utcDay(event.at);
      await db
        .prepare(
          `INSERT INTO usage_daily (org_id, assistant_id, day, messages, tokens_in, tokens_out, cost_micros)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(org_id, assistant_id, day) DO UPDATE SET
             messages = usage_daily.messages + excluded.messages,
             tokens_in = usage_daily.tokens_in + excluded.tokens_in,
             tokens_out = usage_daily.tokens_out + excluded.tokens_out,
             cost_micros = usage_daily.cost_micros + excluded.cost_micros`,
        )
        .bind(
          event.orgId,
          event.assistantId,
          day,
          event.messages,
          event.tokensIn,
          event.tokensOut,
          event.costMicros,
        )
        .run();
    },
  };
}
