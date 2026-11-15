import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  defaultVersionConfig,
  MAX_TESTS_PER_ASSISTANT,
  MAX_TESTS_PER_RUN,
  newId,
  type TestExpectation,
} from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { runAnswerTests, TEST_RUN_WALL_TIME_MS } from "../../src/admin/answerTests.js";
import { createApp } from "../../src/app.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { LlmChunk, LlmProvider } from "../../src/providers/types.js";
import type { UsageEvent } from "../../src/seams/types.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { type createTestApp, fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

const ORG_A = TEST_ORG_ID;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";

function appForOrg(
  orgId: string,
  extra?: Parameters<typeof createApp>[1],
  seamsOverrides?: Parameters<typeof fakeSeams>[0],
) {
  return createApp(
    fakeSeams({
      ...seamsOverrides,
      auth: {
        async authenticate() {
          return { orgId, userId: "owner", role: "owner" };
        },
        async login() {
          return Response.json({ ok: true });
        },
        async logout() {
          return Response.json({ ok: true });
        },
      },
    }),
    extra,
  );
}

async function call(
  app: ReturnType<typeof createTestApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  if (method !== "GET" && method !== "HEAD") {
    headers.Origin = "https://example.com";
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await app.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function constantEmbedder(): ReturnType<typeof fakeEmbedder> {
  return {
    dimensions: 4,
    async embed(texts, onBilled) {
      await onBilled(texts.length * 4);
      return { vectors: texts.map(() => [1, 0, 0, 0]) };
    },
  };
}

function scriptedProvider(answerText: string): LlmProvider {
  return {
    name: "anthropic",
    model: ANTHROPIC_MODELS.fast.id,
    async *stream(): AsyncIterable<LlmChunk> {
      yield { kind: "text", text: answerText };
      yield { kind: "usage", tokensIn: 12, tokensOut: 6 };
    },
  };
}

async function seedAssistant(orgId: string, fallbackText = "I don't know.") {
  const assistantId = newId("ast");
  const versionId = newId("ver");
  const now = Date.now();
  const config = defaultVersionConfig();
  config.behaviour.fallbackText = fallbackText;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at) VALUES (?1, ?2, 'Test Bot', ?3, '[]', ?4)",
    ).bind(assistantId, orgId, `pk_${newId("ast").slice(4)}`, now),
    env.DB.prepare(
      "INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at) VALUES (?1, ?2, ?3, 'draft', ?4, ?5)",
    ).bind(versionId, orgId, assistantId, JSON.stringify(config), now),
  ]);
  return { assistantId, versionId };
}

async function seedChunk(
  orgId: string,
  assistantId: string,
  url: string,
  text: string,
  embedder: ReturnType<typeof fakeEmbedder>,
  retriever: ReturnType<typeof memoryRetriever>,
) {
  const sourceId = newId("src");
  const docId = newId("doc");
  const chunkId = newId("chk");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO sources (id, org_id, assistant_id, kind, label, settings, created_at) VALUES (?1, ?2, ?3, 'push', 'Docs', '{}', ?4)",
    ).bind(sourceId, orgId, assistantId, now),
    env.DB.prepare(
      "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'Pricing', 'hash', ?6)",
    ).bind(docId, orgId, sourceId, docId, url, now),
    env.DB.prepare(
      "INSERT INTO chunks (id, org_id, document_id, ordinal, text, heading_path) VALUES (?1, ?2, ?3, 0, ?4, '')",
    ).bind(chunkId, orgId, docId, text),
  ]);
  const { vectors } = await embedder.embed([text], async () => {});
  const vector = vectors[0];
  if (!vector) throw new Error("expected fake embedding vector");
  await retriever.upsert([{ chunkId, vector, orgId, assistantId }]);
}

