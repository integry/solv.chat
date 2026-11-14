import { env } from "cloudflare:test";
import { defaultVersionConfig, newId, type VersionConfig } from "@solvchat/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/admin/ingestKeys.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function seedAssistant(orgId: string, name: string) {
  const assistantId = newId("ast");
  const ingestKey = `ik_${newId("src").slice(4)}`;
  const now = Date.now();
  const initialConfig = defaultVersionConfig();

  await env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING")
    .bind(orgId, `Org ${orgId}`)
    .run();

  await env.DB.prepare(
    `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, ingest_key_hash, created_at)
     VALUES (?1, ?2, ?3, ?4, '[]', ?5, ?6)`,
  )
    .bind(assistantId, orgId, name, `pk_${newId("ast").slice(4)}`, await sha256Hex(ingestKey), now)
    .run();

  const draftId = newId("ver");
  await env.DB.prepare(
    `INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at)
     VALUES (?1, ?2, ?3, 'draft', ?4, ?5, NULL)`,
  )
    .bind(draftId, orgId, assistantId, JSON.stringify(initialConfig), now)
    .run();

  const publishedId = newId("ver");
  const publishedConfig: VersionConfig = {
    ...initialConfig,
    widget: { ...initialConfig.widget, title: "Live Assistant" },
  };
  await env.DB.prepare(
    `INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at)
     VALUES (?1, ?2, ?3, 'published', ?4, ?5, ?6)`,
  )
    .bind(publishedId, orgId, assistantId, JSON.stringify(publishedConfig), now, now)
    .run();

  return { assistantId, ingestKey, draftId, publishedId, initialConfig, publishedConfig };
}

describe("ingest config", () => {
  it("reads and writes the draft with a valid key while leaving the published version unchanged", async () => {
    const app = createTestApp();
    const { assistantId, ingestKey, initialConfig, publishedConfig } = await seedAssistant(
      TEST_ORG_ID,
      "Bot A",
    );

    const getRes = await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/config`, {
        method: "GET",
        headers: { Authorization: `Bearer ${ingestKey}` },
      }),
      env,
      ctx,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ config: initialConfig });

    const putRes = await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/config`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ingestKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          behaviour: { greeting: "Updated greeting" },
          widget: { accentColor: "#111111" },
        }),
      }),
      env,
      ctx,
    );
    expect(putRes.status).toBe(200);
    const updatedBody = (await putRes.json()) as { config: VersionConfig };
    expect(updatedBody.config.behaviour.greeting).toBe("Updated greeting");
    expect(updatedBody.config.widget.accentColor).toBe("#111111");
    expect(updatedBody.config.widget.title).toBe(initialConfig.widget.title);

    const draftRow = await env.DB.prepare(
      "SELECT config FROM assistant_versions WHERE org_id = ?1 AND assistant_id = ?2 AND state = 'draft'",
    )
      .bind(TEST_ORG_ID, assistantId)
      .first<{ config: string }>();
    expect(JSON.parse(draftRow?.config ?? "{}")).toEqual(updatedBody.config);

    const publishedRow = await env.DB.prepare(
      "SELECT config FROM assistant_versions WHERE org_id = ?1 AND assistant_id = ?2 AND state = 'published'",
    )
      .bind(TEST_ORG_ID, assistantId)
      .first<{ config: string }>();
    expect(JSON.parse(publishedRow?.config ?? "{}")).toEqual(publishedConfig);
  });

  it("refuses a key for assistant A on assistant B and on another org's assistant", async () => {
    const app = createTestApp();
    const botA = await seedAssistant(TEST_ORG_ID, "Bot A");
    const botB = await seedAssistant(TEST_ORG_ID, "Bot B");
    const otherOrgId = newId("org");
    const otherOrgBot = await seedAssistant(otherOrgId, "Other Org Bot");

    for (const target of [botB, otherOrgBot]) {
      const getRes = await app.fetch(
        new Request(`https://example.com/v1/ingest/${target.assistantId}/config`, {
          method: "GET",
          headers: { Authorization: `Bearer ${botA.ingestKey}` },
        }),
        env,
        ctx,
      );
      expect(getRes.status).toBe(401);

      const putRes = await app.fetch(
        new Request(`https://example.com/v1/ingest/${target.assistantId}/config`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${botA.ingestKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ behaviour: { greeting: "Hijacked" } }),
        }),
        env,
        ctx,
      );
      expect(putRes.status).toBe(401);
    }

    const rowB = await env.DB.prepare(
      "SELECT config FROM assistant_versions WHERE assistant_id = ?1 AND state = 'draft'",
    )
      .bind(botB.assistantId)
      .first<{ config: string }>();
    expect(JSON.parse(rowB?.config ?? "{}")).toEqual(botB.initialConfig);
  });

  it("returns the exact same 401 response as the documents route when the key is missing or wrong", async () => {
    const app = createTestApp();
    const { assistantId } = await seedAssistant(TEST_ORG_ID, "Bot Auth");

    const cases = [
      { label: "missing", headers: {} as Record<string, string> },
      { label: "wrong", headers: { Authorization: "Bearer ik_wrong_key" } },
    ];

    for (const { headers } of cases) {
      const docsRes = await app.fetch(
        new Request(`https://example.com/v1/ingest/${assistantId}/documents`, {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ documents: [] }),
        }),
        env,
        ctx,
      );
      const configGetRes = await app.fetch(
        new Request(`https://example.com/v1/ingest/${assistantId}/config`, {
          method: "GET",
          headers,
        }),
        env,
        ctx,
      );
      const configPutRes = await app.fetch(
        new Request(`https://example.com/v1/ingest/${assistantId}/config`, {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ behaviour: { greeting: "Hi" } }),
        }),
        env,
        ctx,
      );

      const docsBody = await docsRes.json();
      expect(configGetRes.status).toBe(docsRes.status);
      expect(await configGetRes.json()).toEqual(docsBody);
      expect(configPutRes.status).toBe(docsRes.status);
      expect(await configPutRes.json()).toEqual(docsBody);
    }
  });

  it("returns field errors and writes nothing on invalid config", async () => {
    const app = createTestApp();
    const { assistantId, ingestKey, initialConfig } = await seedAssistant(
      TEST_ORG_ID,
      "Bot Validation",
    );

    const res = await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/config`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ingestKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          widget: { accentColor: "not-a-hex-color" },
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string; errors: string[] };
    expect(payload.errors.some((e) => e.includes("widget.accentColor"))).toBe(true);

    const draftRow = await env.DB.prepare(
      "SELECT config FROM assistant_versions WHERE org_id = ?1 AND assistant_id = ?2 AND state = 'draft'",
    )
      .bind(TEST_ORG_ID, assistantId)
      .first<{ config: string }>();
    expect(JSON.parse(draftRow?.config ?? "{}")).toEqual(initialConfig);
  });

  it("enforces ingest limits on config requests", async () => {
    const app = createTestApp({
      limits: {
        async check() {
          return { ok: false, reason: "rate_limit" };
        },
      },
    });
    const { assistantId, ingestKey } = await seedAssistant(TEST_ORG_ID, "Bot Limits");

    const res = await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/config`, {
        method: "GET",
        headers: { Authorization: `Bearer ${ingestKey}` },
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Ingest limit exceeded." });
  });
});
