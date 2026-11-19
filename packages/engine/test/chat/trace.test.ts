import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { type ChatEvent, defaultVersionConfig, parseChatEventLine } from "@solvchat/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnswerTraceView } from "../../src/admin/conversations.js";
import { responseTimeFigures } from "../../src/admin/reports.js";
import { createApp } from "../../src/app.js";
import { type AnswerDeps, answerMessage, SCORE_FLOOR } from "../../src/chat/answer.js";
import { SAFETY_FRAME } from "../../src/chat/prompt.js";
import type { ToolRunner } from "../../src/chat/toolLoop.js";
import { forPrincipal, type Tenant } from "../../src/db/tenant.js";
import { MAX_PREVIEW_TRACES } from "../../src/db/traces.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { LlmChunk, LlmProvider } from "../../src/providers/types.js";
import type { KeyProvider } from "../../src/seams/types.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { directoryResolveOrg, fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const QUESTION = "How does billing work QUESTION_MARKER?";
const PERSONA = "PERSONA_MARKER speaks like a pirate.";
const CHUNK_TEXT = "Invoices are sent monthly CHUNK_TEXT_MARKER.";
const MODEL_KEY = "sk-ant-MODEL_KEY_MARKER-0000";
const CIPHERTEXT = "CIPHERTEXT_MARKER";
const TOOL_OUTPUT = "TOOL_OUTPUT_MARKER: order 42 shipped";

function parseSse(text: string): ChatEvent[] {
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
      return parseChatEventLine(name, data) as ChatEvent;
    });
}

