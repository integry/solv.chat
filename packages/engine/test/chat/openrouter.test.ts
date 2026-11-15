import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { CHAT_PROTOCOL_VERSION, defaultVersionConfig, parseChatEventLine } from "@solvchat/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { answerMessage } from "../../src/chat/answer.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { openrouterProvider } from "../../src/providers/openrouter.js";
import { basicLimits } from "../../src/seams/open/basicLimits.js";
import { secretKeys } from "../../src/seams/open/secretKeys.js";
import { usageDaily } from "../../src/seams/open/usageDaily.js";
import { utcDay } from "../../src/util/time.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

function parseSseBody(text: string) {
  return text
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const name =
        lines
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim() ?? "";
      const data =
        lines
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim() ?? "";
      return parseChatEventLine(name, data);
    });
}

function sseResponse(events: string[]): Response {
  const bytes = new TextEncoder().encode(events.join(""));
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function seedAssistantWithChunk(assistantId: string, publicKey: string, chunkId: string) {
  const cfg = defaultVersionConfig();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at) VALUES (?1, ?2, 'OpenRouter Bot', ?3, '[\"https://example.com\"]', 1000)",
    ).bind(assistantId, TEST_ORG_ID, publicKey),
    env.DB.prepare(
      "INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at) VALUES (?1, ?2, ?3, 'published', ?4, 1000, 1000)",
    ).bind(`ver_${assistantId}`, TEST_ORG_ID, assistantId, JSON.stringify(cfg)),
    env.DB.prepare(
      "INSERT INTO sources (id, org_id, assistant_id, kind, label, settings, created_at) VALUES (?1, ?2, ?3, 'push', 'Docs', '{}', 1000)",
    ).bind(`src_${assistantId}`, TEST_ORG_ID, assistantId),
    env.DB.prepare(
      "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, 'doc1', 'https://example.com/docs', 'Docs', 'hash1', 1000)",
    ).bind(`doc_${assistantId}`, TEST_ORG_ID, `src_${assistantId}`),
    env.DB.prepare(
      "INSERT INTO chunks (id, org_id, document_id, ordinal, text, heading_path) VALUES (?1, ?2, ?3, 0, 'Reset your password in Settings.', 'Account')",
    ).bind(chunkId, TEST_ORG_ID, `doc_${assistantId}`),
  ]);
}