describe("admin answer tests", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM test_runs"),
      env.DB.prepare("DELETE FROM tests"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  it("supports create, list with latestResult, update, delete, cap, and field-prefixed validation errors", async () => {
    const app = appForOrg(ORG_A);
    const { assistantId } = await seedAssistant(ORG_A);

    const createRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
      question: "  What is the price?  ",
      expectation: { kind: "contains", phrase: "  $10  " },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      test: { id: string; question: string; expectation: TestExpectation };
    };
    expect(created.test.id).toMatch(/^tst_/);
    expect(created.test.question).toBe("What is the price?");
    expect(created.test.expectation).toEqual({ kind: "contains", phrase: "$10" });

    const listRes = await call(app, "GET", `/api/admin/assistants/${assistantId}/tests`);
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      tests: Array<{ id: string; latestResult: unknown }>;
    };
    expect(listed.tests).toHaveLength(1);
    expect(listed.tests[0]?.latestResult).toBeNull();

    const patchRes = await call(app, "PATCH", `/api/admin/tests/${created.test.id}`, {
      expectation: { kind: "cites", url: "https://site.example/pricing" },
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      test: { question: string; expectation: TestExpectation };
    };
    expect(patched.test.question).toBe("What is the price?");
    expect(patched.test.expectation).toEqual({
      kind: "cites",
      url: "https://site.example/pricing",
    });

    // Field-prefixed validation errors for each expectation kind and question.
    const badInputs: Array<{ body: unknown; expectedPrefix: string }> = [
      { body: { question: "", expectation: { kind: "declines" } }, expectedPrefix: "question:" },
      {
        body: { question: "Q?", expectation: { kind: "unknown" } },
        expectedPrefix: "expectation.kind:",
      },
      {
        body: { question: "Q?", expectation: { kind: "cites", url: "ftp://site.example/a" } },
        expectedPrefix: "expectation.url:",
      },
      {
        body: { question: "Q?", expectation: { kind: "contains", phrase: "   " } },
        expectedPrefix: "expectation.phrase:",
      },
      {
        body: { question: "Q?", expectation: { kind: "notContains", phrase: "" } },
        expectedPrefix: "expectation.phrase:",
      },
    ];
    for (const { body, expectedPrefix } of badInputs) {
      const res = await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, body);
      expect(res.status).toBe(400);
      const err = (await res.json()) as { fields: string[] };
      expect(err.fields.some((f) => f.startsWith(expectedPrefix))).toBe(true);
    }

    const delRes = await call(app, "DELETE", `/api/admin/tests/${created.test.id}`);
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ deleted: true });

    // Per-assistant cap: 50 succeed, 51st is 400 naming the limit.
    for (let i = 0; i < MAX_TESTS_PER_ASSISTANT; i++) {
      const r = await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
        question: `Question ${i}`,
        expectation: { kind: "declines" },
      });
      expect(r.status).toBe(201);
    }
    const overCap = await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
      question: "Question 51",
      expectation: { kind: "declines" },
    });
    expect(overCap.status).toBe(400);
    const overBody = (await overCap.json()) as { fields: string[] };
    expect(overBody.fields[0]).toContain(String(MAX_TESTS_PER_ASSISTANT));
  });

  it("evaluates all four expectation kinds, including the cites host trap and declines", async () => {
    const embedder = constantEmbedder();
    const retriever = memoryRetriever();
    const { assistantId } = await seedAssistant(ORG_A, "I don't know that.");
    await seedChunk(
      ORG_A,
      assistantId,
      "https://site.example/pricing-archive",
      "The plan costs $10 per month.",
      embedder,
      retriever,
    );

    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const app = appForOrg(ORG_A, {
      chat: {
        embedder,
        retriever,
        provider: scriptedProvider("The plan costs $10 per month."),
        model: ANTHROPIC_MODELS.fast,
      },
    });

    const create = async (question: string, expectation: TestExpectation) => {
      const res = await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
        question,
        expectation,
      });
      return ((await res.json()) as { test: { id: string } }).test.id;
    };

    const idContainsPass = await create("Price?", { kind: "contains", phrase: "$10" });
    const idContainsFail = await create("Price?", { kind: "contains", phrase: "free" });
    const idNotContainsPass = await create("Price?", { kind: "notContains", phrase: "free" });
    const idNotContainsFail = await create("Price?", { kind: "notContains", phrase: "$10" });
    const idCitesPass = await create("Price?", {
      kind: "cites",
      url: "https://site.example/pricing-archive",
    });
    // Host trap: /pricing must NOT match /pricing-archive.
    const idCitesTrap = await create("Price?", {
      kind: "cites",
      url: "https://site.example/pricing",
    });
    const idDeclinesFail = await create("Price?", { kind: "declines" });

    const runRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/test-runs`);
    expect(runRes.status).toBe(201);
    const run = (await runRes.json()) as {
      runId: string;
      passed: boolean;
      results: Array<{ testId: string; outcome: string; reason: string; excerpt: string }>;
    };
    expect(run.runId).toMatch(/^run_/);
    expect(run.passed).toBe(false);

    const byId = new Map(run.results.map((r) => [r.testId, r]));
    expect(byId.get(idContainsPass)?.outcome).toBe("passed");
    expect(byId.get(idContainsFail)?.outcome).toBe("failed");
    expect(byId.get(idNotContainsPass)?.outcome).toBe("passed");
    expect(byId.get(idNotContainsFail)?.outcome).toBe("failed");
    expect(byId.get(idCitesPass)?.outcome).toBe("passed");
    expect(byId.get(idCitesTrap)?.outcome).toBe("failed");
    expect(byId.get(idCitesTrap)?.reason).toContain("Did not cite");
    expect(byId.get(idDeclinesFail)?.outcome).toBe("failed");
    expect(byId.get(idContainsPass)?.excerpt).toBe("The plan costs $10 per month.");

    // listWithLatestResult and GET test-runs reflect the run.
    const testsRes = await call(app, "GET", `/api/admin/assistants/${assistantId}/tests`);
    const testsBody = (await testsRes.json()) as {
      tests: Array<{ id: string; latestResult: { outcome: string } | null }>;
    };
    expect(testsBody.tests.find((t) => t.id === idContainsPass)?.latestResult?.outcome).toBe(
      "passed",
    );

    const runsRes = await call(app, "GET", `/api/admin/assistants/${assistantId}/test-runs`);
    expect(runsRes.status).toBe(200);
    const runsBody = (await runsRes.json()) as {
      runs: Array<{ id: string; publishedAnyway: boolean }>;
    };
    expect(runsBody.runs).toHaveLength(1);
    expect(runsBody.runs[0]?.id).toBe(run.runId);
    expect(runsBody.runs[0]?.publishedAnyway).toBe(false);

    // declines passes when retrieval finds nothing (empty retriever, model not called).
    const emptyApp = appForOrg(ORG_A, {
      chat: {
        embedder,
        retriever: memoryRetriever(),
        provider: {
          name: "anthropic",
          model: ANTHROPIC_MODELS.fast.id,
          stream(): AsyncIterable<LlmChunk> {
            throw new Error("model should not be called when retrieval is empty");
          },
        },
        model: ANTHROPIC_MODELS.fast,
      },
    });
    const { assistantId: emptyAssistantId } = await seedAssistant(ORG_A, "I don't know.");
    await call(emptyApp, "POST", `/api/admin/assistants/${emptyAssistantId}/tests`, {
      question: "Anything?",
      expectation: { kind: "declines" },
    });
    const emptyRunRes = await call(
      emptyApp,
      "POST",
      `/api/admin/assistants/${emptyAssistantId}/test-runs`,
    );
    const emptyRun = (await emptyRunRes.json()) as {
      passed: boolean;
      results: Array<{ outcome: string }>;
    };
    expect(emptyRun.passed).toBe(true);
    expect(emptyRun.results[0]?.outcome).toBe("passed");
    void tenant;
  });

  it("writes no conversation or message and meters usage per test", async () => {
    const embedder = constantEmbedder();
    const retriever = memoryRetriever();
    const { assistantId } = await seedAssistant(ORG_A);
    await seedChunk(
      ORG_A,
      assistantId,
      "https://site.example/docs",
      "The price is 10.",
      embedder,
      retriever,
    );

    const usageEvents: UsageEvent[] = [];
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    for (let i = 0; i < 3; i++) {
      await tenant.tests.create({
        id: newId("tst"),
        assistantId,
        question: `Question ${i}`,
        expectation: { kind: "contains", phrase: "10" },
        createdAt: Date.now() + i,
      });
    }

    const run = await runAnswerTests(
      {
        tenant,
        orgId: ORG_A,
        embedder,
        retriever,
        provider: scriptedProvider("The price is 10."),
        model: ANTHROPIC_MODELS.fast,
        usage: {
          async record(event) {
            usageEvents.push(event);
          },
        },
        limits: {
          async check() {
            return { ok: true };
          },
        },
      },
      assistantId,
    );

    expect(run.passed).toBe(true);
    expect(await tenant.conversations.list(assistantId)).toHaveLength(0);
    const msgRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE org_id = ?1")
      .bind(ORG_A)
      .first<{ n: number }>();
    expect(msgRow?.n).toBe(0);
    expect(usageEvents.length).toBeGreaterThanOrEqual(3);
  });

  it("enforces the wall-time cap, per-run cap, and spend_cap refusal mid-run", async () => {
    const embedder = constantEmbedder();
    const retriever = memoryRetriever();
    const { assistantId } = await seedAssistant(ORG_A);
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });

    for (let i = 0; i < MAX_TESTS_PER_RUN + 3; i++) {
      await tenant.tests.create({
        id: newId("tst"),
        assistantId,
        question: `Question ${i}`,
        expectation: { kind: "declines" },
        createdAt: Date.now() + i,
      });
    }

    // Per-run cap: at most MAX_TESTS_PER_RUN (25) run.
    const cappedRun = await runAnswerTests(
      {
        tenant,
        orgId: ORG_A,
        embedder,
        retriever,
        provider: scriptedProvider("unused"),
        model: ANTHROPIC_MODELS.fast,
        usage: { async record() {} },
        limits: {
          async check() {
            return { ok: true };
          },
        },
      },
      assistantId,
    );
    expect(cappedRun.results).toHaveLength(MAX_TESTS_PER_RUN);
    expect(cappedRun.passed).toBe(true);

    // Wall-time cap: remaining tests marked not_run and passed is false.
    let clock = 0;
    const { assistantId: wallAssistantId } = await seedAssistant(ORG_A);
    for (let i = 0; i < 3; i++) {
      await tenant.tests.create({
        id: newId("tst"),
        assistantId: wallAssistantId,
        question: `Wall ${i}`,
        expectation: { kind: "declines" },
        createdAt: Date.now() + i,
      });
    }
    const wallRun = await runAnswerTests(
      {
        tenant,
        orgId: ORG_A,
        embedder,
        retriever,
        provider: scriptedProvider("unused"),
        model: ANTHROPIC_MODELS.fast,
        usage: { async record() {} },
        limits: {
          async check() {
            return { ok: true };
          },
        },
        now: () => (clock += TEST_RUN_WALL_TIME_MS / 2 + 1),
      },
      wallAssistantId,
    );
    expect(wallRun.results.map((r) => r.outcome)).toEqual(["passed", "not_run", "not_run"]);
    expect(wallRun.passed).toBe(false);
    expect(wallRun.stopped).toMatch(/too long/i);

    // spend_cap refusal mid-run stops immediately with no further model calls.
    let limitChecks = 0;
    let modelCalls = 0;
    await seedChunk(
      ORG_A,
      wallAssistantId,
      "https://site.example/doc",
      "Answer text.",
      embedder,
      retriever,
    );
    const spendRun = await runAnswerTests(
      {
        tenant,
        orgId: ORG_A,
        embedder,
        retriever,
        provider: {
          name: "anthropic",
          model: ANTHROPIC_MODELS.fast.id,
          async *stream(): AsyncIterable<LlmChunk> {
            modelCalls += 1;
            yield { kind: "text", text: "Answer text." };
            yield { kind: "usage", tokensIn: 5, tokensOut: 5 };
          },
        },
        model: ANTHROPIC_MODELS.fast,
        usage: { async record() {} },
        limits: {
          async check() {
            limitChecks += 1;
            if (limitChecks >= 2) {
              return { ok: false, reason: "spend_cap" };
            }
            return { ok: true };
          },
        },
      },
      wallAssistantId,
    );
    expect(modelCalls).toBe(1);
    expect(spendRun.passed).toBe(false);
    expect(spendRun.stopped).toContain("spending limit");
    expect(spendRun.results.map((r) => r.outcome)).toEqual(["failed", "not_run", "not_run"]);
  });

  it("returns 404 across orgs on every route and writes nothing", async () => {
    const appA = appForOrg(ORG_A);
    const appB = appForOrg(ORG_B);
    const { assistantId: astA } = await seedAssistant(ORG_A);

    const createdRes = await call(appA, "POST", `/api/admin/assistants/${astA}/tests`, {
      question: "Org A question?",
      expectation: { kind: "declines" },
    });
    const { test: testA } = (await createdRes.json()) as { test: { id: string } };

    expect((await call(appB, "GET", `/api/admin/assistants/${astA}/tests`)).status).toBe(404);
    expect(
      (
        await call(appB, "POST", `/api/admin/assistants/${astA}/tests`, {
          question: "Cross org?",
          expectation: { kind: "declines" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(appB, "PATCH", `/api/admin/tests/${testA.id}`, {
          question: "Hacked",
        })
      ).status,
    ).toBe(404);
    expect((await call(appB, "DELETE", `/api/admin/tests/${testA.id}`)).status).toBe(404);
    expect((await call(appB, "POST", `/api/admin/assistants/${astA}/test-runs`)).status).toBe(404);
    expect((await call(appB, "GET", `/api/admin/assistants/${astA}/test-runs`)).status).toBe(404);

    // Nothing was modified or deleted in Org A.
    const listA = await call(appA, "GET", `/api/admin/assistants/${astA}/tests`);
    const bodyA = (await listA.json()) as { tests: Array<{ id: string; question: string }> };
    expect(bodyA.tests).toHaveLength(1);
    expect(bodyA.tests[0]?.question).toBe("Org A question?");
  });
});
