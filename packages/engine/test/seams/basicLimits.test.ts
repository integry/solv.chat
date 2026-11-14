import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { basicLimits } from "../../src/seams/open/basicLimits.js";
import { SINGLE_ORG_ID } from "../../src/seams/open/passwordAuth.js";
import { usageDaily } from "../../src/seams/open/usageDaily.js";

describe("basicLimits", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM rate_counters").run();
    await env.DB.prepare("DELETE FROM usage_daily").run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces daily spend cap", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 2, 1, 12, 0, 0);
    vi.setSystemTime(now);

    const sink = usageDaily(env.DB);
    const limits = basicLimits(env.DB, async () => 1000);

    await sink.record({
      orgId: SINGLE_ORG_ID,
      assistantId: "ast_1",
      at: now,
      messages: 1,
      tokensIn: 10,
      tokensOut: 10,
      costMicros: 999,
    });
    expect(
      await limits.check(SINGLE_ORG_ID, "ast_1", { kind: "chat", ip: "198.51.100.1" }),
    ).toEqual({
      ok: true,
    });

    await sink.record({
      orgId: SINGLE_ORG_ID,
      assistantId: "ast_1",
      at: now,
      messages: 1,
      tokensIn: 1,
      tokensOut: 1,
      costMicros: 1,
    });
    expect(
      await limits.check(SINGLE_ORG_ID, "ast_1", { kind: "chat", ip: "198.51.100.1" }),
    ).toEqual({
      ok: false,
      reason: "spend_cap",
    });
  });

  it("enforces per-IP rate limit and resets on a new window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));

    const limits = basicLimits(env.DB, async () => 0);

    for (let i = 0; i < 20; i++) {
      expect(
        await limits.check(SINGLE_ORG_ID, "ast_1", { kind: "chat", ip: "198.51.100.9" }),
      ).toEqual({ ok: true });
    }

    expect(
      await limits.check(SINGLE_ORG_ID, "ast_1", { kind: "chat", ip: "198.51.100.9" }),
    ).toEqual({ ok: false, reason: "rate_limit" });

    vi.advanceTimersByTime(60_000);

    expect(
      await limits.check(SINGLE_ORG_ID, "ast_1", { kind: "chat", ip: "198.51.100.9" }),
    ).toEqual({ ok: true });
  });

  it("does not refuse ingest when the day's chat spend has reached the cap", async () => {
    const sink = usageDaily(env.DB);
    const limits = basicLimits(env.DB, async () => 1000);
    await sink.record({
      orgId: SINGLE_ORG_ID,
      assistantId: "ast_1",
      at: Date.now(),
      messages: 1,
      tokensIn: 1,
      tokensOut: 1,
      costMicros: 5000,
    });

    expect(
      await limits.check(SINGLE_ORG_ID, "ast_1", { kind: "chat", ip: "198.51.100.1" }),
    ).toEqual({ ok: false, reason: "spend_cap" });
    expect(await limits.check(SINGLE_ORG_ID, "ast_1", { kind: "ingest" })).toEqual({ ok: true });
  });

  it("removes counter rows from finished windows when a new window starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    const limits = basicLimits(env.DB, async () => 0);

    await limits.check(SINGLE_ORG_ID, "ast_1", { kind: "chat", ip: "198.51.100.1" });
    await limits.check(SINGLE_ORG_ID, "ast_2", { kind: "chat", ip: "198.51.100.2" });
    vi.advanceTimersByTime(60_000);
    await limits.check(SINGLE_ORG_ID, "ast_1", { kind: "chat", ip: "198.51.100.3" });

    const rows = await env.DB.prepare("SELECT ip FROM rate_counters").all<{ ip: string }>();
    expect(rows.results.map((r) => r.ip)).toEqual(["198.51.100.3"]);
  });
});