/** An Anthropic Messages stream, so the real provider runs with the real key. */
function anthropicFetch(seenKeys: string[]): typeof fetch {
  return async (_input, init) => {
    const headers = new Headers(init?.headers);
    seenKeys.push(headers.get("x-api-key") ?? "");
    const body = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":40}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Invoices go out monthly."}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

function ownerSeams(orgId: string, keys?: Partial<KeyProvider>) {
  return fakeSeams({
    auth: {
      async authenticate() {
        return { orgId, userId: "owner", role: "owner" };
      },
      resolveOrg: directoryResolveOrg,
    },
    keys: {
      async modelKey() {
        return MODEL_KEY;
      },
      async embeddingKey() {
        return "embedding-key";
      },
      ...keys,
    },
  });
}

describe("chat/trace", () => {
  const tenant = forPrincipal(env.DB, { orgId: TEST_ORG_ID, userId: "usr_1", role: "owner" });
  const tenantB = forPrincipal(env.DB, { orgId: ORG_B, userId: "usr_b", role: "owner" });
  const embedder = fakeEmbedder();
  let retriever = memoryRetriever();
  let publishedId = "";

  async function vectorFor(text: string): Promise<number[]> {
    const { vectors } = await embedder.embed([text], async () => {});
    return vectors[0] ?? [];
  }

  async function seedChunk(id: string, docId: string, text: string, vectorText: string) {
    await tenant.documents.upsert({
      id: docId,
      sourceId: "src_1",
      externalId: docId,
      url: `https://site.example/${docId}`,
      title: `Title of ${docId}`,
      contentHash: `hash_${docId}`,
      updatedAt: 1000,
    });
    await tenant.documents.replaceChunks(docId, [{ id, ordinal: 0, text, headingPath: "Billing" }]);
    await retriever.upsert([
      {
        chunkId: id,
        vector: await vectorFor(vectorText),
        orgId: TEST_ORG_ID,
        assistantId: "ast_1",
      },
    ]);
  }

  function appFor(keys?: Partial<KeyProvider>, seenKeys: string[] = []) {
    return createApp(ownerSeams(TEST_ORG_ID, keys), {
      chat: { embedder, retriever, fetch: anthropicFetch(seenKeys) },
    });
  }

  async function ask(app: ReturnType<typeof createApp>, message = QUESTION) {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({ protocol: 1, assistant: "pk_trace_1", visitorId: "vis_1", message }),
      }),
      env,
      ctx,
    );
    const events = parseSse(await res.text());
    await waitOnExecutionContext(ctx);
    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error(`expected done, got ${JSON.stringify(events)}`);
    return { events, done };
  }

  async function readTrace(
    app: ReturnType<typeof createApp>,
    conversationId: string,
    messageId: string,
  ): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(
        `https://engine.example/api/admin/conversations/${conversationId}/messages/${messageId}/trace`,
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  async function storedRow(messageId: string): Promise<string> {
    const row = await env.DB.prepare("SELECT detail FROM message_traces WHERE message_id = ?1")
      .bind(messageId)
      .first<{ detail: string }>();
    if (!row) throw new Error("no trace row");
    return row.detail;
  }

  beforeEach(async () => {
    retriever = memoryRetriever();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM preview_traces"),
      env.DB.prepare("DELETE FROM test_runs"),
      env.DB.prepare("DELETE FROM tests"),
      env.DB.prepare("DELETE FROM usage_daily"),
      env.DB.prepare("DELETE FROM org_provider_keys"),
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(TEST_ORG_ID),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);

    await tenant.assistants.create({
      id: "ast_1",
      name: "Docs Bot",
      publicKey: "pk_trace_1",
      allowedOrigins: ["https://site.example"],
      createdAt: 1000,
    });
    const config = defaultVersionConfig();
    const draft = await tenant.versions.createDraft({
      id: "ver_1",
      assistantId: "ast_1",
      config: { ...config, behaviour: { ...config.behaviour, persona: PERSONA } },
      createdAt: 1000,
    });
    await tenant.versions.publishDraft("ast_1", draft.id, "ver_2", 2000);
    publishedId = (await tenant.versions.published("ast_1"))?.id ?? "";
    await tenant.sources.create({
      id: "src_1",
      assistantId: "ast_1",
      kind: "push",
      label: "CLI",
      settings: {},
      createdAt: 1000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a retrieval hit: the chunk given to the model, version, model, key source and timings", async () => {
    await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
    const seenKeys: string[] = [];
    const app = appFor(undefined, seenKeys);
    const { done } = await ask(app);
    // The real provider ran with the key, so it was in reach of the trace
    // (the answer, then the answer review with the same key: this fake
    // answers it with no label, so it is retried once).
    expect(seenKeys).toEqual([MODEL_KEY, MODEL_KEY, MODEL_KEY]);

    const trace = await tenant.traces.get(done.messageId);
    expect(trace?.parts).toHaveLength(1);
    const part = trace?.parts[0];
    expect(part).toMatchObject({
      kind: "answer",
      version: { id: publishedId, state: "published" },
      model: { provider: "anthropic", id: ANTHROPIC_MODELS.fast.id, keySource: "environment" },
      retrieval: {
        floor: SCORE_FLOOR,
        candidates: [{ chunkId: "chk_hit", documentId: "doc_hit", used: true }],
      },
      tools: { rounds: 0, ms: 0 },
      stop: "complete",
    });
    expect(part?.retrieval.candidates[0]?.score).toBeCloseTo(1, 5);
    expect(part?.timing.firstTokenMs).toEqual(expect.any(Number));
    expect(part?.timing.totalMs).toBeGreaterThanOrEqual(part?.timing.firstTokenMs ?? 0);

    // The two visitor-facing timings are on the message too, equal to the trace's.
    const message = await tenant.messages.get(done.messageId);
    expect(message?.firstTokenMs).toBe(part?.timing.firstTokenMs);
    expect(message?.totalMs).toBe(part?.timing.totalMs);

    const res = await readTrace(app, done.conversationId, done.messageId);
    expect(res.status).toBe(200);
    const view = (await res.json()) as AnswerTraceView;
    expect(view.tokensIn).toBe(40);
    expect(view.tokensOut).toBe(6);
    expect(view.trace?.parts[0]?.version.current?.state).toBe("published");
    expect(view.trace?.parts[0]?.retrieval.candidates[0]?.content).toMatchObject({
      documentId: "doc_hit",
      title: "Title of doc_hit",
      url: "https://site.example/doc_hit",
      excerpt: CHUNK_TEXT,
    });
  });

  it("records a miss: candidates under the floor are dropped, no model is asked", async () => {
    await seedChunk("chk_far", "doc_far", "Shipping takes a week.", "completely unrelated text");
    const app = appFor();
    const { done } = await ask(app);

    const message = await tenant.messages.get(done.messageId);
    expect(message?.answered).toBe(false);
    const part = (await tenant.traces.get(done.messageId))?.parts[0];
    expect(part?.model).toBeNull();
    expect(part?.stop).toBe("complete");
    expect(part?.retrieval.candidates).toEqual([
      {
        chunkId: "chk_far",
        documentId: "doc_far",
        score: expect.any(Number),
        used: false,
        dropped: "below_floor",
      },
    ]);
    expect(part?.retrieval.candidates[0]?.score).toBeLessThan(SCORE_FLOOR);
    expect(message?.firstTokenMs).toEqual(expect.any(Number));
  });

  it("records a dropped chunk beside a used one, best first, and a vector whose chunk is gone", async () => {
    await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
    await seedChunk("chk_far", "doc_far", "Shipping takes a week.", "completely unrelated text");
    // A vector left behind with no chunk row (a failed cleanup).
    await retriever.upsert([
      {
        chunkId: "chk_gone",
        vector: await vectorFor(QUESTION),
        orgId: TEST_ORG_ID,
        assistantId: "ast_1",
      },
    ]);
    const { done } = await ask(appFor());

    const candidates = (await tenant.traces.get(done.messageId))?.parts[0]?.retrieval.candidates;
    const byId = new Map(candidates?.map((c) => [c.chunkId, c]));
    expect(byId.get("chk_hit")).toMatchObject({ used: true, documentId: "doc_hit" });
    expect(byId.get("chk_far")).toMatchObject({ used: false, dropped: "below_floor" });
    expect(byId.get("chk_gone")).toMatchObject({
      used: false,
      dropped: "not_found",
      documentId: null,
    });
    const scores = candidates?.map((c) => c.score) ?? [];
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("names a stored key and a managed key without keeping either", async () => {
    await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
    await tenant.providerSettings.setKey("anthropic", CIPHERTEXT);
    const stored = await ask(appFor());
    expect((await tenant.traces.get(stored.done.messageId))?.parts[0]?.model?.keySource).toBe(
      "stored",
    );

    const managed = await ask(appFor({ managed: true }));
    expect((await tenant.traces.get(managed.done.messageId))?.parts[0]?.model?.keySource).toBe(
      "managed",
    );
  });

  it("keeps no key, prompt, question or chunk text in the stored row or the API response", async () => {
    await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
    await tenant.providerSettings.setKey("anthropic", CIPHERTEXT);
    const app = appFor();
    const { done } = await ask(app);

    const row = await storedRow(done.messageId);
    for (const marker of [
      "MODEL_KEY_MARKER",
      CIPHERTEXT,
      "PERSONA_MARKER",
      SAFETY_FRAME.slice(0, 40),
      "QUESTION_MARKER",
      "CHUNK_TEXT_MARKER",
    ]) {
      expect(row).not.toContain(marker);
    }

    const body = await (await readTrace(app, done.conversationId, done.messageId)).text();
    // The view shows the content's current text by design; nothing else.
    for (const marker of [
      "MODEL_KEY_MARKER",
      CIPHERTEXT,
      "PERSONA_MARKER",
      SAFETY_FRAME.slice(0, 40),
      "QUESTION_MARKER",
    ]) {
      expect(body).not.toContain(marker);
    }
  });

  it("says content has changed when the chunk it was given is gone", async () => {
    await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
    const app = appFor();
    const { done } = await ask(app);
    // A new push replaces the document's chunks with new ids.
    await tenant.documents.replaceChunks("doc_hit", [
      { id: "chk_new", ordinal: 0, text: "Rewritten.", headingPath: "" },
    ]);

    const view = (await (
      await readTrace(app, done.conversationId, done.messageId)
    ).json()) as AnswerTraceView;
    expect(view.trace?.parts[0]?.retrieval.candidates).toEqual([
      expect.objectContaining({ chunkId: "chk_hit", used: true, content: null }),
    ]);
  });

  it("answers trace: null for a message written before traces existed", async () => {
    const app = appFor();
    await tenant.conversations.create({
      id: "cnv_old",
      assistantId: "ast_1",
      visitorId: "vis_1",
      startedAt: 1000,
      pageUrl: "",
    });
    await tenant.messages.create({
      id: "msg_old",
      conversationId: "cnv_old",
      role: "assistant",
      content: "Old answer.",
      citations: [],
      toolCalls: null,
      tokensIn: 10,
      tokensOut: 5,
      costMicros: 12,
      answered: true,
      createdAt: 1500,
    });
    const res = await readTrace(app, "cnv_old", "msg_old");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      messageId: "msg_old",
      source: "visitor",
      tokensIn: 10,
      tokensOut: 5,
      costMicros: 12,
      firstTokenMs: null,
      totalMs: null,
      trace: null,
      reviewFailure: null,
    });
  });

  it("refuses a trace for a visitor message or a message in another conversation", async () => {
    await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
    const app = appFor();
    const { done } = await ask(app);
    const question = (await tenant.messages.list(done.conversationId)).find(
      (m) => m.role === "user",
    );
    expect((await readTrace(app, done.conversationId, question?.id ?? "")).status).toBe(404);
    expect((await readTrace(app, "cnv_other", done.messageId)).status).toBe(404);
  });

  it("keeps org B from reading or writing org A's trace", async () => {
    await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
    const { done } = await ask(appFor());

    const appB = createApp(ownerSeams(ORG_B), { chat: { embedder, retriever } });
    const res = await readTrace(appB, done.conversationId, done.messageId);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("chk_hit");
    expect(await tenantB.traces.get(done.messageId)).toBeNull();

    const part = (await tenant.traces.get(done.messageId))?.parts[0];
    if (!part) throw new Error("expected a trace");
    // The foreign key names (org_id, message_id): org B's handle cannot
    // attach a trace to org A's message.
    await expect(tenantB.traces.put(done.messageId, part, 5000)).rejects.toThrow();
    expect((await tenant.traces.get(done.messageId))?.parts).toEqual([part]);
  });

  it("deletes the trace with its conversation", async () => {
    await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
    const { done } = await ask(appFor());
    expect(await tenant.traces.get(done.messageId)).not.toBeNull();

    await tenant.conversations.remove(done.conversationId);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM message_traces").first<{
      n: number;
    }>();
    expect(left?.n).toBe(0);
  });

  it("deletes the trace with its assistant", async () => {
    await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
    await ask(appFor());
    await tenant.assistants.remove("ast_1");
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM message_traces").first<{
      n: number;
    }>();
    expect(left?.n).toBe(0);
  });

  describe("Try it and test runs", () => {
    async function adminFetch(
      app: ReturnType<typeof createApp>,
      path: string,
      init: { method?: string; body?: unknown } = {},
    ): Promise<Response> {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request(`https://engine.example${path}`, {
          method: init.method ?? "GET",
          headers: { "content-type": "application/json", origin: "https://engine.example" },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    }

    async function tryIt(app: ReturnType<typeof createApp>) {
      const res = await adminFetch(app, "/api/admin/chat", {
        method: "POST",
        body: { protocol: 1, assistant: "pk_trace_1", visitorId: "owner", message: QUESTION },
      });
      const events = parseSse(await res.text());
      const done = events.find((e) => e.type === "done");
      if (done?.type !== "done") throw new Error(`expected done, got ${JSON.stringify(events)}`);
      return done;
    }

    it("records a Try it answer's trace, marked as one, from the draft, readable by its id", async () => {
      await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
      const draftId = (await tenant.versions.draft("ast_1"))?.id;
      const app = appFor();
      const done = await tryIt(app);

      // Nothing a report reads: no message, no visitor trace.
      const counts = await env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM message_traces) AS traces",
      ).first<{ messages: number; traces: number }>();
      expect(counts).toEqual({ messages: 0, traces: 0 });

      const res = await adminFetch(
        app,
        `/api/admin/assistants/ast_1/preview-traces/${done.messageId}`,
      );
      expect(res.status).toBe(200);
      const view = (await res.json()) as AnswerTraceView;
      expect(view).toMatchObject({
        messageId: done.messageId,
        source: "try_it",
        tokensIn: 40,
        tokensOut: 6,
      });
      expect(view.trace?.parts[0]).toMatchObject({
        kind: "answer",
        version: { id: draftId, state: "draft", current: { state: "draft" } },
        model: { provider: "anthropic", keySource: "environment" },
        stop: "complete",
      });
      expect(view.trace?.parts[0]?.retrieval.candidates[0]?.content).toMatchObject({
        documentId: "doc_hit",
        excerpt: CHUNK_TEXT,
      });
      // Ids and numbers only, as for a visitor's trace.
      const row = await env.DB.prepare("SELECT detail FROM preview_traces").first<{
        detail: string;
      }>();
      for (const marker of [
        "MODEL_KEY_MARKER",
        "QUESTION_MARKER",
        "CHUNK_TEXT_MARKER",
        "PERSONA_MARKER",
      ]) {
        expect(row?.detail).not.toContain(marker);
      }
    });

    it("records each test-run answer's trace with its run and test, and puts the id on the result", async () => {
      await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
      await tenant.tests.create({
        id: "tst_1",
        assistantId: "ast_1",
        question: QUESTION,
        expectation: { kind: "contains", phrase: "monthly" },
        createdAt: 1000,
      });
      const app = appFor();
      const res = await adminFetch(app, "/api/admin/assistants/ast_1/test-runs", {
        method: "POST",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        runId: string;
        results: Array<{ testId: string; outcome: string; traceId?: string }>;
      };
      const [result] = body.results;
      expect(result).toMatchObject({ testId: "tst_1", outcome: "passed" });
      expect(result?.traceId).toEqual(expect.any(String));

      const row = await tenant.previewTraces.get("ast_1", result?.traceId ?? "");
      expect(row).toMatchObject({ source: "test_run", runId: body.runId, testId: "tst_1" });
      const view = (await (
        await adminFetch(app, `/api/admin/assistants/ast_1/preview-traces/${result?.traceId}`)
      ).json()) as AnswerTraceView;
      expect(view.source).toBe("test_run");
      expect(view.trace?.parts[0]?.version.state).toBe("draft");
      // The stored run keeps the id, so the Tests screen can open it later.
      const stored = await tenant.tests.listWithLatestResult("ast_1");
      expect(stored[0]?.latestResult).toMatchObject({ traceId: result?.traceId });
      // And it is not a visitor answer anywhere.
      const figures = await responseTimeFigures(tenant, "ast_1", {
        fromDay: "1970-01-01",
        toDay: "2999-12-31",
        fromMs: 0,
        toMs: Number.MAX_SAFE_INTEGER,
      });
      expect(figures).toMatchObject({ status: "no_answers", answers: 0 });
    });

    it("keeps preview traces per org and assistant: another org, a visitor reply's id and another assistant find nothing", async () => {
      await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
      const done = await tryIt(appFor());
      const visitor = await ask(appFor());

      const appB = createApp(ownerSeams(ORG_B), { chat: { embedder, retriever } });
      const fromB = await adminFetch(
        appB,
        `/api/admin/assistants/ast_1/preview-traces/${done.messageId}`,
      );
      expect(fromB.status).toBe(404);
      expect(await tenantB.previewTraces.get("ast_1", done.messageId)).toBeNull();

      const app = appFor();
      const visitorId = await adminFetch(
        app,
        `/api/admin/assistants/ast_1/preview-traces/${visitor.done.messageId}`,
      );
      expect(visitorId.status).toBe(404);
      const otherAssistant = await adminFetch(
        app,
        `/api/admin/assistants/ast_other/preview-traces/${done.messageId}`,
      );
      expect(otherAssistant.status).toBe(404);
    });

    it("keeps only the newest preview traces per assistant, and deletes them with it", async () => {
      const part = {
        kind: "answer" as const,
        version: { id: "ver_x", state: "draft" as const },
        model: null,
        retrieval: { floor: SCORE_FLOOR, ms: 1, candidates: [] },
        timing: { firstTokenMs: 1, totalMs: 2 },
        tools: { rounds: 0, ms: 0 },
        stop: "complete" as const,
      };
      for (let i = 0; i <= MAX_PREVIEW_TRACES; i++) {
        await tenant.previewTraces.put({
          id: `msg_p${String(i).padStart(4, "0")}`,
          assistantId: "ast_1",
          source: "try_it",
          tokensIn: 0,
          tokensOut: 0,
          costMicros: 0,
          part,
          createdAt: 10_000 + i,
        });
      }
      const count = async () =>
        (await env.DB.prepare("SELECT COUNT(*) AS n FROM preview_traces").first<{ n: number }>())
          ?.n;
      expect(await count()).toBe(MAX_PREVIEW_TRACES);
      expect(await tenant.previewTraces.get("ast_1", "msg_p0000")).toBeNull();
      expect(
        await tenant.previewTraces.get(
          "ast_1",
          `msg_p${String(MAX_PREVIEW_TRACES).padStart(4, "0")}`,
        ),
      ).not.toBeNull();

      await tenant.assistants.remove("ast_1");
      expect(await count()).toBe(0);
    });
  });

  describe("on the answer path", () => {
    function scripted(rounds: Array<() => AsyncGenerator<LlmChunk>>) {
      let i = 0;
      const provider: LlmProvider = {
        name: "anthropic",
        model: ANTHROPIC_MODELS.fast.id,
        stream() {
          const round = rounds[Math.min(i++, rounds.length - 1)];
          if (!round) throw new Error("no rounds");
          return round();
        },
      };
      return provider;
    }

    function depsWith(
      provider: LlmProvider,
      options: { tenant?: Tenant; runners?: ToolRunner[]; now?: () => number } = {},
    ): AnswerDeps {
      return {
        tenant: options.tenant ?? tenant,
        embedder,
        retriever,
        provider,
        model: ANTHROPIC_MODELS.fast,
        usage: { async record() {} },
        runners: options.runners ?? [],
        now: options.now,
        trace: { version: { id: publishedId, state: "published" }, keySource: "environment" },
      };
    }

    async function drain(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
      const out: ChatEvent[] = [];
      for await (const event of events) out.push(event);
      return out;
    }

    const input = {
      orgId: TEST_ORG_ID,
      assistantId: "ast_1",
      visitorId: "vis_1",
      message: QUESTION,
      behaviour: defaultVersionConfig().behaviour,
    };

    it("records a tool round with its count and time, and leaves the tool's output out", async () => {
      await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
      // Each read of the clock moves it 10 ms, and the tool run 500 ms more.
      let now = 100_000;
      const clock = () => {
        now += 10;
        return now;
      };
      const runner: ToolRunner = {
        kind: "mcp",
        definitions: [{ name: "order_status", description: "Order status", inputSchema: {} }],
        async run() {
          now += 500;
          return { content: TOOL_OUTPUT, isError: false };
        },
      };
      const provider = scripted([
        async function* () {
          yield {
            kind: "tool_call",
            call: { callId: "call_1", name: "order_status", input: { id: "42" } },
          };
          yield { kind: "usage", tokensIn: 50, tokensOut: 5, stopReason: "tools" };
        },
        async function* () {
          yield { kind: "text", text: "Order 42 has shipped." };
          yield { kind: "usage", tokensIn: 80, tokensOut: 6, stopReason: "end" };
        },
      ]);

      const events = await drain(
        answerMessage(depsWith(provider, { runners: [runner], now: clock }), input),
      );
      const done = events.find((e) => e.type === "done");
      if (done?.type !== "done") throw new Error("expected done");

      const part = (await tenant.traces.get(done.messageId))?.parts[0];
      expect(part?.tools.rounds).toBe(1);
      expect(part?.tools.ms).toBeGreaterThanOrEqual(500);
      expect(part?.retrieval.ms).toBeGreaterThan(0);
      // The first token came after the tool round.
      expect(part?.timing.firstTokenMs).toBeGreaterThan(part?.tools.ms ?? 0);
      expect(part?.stop).toBe("complete");
      expect(await storedRow(done.messageId)).not.toContain("TOOL_OUTPUT_MARKER");
    });

    it("records a length stop", async () => {
      await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
      const provider = scripted([
        async function* () {
          yield { kind: "text", text: "Invoices are" };
          yield { kind: "usage", tokensIn: 50, tokensOut: 1024, stopReason: "length" };
        },
      ]);
      const events = await drain(answerMessage(depsWith(provider), input));
      const done = events.find((e) => e.type === "done");
      if (done?.type !== "done") throw new Error("expected done");
      expect((await tenant.traces.get(done.messageId))?.parts[0]?.stop).toBe("length");
    });

    it("answers in full when the trace write fails, and logs it", async () => {
      await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const failing: Tenant = {
        ...tenant,
        traces: {
          ...tenant.traces,
          async put() {
            throw new Error("D1_ERROR: disk full");
          },
        },
      };
      const provider = scripted([
        async function* () {
          yield { kind: "text", text: "Invoices go out monthly." };
          yield { kind: "usage", tokensIn: 50, tokensOut: 6, stopReason: "end" };
        },
      ]);

      const events = await drain(answerMessage(depsWith(provider, { tenant: failing }), input));
      expect(events.map((e) => e.type)).toEqual(["token", "citation", "done"]);
      const done = events.find((e) => e.type === "done");
      if (done?.type !== "done") throw new Error("expected done");
      expect((await tenant.messages.get(done.messageId))?.content).toBe("Invoices go out monthly.");
      expect(await tenant.traces.get(done.messageId)).toBeNull();
      expect(errors).toHaveBeenCalledWith("chat: trace write failed", {
        error: "D1_ERROR: disk full",
      });
    });

    it("keeps a preview's trace apart from visitor replies only when told where it goes", async () => {
      await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
      const provider = scripted([
        async function* () {
          yield { kind: "text", text: "Invoices go out monthly." };
          yield { kind: "usage", tokensIn: 50, tokensOut: 6, stopReason: "end" };
        },
      ]);
      // No target: nowhere to keep it, and never on `message_traces`.
      await drain(answerMessage(depsWith(provider), { ...input, preview: true }));
      const marked = await drain(
        answerMessage(
          {
            ...depsWith(provider),
            trace: {
              version: { id: "ver_draft", state: "draft" },
              keySource: "stored",
              preview: { source: "try_it" },
            },
          },
          { ...input, preview: true },
        ),
      );
      const done = marked.find((e) => e.type === "done");
      if (done?.type !== "done") throw new Error("expected done");
      const counts = await env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM message_traces) AS visitor,
                (SELECT COUNT(*) FROM preview_traces) AS preview,
                (SELECT COUNT(*) FROM messages) AS messages`,
      ).first<{ visitor: number; preview: number; messages: number }>();
      expect(counts).toEqual({ visitor: 0, preview: 1, messages: 0 });
      const row = await tenant.previewTraces.get("ast_1", done.messageId);
      expect(row).toMatchObject({
        source: "try_it",
        runId: null,
        testId: null,
        tokensIn: 50,
        tokensOut: 6,
      });
      expect(row?.trace?.parts[0]).toMatchObject({
        version: { id: "ver_draft", state: "draft" },
        model: { provider: "anthropic", keySource: "stored" },
        retrieval: { candidates: [{ chunkId: "chk_hit", used: true }] },
        stop: "complete",
      });
    });

    it("reads the key source only after the reply is sent, and not at all when no model was asked", async () => {
      await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
      const keySource = vi.fn(async () => "stored" as const);
      const provider = scripted([
        async function* () {
          yield { kind: "text", text: "Invoices go out monthly." };
          yield { kind: "usage", tokensIn: 50, tokensOut: 6, stopReason: "end" };
        },
      ]);
      const deps: AnswerDeps = {
        ...depsWith(provider),
        trace: { version: { id: publishedId, state: "published" }, keySource },
      };
      let callsAtDone = -1;
      let messageId = "";
      for await (const event of answerMessage(deps, input)) {
        if (event.type === "token") expect(keySource).not.toHaveBeenCalled();
        if (event.type === "done") {
          callsAtDone = keySource.mock.calls.length;
          messageId = event.messageId;
        }
      }
      expect(callsAtDone).toBe(0);
      expect(keySource).toHaveBeenCalledTimes(1);
      expect((await tenant.traces.get(messageId))?.parts[0]?.model?.keySource).toBe("stored");

      keySource.mockClear();
      await drain(answerMessage(deps, { ...input, message: "zzz nothing matches this" }));
      expect(keySource).not.toHaveBeenCalled();
    });

    it("counts only visitor answers in Response time: a Try it or test-run answer is left out", async () => {
      await seedChunk("chk_hit", "doc_hit", CHUNK_TEXT, QUESTION);
      // A visitor answer, through the real route.
      const { done } = await ask(appFor());
      const visitor = await tenant.messages.get(done.messageId);
      // A "Try it" answer and a test run take this same path with `preview: true`.
      const provider = scripted([
        async function* () {
          yield { kind: "text", text: "Invoices go out monthly." };
          yield { kind: "usage", tokensIn: 50, tokensOut: 6, stopReason: "end" };
        },
      ]);
      await drain(answerMessage(depsWith(provider), { ...input, preview: true }));
      // Marked previews keep a trace, in a table no report reads.
      await drain(
        answerMessage(
          {
            ...depsWith(provider),
            trace: {
              version: { id: "ver_draft", state: "draft" },
              keySource: "environment",
              preview: { source: "test_run", runId: "run_1", testId: "tst_1" },
            },
          },
          { ...input, preview: true },
        ),
      );

      const figures = await responseTimeFigures(tenant, "ast_1", {
        fromDay: "1970-01-01",
        toDay: "2999-12-31",
        fromMs: 0,
        toMs: Number.MAX_SAFE_INTEGER,
      });
      expect(figures).toMatchObject({ status: "measured", answers: 1, timed: 1 });
      expect(figures.firstTokenMedianMs).toBe(visitor?.firstTokenMs);
      expect(figures.totalMedianMs).toBe(visitor?.totalMs);
    });
  });
});
