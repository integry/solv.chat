import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { SINGLE_ORG_ID } from "../../src/seams/open/passwordAuth.js";
import { usageDaily } from "../../src/seams/open/usageDaily.js";

describe("usageDaily", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM usage_daily").run();
  });

  it("accumulates same-day events into one row and separates other days and assistants", async () => {
    const sink = usageDaily(env.DB);
    const day1 = Date.UTC(2026, 0, 10, 12, 0, 0);
    const day2 = Date.UTC(2026, 0, 11, 8, 0, 0);

    await sink.record({
      orgId: SINGLE_ORG_ID,
      assistantId: "ast_1",
      at: day1,
      messages: 1,
      tokensIn: 100,
      tokensOut: 50,
      costMicros: 400,
    });
    await sink.record({
      orgId: SINGLE_ORG_ID,
      assistantId: "ast_1",
      at: day1 + 3_600_000,
      messages: 2,
      tokensIn: 200,
      tokensOut: 75,
      costMicros: 600,
    });
    await sink.record({
      orgId: SINGLE_ORG_ID,
      assistantId: "ast_1",
      at: day2,
      messages: 1,
      tokensIn: 10,
      tokensOut: 5,
      costMicros: 50,
    });
    await sink.record({
      orgId: SINGLE_ORG_ID,
      assistantId: "ast_2",
      at: day1,
      messages: 1,
      tokensIn: 20,
      tokensOut: 10,
      costMicros: 100,
    });

    const rows = await env.DB.prepare(
      "SELECT assistant_id, day, messages, tokens_in, tokens_out, cost_micros FROM usage_daily WHERE org_id = ?1 ORDER BY assistant_id, day",
    )
      .bind(SINGLE_ORG_ID)
      .all<{
        assistant_id: string;
        day: string;
        messages: number;
        tokens_in: number;
        tokens_out: number;
        cost_micros: number;
      }>();

    expect(rows.results).toEqual([
      {
        assistant_id: "ast_1",
        day: "2026-01-10",
        messages: 3,
        tokens_in: 300,
        tokens_out: 125,
        cost_micros: 1000,
      },
      {
        assistant_id: "ast_1",
        day: "2026-01-11",
        messages: 1,
        tokens_in: 10,
        tokens_out: 5,
        cost_micros: 50,
      },
      {
        assistant_id: "ast_2",
        day: "2026-01-10",
        messages: 1,
        tokens_in: 20,
        tokens_out: 10,
        cost_micros: 100,
      },
    ]);
  });

  it("writes nothing for an event that counts nothing, such as a review outcome", async () => {
    await usageDaily(env.DB).record({
      orgId: SINGLE_ORG_ID,
      assistantId: "ast_1",
      at: Date.UTC(2026, 0, 10),
      messages: 0,
      tokensIn: 0,
      tokensOut: 0,
      costMicros: 0,
      review: { messageId: "msg_1", outcome: "answered", confidence: null },
    });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_daily").first<{
      n: number;
    }>();
    expect(row?.n).toBe(0);
  });
});
