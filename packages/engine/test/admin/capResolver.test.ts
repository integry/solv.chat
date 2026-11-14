import { env } from "cloudflare:test";
import { defaultVersionConfig, newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { forPrincipal } from "../../src/db/tenant.js";
import { publishedCapMicros } from "../../src/db/versions.js";
import { basicLimits, DEFAULT_DAILY_CAP_MICROS } from "../../src/seams/open/basicLimits.js";
import { SINGLE_ORG_ID } from "../../src/seams/open/passwordAuth.js";
import { usageDaily } from "../../src/seams/open/usageDaily.js";

describe("publishedCapMicros", () => {
  const tenant = forPrincipal(env.DB, { orgId: SINGLE_ORG_ID, userId: "owner", role: "owner" });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM rate_counters"),
      env.DB.prepare("DELETE FROM usage_daily"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
    ]);
  });

  it("falls back to the default cap when no version is published", async () => {
    const assistantId = newId("ast");
    await tenant.assistants.create({
      id: assistantId,
      name: "Draft Only",
      publicKey: `pk_${newId("ast").slice(4)}`,
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenant.versions.createDraft({
      id: newId("ver"),
      assistantId,
      config: { ...defaultVersionConfig(), limits: { dailyCostCapMicros: 500 } },
      createdAt: 1000,
    });

    expect(await publishedCapMicros(env.DB, SINGLE_ORG_ID, assistantId)).toBe(
      DEFAULT_DAILY_CAP_MICROS,
    );
  });

  it("reads the cap from the published version", async () => {
    const assistantId = newId("ast");
    await tenant.assistants.create({
      id: assistantId,
      name: "Capped",
      publicKey: `pk_${newId("ast").slice(4)}`,
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenant.versions.batch([
      tenant.versions.statements.insertPublished({
        id: newId("ver"),
        assistantId,
        config: { ...defaultVersionConfig(), limits: { dailyCostCapMicros: 1_500 } },
        createdAt: 1000,
        publishedAt: 1000,
      }),
    ]);

    expect(await publishedCapMicros(env.DB, SINGLE_ORG_ID, assistantId)).toBe(1_500);

    const limits = basicLimits(env.DB, (orgId, id) => publishedCapMicros(env.DB, orgId, id));
    await usageDaily(env.DB).record({
      orgId: SINGLE_ORG_ID,
      assistantId,
      at: Date.now(),
      messages: 1,
      tokensIn: 10,
      tokensOut: 10,
      costMicros: 1_500,
    });
    expect(
      await limits.check(SINGLE_ORG_ID, assistantId, { kind: "chat", ip: "198.51.100.2" }),
    ).toEqual({
      ok: false,
      reason: "spend_cap",
    });
  });

  it("passes a published cap of 0 through as no cap", async () => {
    const assistantId = newId("ast");
    await tenant.assistants.create({
      id: assistantId,
      name: "Uncapped",
      publicKey: `pk_${newId("ast").slice(4)}`,
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenant.versions.batch([
      tenant.versions.statements.insertPublished({
        id: newId("ver"),
        assistantId,
        config: { ...defaultVersionConfig(), limits: { dailyCostCapMicros: 0 } },
        createdAt: 1000,
        publishedAt: 1000,
      }),
    ]);

    expect(await publishedCapMicros(env.DB, SINGLE_ORG_ID, assistantId)).toBe(0);

    const limits = basicLimits(env.DB, (orgId, id) => publishedCapMicros(env.DB, orgId, id));
    await usageDaily(env.DB).record({
      orgId: SINGLE_ORG_ID,
      assistantId,
      at: Date.now(),
      messages: 1,
      tokensIn: 100,
      tokensOut: 100,
      costMicros: DEFAULT_DAILY_CAP_MICROS * 2,
    });
    expect(
      await limits.check(SINGLE_ORG_ID, assistantId, { kind: "chat", ip: "198.51.100.3" }),
    ).toEqual({
      ok: true,
    });
  });
});
