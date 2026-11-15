import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { defaultVersionConfig, parseChatEventLine } from "@solvchat/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { answerMessage } from "../../src/chat/answer.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS, costMicros, OPENAI_MODELS } from "../../src/models.js";
import { anthropicProvider } from "../../src/providers/anthropic.js";
import { ProviderError } from "../../src/providers/error.js";
import { openaiProvider } from "../../src/providers/openai.js";
import { embeddingCostMicros } from "../../src/providers/retrieval.js";
import type { LlmProvider, LlmRequest } from "../../src/providers/types.js";
import type { UsageEvent } from "../../src/seams/types.js";
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

/** An SSE response delivering `events`, then ending or failing with `error`. */
function eventStreamResponse(events: string[], error?: Error): Response {
  const encoder = new TextEncoder();
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(events.join("")));
        return;
      }
      if (error) return Promise.reject(error);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// What `fakeEmbedder` reports for "How do I reset my password?".
const QUESTION_TOKENS = Math.ceil("How do I reset my password?".length / 4);

describe("chat/answer", () => {
  const tenant = forPrincipal(env.DB, {
    orgId: TEST_ORG_ID,
    userId: "usr_1",
    role: "owner",
  });
  const embedder = fakeEmbedder();
  let retriever = memoryRetriever();

  beforeEach(async () => {
    retriever = memoryRetriever();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_daily"),
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
    ]);

    await tenant.assistants.create({
      id: "ast_1",
      name: "Docs Bot",
      publicKey: "pk_ans_1",
      allowedOrigins: ["https://site.example"],
      createdAt: 1000,
    });

    const pubConfig = defaultVersionConfig();
    pubConfig.behaviour.persona = "Published persona";
    pubConfig.behaviour.fallbackText = "Published fallback";
    const draft = await tenant.versions.createDraft({
      id: "ver_1",
      assistantId: "ast_1",
      config: pubConfig,
      createdAt: 1000,
    });
    await tenant.versions.publishDraft("ast_1", draft.id, "ver_2", 2000);

    await tenant.sources.create({
      id: "src_1",
      assistantId: "ast_1",
      kind: "push",
      label: "CLI",
      settings: {},
      createdAt: 1000,
    });
    await tenant.documents.upsert({
      id: "doc_1",
      sourceId: "src_1",
      externalId: "docs/reset",
      url: "https://site.example/docs/reset",
      title: "Reset Password",
      contentHash: "hash_1",
      updatedAt: 1000,
    });
    await tenant.documents.replaceChunks("doc_1", [
      { id: "chk_1", ordinal: 0, text: "Click Forgot Password to reset.", headingPath: "Reset" },
    ]);

    const {
      vectors: [vec],
    } = await embedder.embed(["How do I reset my password?"], async () => {});
    await retriever.upsert([
      {
        chunkId: "chk_1",
        vector: vec ?? [],
        orgId: TEST_ORG_ID,
        assistantId: "ast_1",
      },
    ]);
  });

  it("streams token* -> citation* -> done incrementally from a seeded retriever", async () => {
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.balanced.id,
      async *stream() {
        yield { kind: "text", text: "Click " };
        await new Promise((r) => setTimeout(r, 15));
        yield { kind: "text", text: "Forgot Password." };
        yield { kind: "usage", tokensIn: 100, tokensOut: 20 };
      },
    };

    const app = createApp(fakeSeams(), {
      chat: { embedder, retriever, provider },
    });

    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "How do I reset my password?",
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    const rawParts: string[] = [];
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      rawParts.push(decoder.decode(value, { stream: true }));
    }
    await waitOnExecutionContext(ctx);

    // Tokens arrived in multiple stream reads rather than buffered into one.
    expect(rawParts.length).toBeGreaterThan(1);

    const events = parseSseBody(rawParts.join(""));
    expect(events.map((e) => e.type)).toEqual(["token", "token", "citation", "done"]);
    expect(events[0]).toEqual({ type: "token", text: "Click " });
    expect(events[1]).toEqual({ type: "token", text: "Forgot Password." });
    expect(events[2]).toEqual({
      type: "citation",
      url: "https://site.example/docs/reset",
      title: "Reset Password",
    });
    expect(events[3]?.type).toBe("done");
  });

  it("streams fallbackText, stores answered = 0, records usage, and never calls provider when retriever returns nothing", async () => {
    const streamSpy = vi.fn();
    const usageSpy = vi.fn(async () => {});
    const emptyRetriever = memoryRetriever();
    const app = createApp(
      fakeSeams({
        usage: { record: usageSpy },
      }),
      {
        chat: {
          embedder,
          retriever: emptyRetriever,
          provider: {
            name: "anthropic",
            model: ANTHROPIC_MODELS.balanced.id,
            async *stream() {
              streamSpy();
              yield { kind: "text", text: "should not run" };
            },
          },
        },
      },
    );

    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "Unanswered question?",
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(streamSpy).not.toHaveBeenCalled();
    const events = parseSseBody(await res.text());
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "token", text: "Published fallback" });
    expect(events[1]?.type).toBe("done");

    // The question's embedding is its own event, recorded when billed; the
    // answer counts a message and no model spend.
    expect(usageSpy).toHaveBeenCalledTimes(2);
    expect(usageSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        orgId: TEST_ORG_ID,
        assistantId: "ast_1",
        messages: 0,
        costMicros: embeddingCostMicros(QUESTION_TOKENS),
      }),
    );
    expect(usageSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        orgId: TEST_ORG_ID,
        assistantId: "ast_1",
        messages: 1,
        tokensIn: 0,
        tokensOut: 0,
        costMicros: 0,
      }),
    );

    const gaps = await tenant.messages.unanswered("ast_1");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.answered).toBe(false);
    expect(gaps[0]?.content).toBe("Published fallback");
  });

  it("emits an error event on mid-stream ProviderError and still persists the visitor message", async () => {
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.balanced.id,
      async *stream() {
        yield { kind: "text", text: "Partial " };
        throw new ProviderError("upstream reset", true, 502);
      },
    };

    const app = createApp(fakeSeams(), {
      chat: { embedder, retriever, provider },
    });

    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "How do I reset my password?",
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const events = parseSseBody(await res.text());
    expect(events.map((e) => e.type)).toEqual(["token", "error"]);

    const convs = await tenant.conversations.list("ast_1");
    expect(convs).toHaveLength(1);
    const conv = convs[0];
    if (!conv) throw new Error("expected conversation");
    const msgs = await tenant.messages.list(conv.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content).toBe("How do I reset my password?");
  });

  it("answers from the published version on /v1/chat even when target='draft' comes with an owner session", async () => {
    const draftConfig = defaultVersionConfig();
    draftConfig.behaviour.persona = "Draft-only persona";
    await tenant.versions.updateDraft("ast_1", draftConfig);

    const seenSystems: string[] = [];
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.balanced.id,
      async *stream(req: LlmRequest) {
        seenSystems.push(req.system);
        yield { kind: "text", text: "ok" };
        yield { kind: "usage", tokensIn: 10, tokensOut: 2 };
      },
    };

    // With owner session -> still published: drafts are served only by /api/admin/chat
    const appWithAuth = createApp(fakeSeams(), {
      chat: { embedder, retriever, provider },
    });
    const ctx1 = createExecutionContext();
    const res1 = await appWithAuth.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "How do I reset my password?",
          target: "draft",
        }),
      }),
      env,
      ctx1,
    );
    await res1.text();
    await waitOnExecutionContext(ctx1);

    // Without session -> ignores target='draft' and uses published
    const appNoAuth = createApp(
      fakeSeams({
        auth: {
          authenticate: async () => null,
          login: async () => Response.json({ ok: true }),
          logout: async () => Response.json({ ok: true }),
        },
      }),
      {
        chat: { embedder, retriever, provider },
      },
    );
    const ctx2 = createExecutionContext();
    const res2 = await appNoAuth.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "How do I reset my password?",
          target: "draft",
        }),
      }),
      env,
      ctx2,
    );
    expect(res2.status).toBe(200);
    await res2.text();
    await waitOnExecutionContext(ctx2);

    expect(seenSystems[0]).toContain("Published persona");
    expect(seenSystems[0]).not.toContain("Draft-only persona");
    expect(seenSystems[1]).toContain("Published persona");
    expect(seenSystems[1]).not.toContain("Draft-only persona");
  });

  it("refuses a signed-in owner's draft request from the Worker's own origin on /v1/chat", async () => {
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.balanced.id,
      async *stream() {
        yield { kind: "text", text: "ok" };
      },
    };
    const authenticate = vi.fn(async () => ({
      orgId: TEST_ORG_ID,
      userId: "owner",
      role: "owner" as const,
    }));
    const app = createApp(
      fakeSeams({
        auth: {
          authenticate,
          login: async () => Response.json({ ok: true }),
          logout: async () => Response.json({ ok: true }),
        },
      }),
      { chat: { embedder, retriever, provider } },
    );

    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://engine.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_admin",
          message: "How do I reset my password?",
          target: "draft",
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(parseSseBody(await res.text())).toEqual([
      { type: "error", message: "This assistant is not available on this page." },
    ]);
    // The public route never consults the session.
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("returns a sanitized SSE error event with CORS headers when embeddingKey initialization fails", async () => {
    const app = createApp(
      fakeSeams({
        keys: {
          modelKey: async () => "test-anthropic-key",
          embeddingKey: async () => {
            throw new Error("Missing required secret: SOLV_OPENAI_KEY");
          },
        },
      }),
      {
        chat: { retriever },
      },
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "How do I reset my password?",
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://site.example");
    expect(res.headers.get("vary")).toBe("Origin");

    const events = parseSseBody(await res.text());
    expect(events).toEqual([{ type: "error", message: "Something went wrong. Please try again." }]);
    // S33: the visitor sees a generic line; the operator's log names the cause.
    expect(logged).toHaveBeenCalledWith("chat: answer pipeline failed", {
      name: "Error",
      message: "Missing required secret: SOLV_OPENAI_KEY",
    });
    logged.mockRestore();
  });

  it("returns a sanitized SSE error event with CORS headers when modelKey initialization fails", async () => {
    const app = createApp(
      fakeSeams({
        keys: {
          modelKey: async () => {
            throw new Error("Missing required secret: SOLV_ANTHROPIC_KEY");
          },
          embeddingKey: async () => "test-embedding-key",
        },
      }),
      {
        chat: { embedder, retriever },
      },
    );

    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "How do I reset my password?",
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://site.example");
    expect(res.headers.get("vary")).toBe("Origin");

    const events = parseSseBody(await res.text());
    expect(events).toEqual([{ type: "error", message: "Something went wrong. Please try again." }]);
  });

  it("selects provider and tier from Worker env and falls back to defaults on unrecognised values", async () => {
    const requestedModels: Array<{ url: string; model: string }> = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      requestedModels.push({ url, model: body.model ?? "" });

      const sse = url.includes("anthropic.com")
        ? [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join("")
        : [
            'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
          ].join("");

      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    vi.stubGlobal("fetch", fetchSpy);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const app = createApp(fakeSeams(), {
        chat: { embedder, retriever },
      });

      const cases: Array<{
        provider?: string;
        tier?: string;
        expectedModel: string;
      }> = [
        { provider: "anthropic", tier: "fast", expectedModel: ANTHROPIC_MODELS.fast.id },
        { provider: "anthropic", tier: "balanced", expectedModel: ANTHROPIC_MODELS.balanced.id },
        { provider: "openai", tier: "fast", expectedModel: OPENAI_MODELS.fast.id },
        { provider: "openai", tier: "balanced", expectedModel: OPENAI_MODELS.balanced.id },
        { provider: "bad-provider", tier: "bad-tier", expectedModel: ANTHROPIC_MODELS.fast.id },
        { provider: "bad-provider", tier: "bad-tier", expectedModel: ANTHROPIC_MODELS.fast.id },
      ];

      for (const c of cases) {
        const ctx = createExecutionContext();
        const res = await app.fetch(
          new Request("https://engine.example/v1/chat", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "https://site.example" },
            body: JSON.stringify({
              protocol: 1,
              assistant: "pk_ans_1",
              visitorId: "vis_1",
              message: "How do I reset my password?",
            }),
          }),
          { ...env, SOLV_LLM_PROVIDER: c.provider, SOLV_LLM_TIER: c.tier },
          ctx,
        );
        await res.text();
        await waitOnExecutionContext(ctx);
      }

      expect(requestedModels.map((r) => r.model)).toEqual(cases.map((c) => c.expectedModel));
      // Unrecognised values are logged once per variable without echoing the value.
      expect(warnSpy).toHaveBeenCalledTimes(2);
      for (const call of warnSpy.mock.calls) {
        expect(String(call[0])).not.toContain("bad-provider");
        expect(String(call[0])).not.toContain("bad-tier");
      }
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("owner preview writes no conversation or message rows, records usage, returns generated ids, and accepts history only for owner previews", async () => {
    const seenRequests: LlmRequest[] = [];
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.fast.id,
      async *stream(req: LlmRequest) {
        seenRequests.push(req);
        yield { kind: "text", text: "Draft answer" };
        yield { kind: "usage", tokensIn: 50, tokensOut: 10 };
      },
    };
    const usageSpy = vi.fn(async () => {});

    const previewApp = createApp(fakeSeams({ usage: { record: usageSpy } }), {
      chat: { embedder, retriever, provider },
    });

    const previewCtx = createExecutionContext();
    const previewRes = await previewApp.fetch(
      new Request("https://engine.example/api/admin/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://engine.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_admin",
          message: "How do I reset my password?",
          target: "draft",
          history: [
            { role: "user", content: "Prior question" },
            { role: "assistant", content: "Prior answer" },
          ],
        }),
      }),
      env,
      previewCtx,
    );
    await waitOnExecutionContext(previewCtx);

    const previewEvents = parseSseBody(await previewRes.text());
    const done = previewEvents.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.messageId).toMatch(/^msg_/);
      expect(done.conversationId).toMatch(/^cnv_/);
    }

    expect(await tenant.conversations.list("ast_1")).toHaveLength(0);
    // The question's embedding, then the answer.
    expect(usageSpy).toHaveBeenCalledTimes(2);
    expect(seenRequests[0]?.messages).toHaveLength(3);
    expect(seenRequests[0]?.messages[0]).toEqual({ role: "user", content: "Prior question" });
    expect(seenRequests[0]?.messages[1]).toEqual({ role: "assistant", content: "Prior answer" });

    // Visitor sending history (even with target: "draft" when unauthenticated) must have history ignored.
    const visitorApp = createApp(
      fakeSeams({
        auth: {
          authenticate: async () => null,
          login: async () => Response.json({ ok: true }),
          logout: async () => Response.json({ ok: true }),
        },
      }),
      { chat: { embedder, retriever, provider } },
    );

    const visitorCtx = createExecutionContext();
    const visitorRes = await visitorApp.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "How do I reset my password?",
          target: "draft",
          history: [{ role: "user", content: "Injected prior turn" }],
        }),
      }),
      env,
      visitorCtx,
    );
    await visitorRes.text();
    await waitOnExecutionContext(visitorCtx);

    expect(seenRequests[1]?.messages).toHaveLength(1);
    expect(seenRequests[1]?.messages[0]?.content).not.toContain("Injected prior turn");
  });

  it("meters a failed stream's model usage only when reported, and always the question's embedding", async () => {
    const usageWithTokens = vi.fn(async () => {});
    const failingWithUsage: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.fast.id,
      async *stream() {
        yield { kind: "text", text: "Partial " };
        yield { kind: "usage", tokensIn: 120, tokensOut: 30 };
        throw new ProviderError("upstream reset", true, 502);
      },
    };

    const appWithUsage = createApp(fakeSeams({ usage: { record: usageWithTokens } }), {
      chat: { embedder, retriever, provider: failingWithUsage, model: ANTHROPIC_MODELS.fast },
    });

    const ctx1 = createExecutionContext();
    const res1 = await appWithUsage.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "How do I reset my password?",
        }),
      }),
      env,
      ctx1,
    );
    await waitOnExecutionContext(ctx1);

    const events1 = parseSseBody(await res1.text());
    expect(events1.map((e) => e.type)).toEqual(["token", "error"]);
    expect(usageWithTokens).toHaveBeenCalledTimes(2);
    expect(usageWithTokens).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ messages: 0, costMicros: embeddingCostMicros(QUESTION_TOKENS) }),
    );
    expect(usageWithTokens).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tokensIn: 120,
        tokensOut: 30,
        costMicros: costMicros(ANTHROPIC_MODELS.fast, 120, 30),
      }),
    );

    const usageWithoutTokens = vi.fn(async () => {});
    const failingWithoutUsage: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.fast.id,
      async *stream() {
        yield { kind: "text", text: "Partial " };
        throw new ProviderError("upstream reset", true, 502);
      },
    };

    const appWithoutUsage = createApp(fakeSeams({ usage: { record: usageWithoutTokens } }), {
      chat: { embedder, retriever, provider: failingWithoutUsage },
    });

    const ctx2 = createExecutionContext();
    const res2 = await appWithoutUsage.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "How do I reset my password?",
        }),
      }),
      env,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);

    const events2 = parseSseBody(await res2.text());
    expect(events2.map((e) => e.type)).toEqual(["token", "error"]);
    // No model usage to meter, but the question's embedding was billed: it is
    // recorded without counting a message.
    expect(usageWithoutTokens).toHaveBeenCalledTimes(1);
    expect(usageWithoutTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        costMicros: embeddingCostMicros(QUESTION_TOKENS),
      }),
    );
  });

  it.each([
    ["the retriever query", "retriever"],
    ["the chunk lookup in D1", "resolve"],
  ] as const)(
    "keeps the question's billed embedding when %s fails afterwards",
    async (_label, failing) => {
      const usageSpy = vi.fn(async () => {});
      const brokenRetriever = {
        ...retriever,
        async query(args: Parameters<typeof retriever.query>[0]) {
          if (failing === "retriever") throw new Error("vectorize unavailable");
          // A hit whose id D1 cannot resolve: resolveChunks reads D1, which is
          // made to fail below.
          return (await retriever.query(args)).length > 0
            ? [{ chunkId: "chk_missing", score: 0.99 }]
            : [];
        },
      };
      const providerSpy = vi.fn();
      const app = createApp(fakeSeams({ usage: { record: usageSpy } }), {
        chat: {
          embedder,
          retriever: brokenRetriever,
          provider: {
            name: "anthropic",
            model: ANTHROPIC_MODELS.fast.id,
            async *stream() {
              providerSpy();
              yield { kind: "text", text: "unused" };
            },
          },
        },
      });

      const db = env.DB;
      const failingDb =
        failing === "resolve"
          ? (new Proxy(db, {
              get(target, prop, receiver) {
                if (prop === "prepare") {
                  return (sql: string) => {
                    if (/FROM chunks/i.test(sql)) throw new Error("d1 unavailable");
                    return target.prepare(sql);
                  };
                }
                const value = Reflect.get(target, prop, receiver);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }) as D1Database)
          : db;

      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request("https://engine.example/v1/chat", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://site.example" },
          body: JSON.stringify({
            protocol: 1,
            assistant: "pk_ans_1",
            visitorId: "vis_1",
            message: "How do I reset my password?",
          }),
        }),
        { ...env, DB: failingDb },
        ctx,
      );
      await res.text().catch(() => "");
      await waitOnExecutionContext(ctx);

      expect(providerSpy).not.toHaveBeenCalled();
      expect(usageSpy).toHaveBeenCalledTimes(1);
      expect(usageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: TEST_ORG_ID,
          assistantId: "ast_1",
          messages: 0,
          costMicros: embeddingCostMicros(QUESTION_TOKENS),
        }),
      );
    },
  );

  describe("F19: model usage survives a failing reply write", () => {
    // A tenant whose assistant-message insert rejects; the visitor's question
    // is still written for real.
    function tenantFailingReplyWrite(): typeof tenant {
      return {
        ...tenant,
        messages: {
          ...tenant.messages,
          async create(row: Parameters<typeof tenant.messages.create>[0]) {
            if (row.role === "assistant") throw new Error("d1 write rejected");
            return tenant.messages.create(row);
          },
        },
      };
    }

    async function drain(events: AsyncIterable<unknown>): Promise<unknown[]> {
      const out: unknown[] = [];
      for await (const event of events) out.push(event);
      return out;
    }

    const behaviour = defaultVersionConfig().behaviour;

    it("records the billed model tokens once when the reply write rejects after a complete stream", async () => {
      const usage = vi.fn(async (_event: UsageEvent) => {});
      const provider: LlmProvider = {
        name: "anthropic",
        model: ANTHROPIC_MODELS.fast.id,
        async *stream() {
          yield { kind: "text", text: "Click Forgot Password." };
          yield { kind: "usage", tokensIn: 210, tokensOut: 45 };
        },
      };

      await expect(
        drain(
          answerMessage(
            {
              tenant: tenantFailingReplyWrite(),
              embedder,
              retriever,
              provider,
              model: ANTHROPIC_MODELS.fast,
              usage: { record: usage },
            },
            {
              orgId: TEST_ORG_ID,
              assistantId: "ast_1",
              visitorId: "vis_1",
              message: "How do I reset my password?",
              behaviour,
            },
          ),
        ),
      ).rejects.toThrow("d1 write rejected");

      const modelEvents = usage.mock.calls
        .map(([event]) => event)
        .filter((event) => event.messages === 1);
      expect(modelEvents).toEqual([
        expect.objectContaining({
          tokensIn: 210,
          tokensOut: 45,
          costMicros: costMicros(ANTHROPIC_MODELS.fast, 210, 45),
        }),
      ]);
    });

    it("records reported usage when the stream ends with a non-provider error", async () => {
      const usage = vi.fn(async (_event: UsageEvent) => {});
      const provider: LlmProvider = {
        name: "anthropic",
        model: ANTHROPIC_MODELS.fast.id,
        async *stream() {
          yield { kind: "text", text: "Partial" };
          yield { kind: "usage", tokensIn: 90, tokensOut: 12 };
          throw new TypeError("malformed frame");
        },
      };

      await expect(
        drain(
          answerMessage(
            {
              tenant,
              embedder,
              retriever,
              provider,
              model: ANTHROPIC_MODELS.fast,
              usage: { record: usage },
            },
            {
              orgId: TEST_ORG_ID,
              assistantId: "ast_1",
              visitorId: "vis_1",
              message: "How do I reset my password?",
              behaviour,
            },
          ),
        ),
      ).rejects.toThrow("malformed frame");

      expect(usage).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: 1,
          tokensIn: 90,
          tokensOut: 12,
          costMicros: costMicros(ANTHROPIC_MODELS.fast, 90, 12),
        }),
      );
    });

    // F21: the real adapters, not a scripted provider, so the regression covers
    // the parsing that holds the counts until the stream ends.
    it.each([
      {
        name: "anthropic",
        provider: () =>
          anthropicProvider({
            apiKey: "test-key",
            model: ANTHROPIC_MODELS.fast.id,
            fetchImpl: async () =>
              eventStreamResponse([
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":140}}}\n\n',
                'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}\n\n',
                'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":22}}\n\n',
              ]),
          }),
        model: ANTHROPIC_MODELS.fast,
        tokensIn: 140,
        tokensOut: 22,
      },
      {
        name: "openai",
        provider: () =>
          openaiProvider({
            apiKey: "test-key",
            model: OPENAI_MODELS.fast.id,
            fetchImpl: async () =>
              eventStreamResponse(
                [
                  'data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":null}]}\n\n',
                  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
                  'data: {"choices":[],"usage":{"prompt_tokens":130,"completion_tokens":18}}\n\n',
                ],
                new Error("connection dropped"),
              ),
          }),
        model: OPENAI_MODELS.fast,
        tokensIn: 130,
        tokensOut: 18,
      },
    ])("records usage reported before a $name stream failed, once", async (c) => {
      const usage = vi.fn(async (_event: UsageEvent) => {});
      const events = await drain(
        answerMessage(
          {
            tenant,
            embedder,
            retriever,
            provider: c.provider(),
            model: c.model,
            usage: { record: usage },
          },
          {
            orgId: TEST_ORG_ID,
            assistantId: "ast_1",
            visitorId: "vis_1",
            message: "How do I reset my password?",
            behaviour,
          },
        ),
      );

      expect(events.map((e) => (e as { type: string }).type)).toEqual(["token", "error"]);
      const modelEvents = usage.mock.calls
        .map(([event]) => event)
        .filter((event) => event.messages === 1);
      expect(modelEvents).toEqual([
        expect.objectContaining({
          tokensIn: c.tokensIn,
          tokensOut: c.tokensOut,
          costMicros: costMicros(c.model, c.tokensIn, c.tokensOut),
        }),
      ]);
    });

    it("counts a fallback answer the visitor already saw when the reply write rejects", async () => {
      const usage = vi.fn(async (_event: UsageEvent) => {});
      await expect(
        drain(
          answerMessage(
            {
              tenant: tenantFailingReplyWrite(),
              embedder,
              retriever: memoryRetriever(),
              provider: {
                name: "anthropic",
                model: ANTHROPIC_MODELS.fast.id,
                async *stream() {
                  yield { kind: "text", text: "unused" };
                },
              },
              model: ANTHROPIC_MODELS.fast,
              usage: { record: usage },
            },
            {
              orgId: TEST_ORG_ID,
              assistantId: "ast_1",
              visitorId: "vis_1",
              message: "How do I reset my password?",
              behaviour,
            },
          ),
        ),
      ).rejects.toThrow("d1 write rejected");

      expect(usage).toHaveBeenCalledWith(expect.objectContaining({ messages: 1, costMicros: 0 }));
    });
  });

  it("F5: /api/admin/chat serves draft for authenticated owner and returns 401 on expired session even when Worker origin is allowed", async () => {
    await tenant.assistants.update("ast_1", {
      name: "Docs Bot",
      allowedOrigins: ["https://site.example", "https://engine.example"],
    });
    const draftConfig = defaultVersionConfig();
    draftConfig.behaviour.persona = "Admin preview draft persona";
    await tenant.versions.updateDraft("ast_1", draftConfig);

    const seenSystems: string[] = [];
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.balanced.id,
      async *stream(req: LlmRequest) {
        seenSystems.push(req.system);
        yield { kind: "text", text: "ok" };
        yield { kind: "usage", tokensIn: 10, tokensOut: 2 };
      },
    };

    const body = JSON.stringify({
      protocol: 1,
      assistant: "pk_ans_1",
      visitorId: "admin-preview",
      message: "How do I reset my password?",
      target: "draft",
    });

    // 1. Authenticated same-org owner -> 200 SSE using draft
    const appWithAuth = createApp(fakeSeams(), { chat: { embedder, retriever, provider } });
    const ctx1 = createExecutionContext();
    const res1 = await appWithAuth.fetch(
      new Request("https://engine.example/api/admin/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://engine.example" },
        body,
      }),
      env,
      ctx1,
    );
    expect(res1.status).toBe(200);
    await res1.text();
    await waitOnExecutionContext(ctx1);
    expect(seenSystems).toHaveLength(1);
    expect(seenSystems[0]).toContain("Admin preview draft persona");

    // 2. Expired session with Worker origin in allowedOrigins -> 401, never falls back to published
    const appNoAuth = createApp(
      fakeSeams({
        auth: {
          authenticate: async () => null,
          login: async () => Response.json({ ok: true }),
          logout: async () => Response.json({ ok: true }),
        },
      }),
      { chat: { embedder, retriever, provider } },
    );
    const ctx2 = createExecutionContext();
    const res2 = await appNoAuth.fetch(
      new Request("https://engine.example/api/admin/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://engine.example" },
        body,
      }),
      env,
      ctx2,
    );
    expect(res2.status).toBe(401);
    expect(await res2.json()).toEqual({ error: "Sign in first." });
    expect(seenSystems).toHaveLength(1);

    // 3. Cross-org session -> refused without calling LLM
    const appOtherOrg = createApp(
      fakeSeams({
        auth: {
          authenticate: async () => ({
            orgId: "org_other00000000000000",
            userId: "u2",
            role: "owner",
          }),
          login: async () => Response.json({ ok: true }),
          logout: async () => Response.json({ ok: true }),
        },
      }),
      { chat: { embedder, retriever, provider } },
    );
    const ctx3 = createExecutionContext();
    const res3 = await appOtherOrg.fetch(
      new Request("https://engine.example/api/admin/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://engine.example" },
        body,
      }),
      env,
      ctx3,
    );
    await waitOnExecutionContext(ctx3);
    expect(parseSseBody(await res3.text())).toEqual([
      { type: "error", message: "This assistant is not available." },
    ]);
    expect(seenSystems).toHaveLength(1);

    // 4. Non-Worker origin -> 403
    const ctx4 = createExecutionContext();
    const res4 = await appWithAuth.fetch(
      new Request("https://engine.example/api/admin/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body,
      }),
      env,
      ctx4,
    );
    expect(res4.status).toBe(403);
  });
});