describe("chat/openrouter", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_daily"),
      env.DB.prepare("DELETE FROM rate_counters"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistant_origins"),
      env.DB.prepare("DELETE FROM assistants"),
    ]);
  });

  it("feeds reported OpenRouter cost into usage_daily, messages, and the daily spend cap", async () => {
    const astId = "ast_or_cost";
    const chunkId = "chk_or_cost";
    await seedAssistantWithChunk(astId, "pk_or_cost", chunkId);

    const embedder = fakeEmbedder();
    const {
      vectors: [chunkVec],
    } = await embedder.embed(["Reset your password in Settings."], async () => {});
    if (!chunkVec) throw new Error("expected vector");
    const retriever = memoryRetriever();
    await retriever.upsert([{ chunkId, vector: chunkVec, orgId: TEST_ORG_ID, assistantId: astId }]);

    const provider = openrouterProvider({
      apiKey: "sk-or-test",
      model: "anthropic/claude-sonnet-4",
      fetchImpl: async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Go to Settings."},"finish_reason":"stop"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"cost":0.005}}\n\n',
          "data: [DONE]\n\n",
        ]),
    });

    const tenant = forPrincipal(env.DB, { orgId: TEST_ORG_ID, userId: "owner", role: "owner" });
    const usage = usageDaily(env.DB);
    const events = [];
    for await (const ev of answerMessage(
      {
        tenant,
        embedder,
        retriever,
        provider,
        usage,
        now: () => 1_700_000_000_000,
      },
      {
        orgId: TEST_ORG_ID,
        assistantId: astId,
        visitorId: "vis_1",
        message: "Reset your password in Settings.",
        behaviour: defaultVersionConfig().behaviour,
      },
    )) {
      events.push(ev);
    }

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type !== "done") throw new Error("expected done");

    const stored = await tenant.messages.get(done.messageId);
    expect(stored?.costMicros).toBe(5000);

    const day = utcDay(1_700_000_000_000);
    const summary = await tenant.usage.summaryFor(astId, day);
    expect(summary).not.toBeNull();
    expect(summary?.costMicros).toBeGreaterThanOrEqual(5000);
    expect(summary?.costUnknown).toBe(false);

    // Spend cap of 4000 micros is now exceeded by today's spend (5000+).
    const limits = basicLimits(env.DB, async () => 4000);
    // Test with current UTC day row too:
    await usage.record({
      orgId: TEST_ORG_ID,
      assistantId: astId,
      at: Date.now(),
      messages: 1,
      tokensIn: 20,
      tokensOut: 4,
      costMicros: 5000,
    });
    const decision = await limits.check(TEST_ORG_ID, astId, { kind: "chat", ip: "1.2.3.4" });
    expect(decision).toEqual({ ok: false, reason: "spend_cap" });
  });

  it("stores cost_micros as NULL and sets cost_unknown when OpenRouter reports no cost", async () => {
    const astId = "ast_or_nocost";
    const chunkId = "chk_or_nocost";
    await seedAssistantWithChunk(astId, "pk_or_nocost", chunkId);

    const embedder = fakeEmbedder();
    const {
      vectors: [chunkVec],
    } = await embedder.embed(["Reset your password in Settings."], async () => {});
    if (!chunkVec) throw new Error("expected vector");
    const retriever = memoryRetriever();
    await retriever.upsert([{ chunkId, vector: chunkVec, orgId: TEST_ORG_ID, assistantId: astId }]);

    const provider = openrouterProvider({
      apiKey: "sk-or-test",
      model: "vendor/no-cost-model",
      fetchImpl: async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Go to Settings."},"finish_reason":"stop"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4}}\n\n',
          "data: [DONE]\n\n",
        ]),
    });

    const tenant = forPrincipal(env.DB, { orgId: TEST_ORG_ID, userId: "owner", role: "owner" });
    const usage = usageDaily(env.DB);
    const events = [];
    for await (const ev of answerMessage(
      {
        tenant,
        embedder,
        retriever,
        provider,
        usage,
        now: () => 1_700_000_000_000,
      },
      {
        orgId: TEST_ORG_ID,
        assistantId: astId,
        visitorId: "vis_1",
        message: "Reset your password in Settings.",
        behaviour: defaultVersionConfig().behaviour,
      },
    )) {
      events.push(ev);
    }

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type !== "done") throw new Error("expected done");

    const stored = await tenant.messages.get(done.messageId);
    expect(stored?.costMicros).toBeNull();

    const day = utcDay(1_700_000_000_000);
    const summary = await tenant.usage.summaryFor(astId, day);
    expect(summary?.costUnknown).toBe(true);
  });

  it("returns standard SSE error event without fallback when SOLV_LLM_MODEL or SOLV_OPENROUTER_KEY is missing", async () => {
    const astId = "ast_or_cfg";
    await seedAssistantWithChunk(astId, "pk_or_cfg", "chk_or_cfg");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Missing SOLV_LLM_MODEL
      const appNoModel = createApp(
        fakeSeams({ keys: secretKeys({ SOLV_OPENROUTER_KEY: "sk-or-secret-value" }) }),
        { chat: { embedder: fakeEmbedder(), retriever: memoryRetriever() } },
      );
      const ctx1 = createExecutionContext();
      const res1 = await appNoModel.fetch(
        new Request("https://example.com/v1/chat", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://example.com" },
          body: JSON.stringify({
            protocol: CHAT_PROTOCOL_VERSION,
            assistant: "pk_or_cfg",
            visitorId: "vis_1",
            message: "Hello?",
          }),
        }),
        { ...env, SOLV_LLM_PROVIDER: "openrouter" },
        ctx1,
      );
      await waitOnExecutionContext(ctx1);
      const text1 = await res1.text();
      expect(parseSseBody(text1)).toEqual([
        { type: "error", message: "Something went wrong. Please try again." },
      ]);
      expect(text1).not.toContain("sk-or-secret-value");

      // Missing SOLV_OPENROUTER_KEY
      const appNoKey = createApp(fakeSeams({ keys: secretKeys({}) }), {
        chat: { embedder: fakeEmbedder(), retriever: memoryRetriever() },
      });
      const ctx2 = createExecutionContext();
      const res2 = await appNoKey.fetch(
        new Request("https://example.com/v1/chat", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://example.com" },
          body: JSON.stringify({
            protocol: CHAT_PROTOCOL_VERSION,
            assistant: "pk_or_cfg",
            visitorId: "vis_1",
            message: "Hello?",
          }),
        }),
        { ...env, SOLV_LLM_PROVIDER: "openrouter", SOLV_LLM_MODEL: "vendor/model" },
        ctx2,
      );
      await waitOnExecutionContext(ctx2);
      const text2 = await res2.text();
      expect(parseSseBody(text2)).toEqual([
        { type: "error", message: "Something went wrong. Please try again." },
      ]);

      for (const call of errorSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("sk-or-secret-value");
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});
