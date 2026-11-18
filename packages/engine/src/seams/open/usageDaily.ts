import { utcDay } from "../../util/time.js";
import type { UsageSink } from "../types.js";

/** Records usage into `usage_daily` with an atomic upsert. */
export function usageDaily(db: D1Database): UsageSink {
  return {
    async record(event) {
      // An event that counts nothing (the outcome of an answer review) is
      // extra data for a host; there is nothing to add to usage_daily.
      if (
        event.messages === 0 &&
        event.tokensIn === 0 &&
        event.tokensOut === 0 &&
        event.costMicros === 0 &&
        !event.costUnknown
      ) {
        return;
      }
      const day = utcDay(event.at);
      await db
        .prepare(
          `INSERT INTO usage_daily (org_id, assistant_id, day, messages, tokens_in, tokens_out, cost_micros, cost_unknown)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(org_id, assistant_id, day) DO UPDATE SET
             messages = usage_daily.messages + excluded.messages,
             tokens_in = usage_daily.tokens_in + excluded.tokens_in,
             tokens_out = usage_daily.tokens_out + excluded.tokens_out,
             cost_micros = usage_daily.cost_micros + excluded.cost_micros,
             cost_unknown = usage_daily.cost_unknown + excluded.cost_unknown`,
        )
        .bind(
          event.orgId,
          event.assistantId,
          day,
          event.messages,
          event.tokensIn,
          event.tokensOut,
          event.costMicros,
          event.costUnknown ? 1 : 0,
        )
        .run();
    },
  };
}
