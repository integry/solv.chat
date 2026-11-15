import { env } from "cloudflare:test";
import { defaultVersionConfig, newId } from "@solvchat/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/admin/ingestKeys.js";
import { createApp } from "../../src/app.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { LlmChunk, LlmProvider } from "../../src/providers/types.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { createTestApp, fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

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

  return { assistantId, ingestKey, draftId };
}

function scriptedProvider(text: string): LlmProvider {
  return {
    name: "anthropic",
    model: ANTHROPIC_MODELS.fast.id,
    async *stream(): AsyncIterable<LlmChunk> {
      yield { kind: "text", text };
      yield { kind: "usage", tokensIn: 10, tokensOut: 5 };
    },
  };
}

describe("ingest tests and test-runs", () => {
  it("replaces stored tests (including admin-created ones) and preserves order", async () => {
    const app = createTestApp();
    const { assistantId, ingestKey } = await seedAssistant(TEST_ORG_ID, "Bot Replace");

    // Seed an existing test as if created in the admin.
    await env.DB.prepare(
      `INSERT INTO tests (id, org_id, assistant_id, question, expectation, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(
        newId("tst"),
        TEST_ORG_ID,
        assistantId,
        "Old admin question?",
        JSON.stringify({ kind: "contains", phrase: "old" }),
        Date.now() - 1000,
      )
      .run();

    const declared = [
      { question: "First question?", expectation: { kind: "contains", phrase: "first" } },
      { question: "Second question?", expectation: { kind: "declines" } },
    ];

    const putRes = await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/tests`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ingestKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tests: declared }),
      }),
      env,
      ctx,
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as {
      created: number;
      removed: number;
      tests: Array<{ question: string }>;
    };
    expect(putBody.created).toBe(2);
    expect(putBody.removed).toBe(1);
    expect(putBody.tests.map((t) => t.question)).toEqual(["First question?", "Second question?"]);

    const getRes = await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/tests`, {
        method: "GET",
        headers: { Authorization: `Bearer ${ingestKey}` },
      }),
      env,
      ctx,
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { tests: Array<{ question: string }> };
    expect(getBody.tests.map((t) => t.question)).toEqual(["First question?", "Second question?"]);
  });

  it("returns 400 with field errors and leaves existing tests untouched on invalid payload", async () => {
    const app = createTestApp();
    const { assistantId, ingestKey } = await seedAssistant(TEST_ORG_ID, "Bot Validation");

    await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/tests`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ingestKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tests: [{ question: "Kept question?", expectation: { kind: "declines" } }],
        }),
      }),
      env,
      ctx,
    );

    const badRes = await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/tests`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ingestKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tests: [{ question: "", expectation: { kind: "unknown" } }],
        }),
      }),
      env,
      ctx,
    );
    expect(badRes.status).toBe(400);
    const badBody = (await badRes.json()) as { error: string; errors: string[] };
    expect(badBody.errors.some((e) => e.includes("tests[0].question"))).toBe(true);
    expect(badBody.errors.some((e) => e.includes("tests[0].expectation.kind"))).toBe(true);

    const getRes = await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/tests`, {
        method: "GET",
        headers: { Authorization: `Bearer ${ingestKey}` },
      }),
      env,
      ctx,
    );
    const getBody = (await getRes.json()) as { tests: Array<{ question: string }> };
    expect(getBody.tests.map((t) => t.question)).toEqual(["Kept question?"]);
  });

  it("runs tests via POST /test-runs and returns the run results", async () => {
    const embedder = {
      dimensions: 4,
      async embed(texts: readonly string[], onBilled: (tokens: number) => Promise<void>) {
        await onBilled(texts.length * 4);
        return { vectors: texts.map(() => [1, 0, 0, 0]) };
      },
    };
    const retriever = memoryRetriever();
    const { assistantId, ingestKey } = await seedAssistant(TEST_ORG_ID, "Bot Runner");

    const sourceId = newId("src");
    const docId = newId("doc");
    const chunkId = newId("chk");
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO sources (id, org_id, assistant_id, kind, label, settings, created_at) VALUES (?1, ?2, ?3, 'entry', 'Manual', '{}', ?4)",
    )
      .bind(sourceId, TEST_ORG_ID, assistantId, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, 'ext_1', 'https://site.example/shipping', 'Shipping', 'hash1', ?4)",
    )
      .bind(docId, TEST_ORG_ID, sourceId, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO chunks (id, org_id, document_id, ordinal, text, heading_path) VALUES (?1, ?2, ?3, 0, 'We ship in three days.', 'Shipping')",
    )
      .bind(chunkId, TEST_ORG_ID, docId)
      .run();
    await retriever.upsert([
      {
        chunkId,
        vector: [1, 0, 0, 0],
        orgId: TEST_ORG_ID,
        assistantId,
      },
    ]);

    const app = createApp(fakeSeams(), {
      chat: {
        embedder,
        retriever,
        provider: scriptedProvider("We ship to Spain in three days."),
        model: ANTHROPIC_MODELS.fast,
      },
    });

    await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/tests`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ingestKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tests: [
            {
              question: "Do you ship to Spain?",
              expectation: { kind: "contains", phrase: "three days" },
            },
          ],
        }),
      }),
      env,
      ctx,
    );

    const runRes = await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/test-runs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ingestKey}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      env,
      ctx,
    );
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as {
      runId: string;
      passed: boolean;
      results: Array<{ question: string; outcome: string; reason: string }>;
    };
    expect(runBody.runId).toMatch(/^run_/);
    expect(runBody.passed).toBe(true);
    expect(runBody.results).toHaveLength(1);
    expect(runBody.results[0]?.outcome).toBe("passed");
    expect(runBody.results[0]?.reason).toContain("three days");
  });

  it("returns byte-identical 401 responses to documents for missing/wrong key, another assistant, and another org", async () => {
    const app = createTestApp();
    const botA = await seedAssistant(TEST_ORG_ID, "Bot A");
    const botB = await seedAssistant(TEST_ORG_ID, "Bot B");
    const otherOrgBot = await seedAssistant(newId("org"), "Other Org Bot");

    const cases: Array<{ targetId: string; headers: Record<string, string> }> = [
      { targetId: botA.assistantId, headers: {} },
      { targetId: botA.assistantId, headers: { Authorization: "Bearer ik_wrong_key" } },
      { targetId: botB.assistantId, headers: { Authorization: `Bearer ${botA.ingestKey}` } },
      { targetId: otherOrgBot.assistantId, headers: { Authorization: `Bearer ${botA.ingestKey}` } },
    ];

    for (const { targetId, headers } of cases) {
      const docsRes = await app.fetch(
        new Request(`https://example.com/v1/ingest/${targetId}/documents`, {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ documents: [] }),
        }),
        env,
        ctx,
      );
      const testsPutRes = await app.fetch(
        new Request(`https://example.com/v1/ingest/${targetId}/tests`, {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ tests: [] }),
        }),
        env,
        ctx,
      );
      const testRunsRes = await app.fetch(
        new Request(`https://example.com/v1/ingest/${targetId}/test-runs`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{}",
        }),
        env,
        ctx,
      );

      const docsText = await docsRes.text();
      expect(docsRes.status).toBe(401);
      expect(testsPutRes.status).toBe(401);
      expect(await testsPutRes.text()).toBe(docsText);
      expect(testRunsRes.status).toBe(401);
      expect(await testRunsRes.text()).toBe(docsText);
    }
  });

  it("enforces ingest limits with 429 on tests and test-runs", async () => {
    const app = createTestApp({
      limits: {
        async check() {
          return { ok: false, reason: "rate_limit" };
        },
      },
    });
    const { assistantId, ingestKey } = await seedAssistant(TEST_ORG_ID, "Bot Limits");

    const putRes = await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/tests`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ingestKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tests: [] }),
      }),
      env,
      ctx,
    );
    expect(putRes.status).toBe(429);
    expect(await putRes.json()).toEqual({ error: "Ingest limit exceeded." });

    const runRes = await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/test-runs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ingestKey}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      env,
      ctx,
    );
    expect(runRes.status).toBe(429);
    expect(await runRes.json()).toEqual({ error: "Ingest limit exceeded." });
  });
});
