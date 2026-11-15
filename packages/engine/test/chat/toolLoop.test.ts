import { env } from "cloudflare:test";
import { defaultVersionConfig } from "@solvchat/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerMessage } from "../../src/chat/answer.js";
import { SAFETY_FRAME } from "../../src/chat/prompt.js";
import {
  MAX_TOOL_CALLS_PER_CONVERSATION,
  MAX_TOOL_ITERATIONS,
  MAX_TOOL_RESULT_BYTES,
  runToolLoop,
  type StoredToolCall,
  TOOL_WALL_TIME_MS,
  type ToolRunner,
} from "../../src/chat/toolLoop.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS, costMicros } from "../../src/models.js";
import type {
  LlmProvider,
  LlmRequest,
  ToolCall,
  ToolDefinition,
} from "../../src/providers/types.js";
import type { UsageEvent } from "../../src/seams/types.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { TEST_ORG_ID } from "../helpers/app.js";

const LOOKUP_TOOL: ToolDefinition = {
  name: "lookup_order",
  description: "Look up an order by id.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
};

const NAVIGATE_TOOL: ToolDefinition = {
  name: "navigate",
  description: "Navigate to a page.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

interface ScriptRound {
  text: string;
  calls: ToolCall[];
  tokensIn?: number;
  tokensOut?: number;
}

function scriptedProvider(rounds: readonly ScriptRound[], seenRequests: LlmRequest[]): LlmProvider {
  let round = 0;
  return {
    name: "anthropic",
    model: ANTHROPIC_MODELS.fast.id,
    async *stream(request) {
      seenRequests.push(request);
      const step = rounds[Math.min(round++, rounds.length - 1)];
      if (!step) throw new Error("scriptedProvider: no rounds");
      if (step.text) yield { kind: "text", text: step.text };
      for (const call of step.calls) yield { kind: "tool_call", call };
      yield {
        kind: "usage",
        tokensIn: step.tokensIn ?? 100,
        tokensOut: step.tokensOut ?? 25,
        stopReason: step.calls.length > 0 ? "tools" : "end",
      };
    },
  };
}

async function collectEvents<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe("chat/toolLoop", () => {
  const tenant = forPrincipal(env.DB, {
    orgId: TEST_ORG_ID,
    userId: "usr_1",
    role: "owner",
  });
  const embedder = fakeEmbedder();
  let retriever = memoryRetriever();
  const behaviour = defaultVersionConfig().behaviour;

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
      publicKey: "pk_tool_1",
      allowedOrigins: ["https://site.example"],
      createdAt: 1000,
    });
    const draft = await tenant.versions.createDraft({
      id: "ver_1",
      assistantId: "ast_1",
      config: defaultVersionConfig(),
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
      externalId: "docs/orders",
      url: "https://site.example/docs/orders",
      title: "Orders",
      contentHash: "hash_1",
      updatedAt: 1000,
    });
    await tenant.documents.replaceChunks("doc_1", [
      {
        id: "chk_1",
        ordinal: 0,
        text: "Check order status in your account.",
        headingPath: "Orders",
      },
    ]);
    const embedded = await embedder.embed(["Check order status in your account."], async () => {});
    const vector = embedded.vectors[0];
    if (!vector) throw new Error("fakeEmbedder returned no vector");
    await retriever.upsert([
      {
        chunkId: "chk_1",
        vector,
        orgId: TEST_ORG_ID,
        assistantId: "ast_1",
      },
    ]);
  });

  it("omits tools and keeps SAFETY_FRAME byte-identical when no tools are available", async () => {
    const noToolReqs: LlmRequest[] = [];
    const withToolReqs: LlmRequest[] = [];

    await collectEvents(
      answerMessage(
        {
          tenant,
          embedder,
          retriever,
          provider: scriptedProvider([{ text: "Plain answer.", calls: [] }], noToolReqs),
          model: ANTHROPIC_MODELS.fast,
          usage: { record: async () => {} },
        },
        {
          orgId: TEST_ORG_ID,
          assistantId: "ast_1",
          visitorId: "vis_1",
          message: "Check order status in your account.",
          behaviour,
        },
      ),
    );

    const runner: ToolRunner = {
      kind: "mcp",
      definitions: [LOOKUP_TOOL],
      async run() {
        return { content: '{"status":"shipped"}', isError: false };
      },
    };
    await collectEvents(
      answerMessage(
        {
          tenant,
          embedder,
          retriever,
          provider: scriptedProvider([{ text: "Tool answer.", calls: [] }], withToolReqs),
          model: ANTHROPIC_MODELS.fast,
          usage: { record: async () => {} },
          runners: [runner],
        },
        {
          orgId: TEST_ORG_ID,
          assistantId: "ast_1",
          visitorId: "vis_2",
          message: "Check order status in your account.",
          behaviour,
        },
      ),
    );

    expect(noToolReqs).toHaveLength(1);
    const firstNoToolReq = noToolReqs[0];
    expect(firstNoToolReq).toBeDefined();
    expect(firstNoToolReq && "tools" in firstNoToolReq).toBe(false);
    expect(withToolReqs[0]?.tools).toEqual([LOOKUP_TOOL]);
    expect(noToolReqs[0]?.system).toBe(SAFETY_FRAME);
    expect(withToolReqs[0]?.system).toBe(noToolReqs[0]?.system);
  });

  it("runs a two-round tool exchange, streams both text rounds, emits tool events in order, and meters each model call", async () => {
    const seenRequests: LlmRequest[] = [];
    const usageEvents: UsageEvent[] = [];
    const mcpRunner: ToolRunner = {
      kind: "mcp",
      definitions: [LOOKUP_TOOL],
      async run(call) {
        return {
          content: JSON.stringify({ id: call.input.id, status: "shipped" }),
          isError: false,
        };
      },
    };
    const actionRunner: ToolRunner = {
      kind: "action",
      definitions: [NAVIGATE_TOOL],
      async run(call) {
        return { content: JSON.stringify({ navigated: call.input.path }), isError: false };
      },
    };

    const provider = scriptedProvider(
      [
        {
          text: "Checking ",
          calls: [{ callId: "call_1", name: "lookup_order", input: { id: "ord_9" } }],
          tokensIn: 100,
          tokensOut: 20,
        },
        {
          text: "your order... ",
          calls: [{ callId: "call_2", name: "navigate", input: { path: "/orders/ord_9" } }],
          tokensIn: 150,
          tokensOut: 30,
        },
        {
          text: "It has shipped.",
          calls: [],
          tokensIn: 200,
          tokensOut: 40,
        },
      ],
      seenRequests,
    );

    const events = await collectEvents(
      answerMessage(
        {
          tenant,
          embedder,
          retriever,
          provider,
          model: ANTHROPIC_MODELS.fast,
          usage: {
            record: async (ev) => {
              usageEvents.push(ev);
            },
          },
          runners: [mcpRunner, actionRunner],
        },
        {
          orgId: TEST_ORG_ID,
          assistantId: "ast_1",
          visitorId: "vis_1",
          message: "Check order status in your account.",
          behaviour,
        },
      ),
    );

    expect(seenRequests).toHaveLength(3);
    expect(seenRequests[0]?.tools).toEqual([LOOKUP_TOOL, NAVIGATE_TOOL]);
    expect(seenRequests[1]?.messages.at(-1)).toEqual({
      role: "tool_results",
      results: [{ callId: "call_1", content: '{"id":"ord_9","status":"shipped"}', isError: false }],
    });

    expect(events.filter((e) => e.type === "token")).toEqual([
      { type: "token", text: "Checking " },
      { type: "token", text: "your order... " },
      { type: "token", text: "It has shipped." },
    ]);
    expect(events.filter((e) => e.type === "tool")).toEqual([
      { type: "tool", name: "lookup_order", state: "running", callId: "call_1", kind: "mcp" },
      {
        type: "tool",
        name: "lookup_order",
        state: "done",
        callId: "call_1",
        kind: "mcp",
        ok: true,
      },
      { type: "tool", name: "navigate", state: "running", callId: "call_2", kind: "action" },
      { type: "tool", name: "navigate", state: "done", callId: "call_2", kind: "action", ok: true },
    ]);

    // Three model calls -> three model usage events whose costs sum to real spend.
    const modelEvents = usageEvents.filter((e) => e.tokensIn > 0 || e.tokensOut > 0);
    expect(modelEvents).toHaveLength(3);
    expect(modelEvents.map((e) => e.messages)).toEqual([1, 0, 0]);
    const expectedCost =
      costMicros(ANTHROPIC_MODELS.fast, 100, 20) +
      costMicros(ANTHROPIC_MODELS.fast, 150, 30) +
      costMicros(ANTHROPIC_MODELS.fast, 200, 40);
    expect(modelEvents.reduce((sum, e) => sum + e.costMicros, 0)).toBe(expectedCost);

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done && done.type === "done") {
      const stored = await tenant.messages.get(done.messageId);
      expect(stored?.content).toBe("Checking your order... It has shipped.");
      expect(stored?.tokensIn).toBe(450);
      expect(stored?.tokensOut).toBe(90);
      expect(stored?.toolCalls).toHaveLength(2);
      const calls = stored?.toolCalls as StoredToolCall[];
      expect(calls[0]).toMatchObject({
        callId: "call_1",
        name: "lookup_order",
        kind: "mcp",
        ok: true,
        input: { id: "ord_9" },
      });
      expect(calls[1]).toMatchObject({
        callId: "call_2",
        name: "navigate",
        kind: "action",
        ok: true,
        input: { path: "/orders/ord_9" },
      });
    }
  });

  it("refuses the fifth iteration and lets the model finish without an error event", async () => {
    const seenRequests: LlmRequest[] = [];
    let toolRuns = 0;
    const runner: ToolRunner = {
      kind: "mcp",
      definitions: [LOOKUP_TOOL],
      async run() {
        toolRuns += 1;
        return { content: `{"round":${toolRuns}}`, isError: false };
      },
    };

    const rounds: ScriptRound[] = [
      ...Array.from({ length: MAX_TOOL_ITERATIONS + 1 }, (_, i) => ({
        text: "",
        calls: [{ callId: `c_${i}`, name: "lookup_order", input: { id: `${i}` } }],
      })),
      { text: "Final answer from what I have.", calls: [] },
    ];

    const events = await collectEvents(
      answerMessage(
        {
          tenant,
          embedder,
          retriever,
          provider: scriptedProvider(rounds, seenRequests),
          model: ANTHROPIC_MODELS.fast,
          usage: { record: async () => {} },
          runners: [runner],
        },
        {
          orgId: TEST_ORG_ID,
          assistantId: "ast_1",
          visitorId: "vis_1",
          message: "Check order status in your account.",
          behaviour,
        },
      ),
    );

    expect(toolRuns).toBe(MAX_TOOL_ITERATIONS);
    expect(seenRequests).toHaveLength(MAX_TOOL_ITERATIONS + 2);
    expect(seenRequests.at(-1)?.tools).toBeUndefined();
    expect(seenRequests.at(-1)?.messages.at(-1)).toEqual({
      role: "tool_results",
      results: [
        {
          callId: `c_${MAX_TOOL_ITERATIONS}`,
          content:
            "No more tools are available for this answer. Answer from what you already have.",
          isError: true,
        },
      ],
    });
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.filter((e) => e.type === "token")).toEqual([
      { type: "token", text: "Final answer from what I have." },
    ]);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("refuses the twenty-first tool call in a conversation seeded from prior messages", async () => {
    await tenant.conversations.create({
      id: "cnv_seeded",
      assistantId: "ast_1",
      visitorId: "vis_1",
      startedAt: 1000,
      pageUrl: "https://site.example/",
    });
    await tenant.messages.create({
      id: "msg_q0",
      conversationId: "cnv_seeded",
      role: "user",
      content: "Earlier question",
      citations: [],
      toolCalls: null,
      tokensIn: 0,
      tokensOut: 0,
      answered: true,
      createdAt: 1100,
    });
    const priorCalls: StoredToolCall[] = Array.from(
      { length: MAX_TOOL_CALLS_PER_CONVERSATION - 1 },
      (_, i) => ({
        callId: `prior_${i}`,
        name: "lookup_order",
        kind: "mcp",
        ok: true,
        ms: 5,
        input: { id: `${i}` },
        resultBytes: 2,
        resultPreview: "{}",
      }),
    );
    await tenant.messages.create({
      id: "msg_a0",
      conversationId: "cnv_seeded",
      role: "assistant",
      content: "Earlier answer",
      citations: [],
      toolCalls: priorCalls,
      tokensIn: 10,
      tokensOut: 10,
      answered: true,
      createdAt: 1200,
      replyTo: "msg_q0",
    });

    expect(await tenant.messages.countToolCalls("cnv_seeded")).toBe(
      MAX_TOOL_CALLS_PER_CONVERSATION - 1,
    );

    const seenRequests: LlmRequest[] = [];
    let toolRuns = 0;
    const runner: ToolRunner = {
      kind: "mcp",
      definitions: [LOOKUP_TOOL],
      async run() {
        toolRuns += 1;
        return { content: "{}", isError: false };
      },
    };

    const provider = scriptedProvider(
      [
        // 20th call in conversation: allowed
        { text: "", calls: [{ callId: "c_20", name: "lookup_order", input: { id: "20" } }] },
        // 21st call in conversation: refused
        { text: "", calls: [{ callId: "c_21", name: "lookup_order", input: { id: "21" } }] },
        { text: "Finished within cap.", calls: [] },
      ],
      seenRequests,
    );

    const events = await collectEvents(
      answerMessage(
        {
          tenant,
          embedder,
          retriever,
          provider,
          model: ANTHROPIC_MODELS.fast,
          usage: { record: async () => {} },
          runners: [runner],
        },
        {
          orgId: TEST_ORG_ID,
          assistantId: "ast_1",
          visitorId: "vis_1",
          conversationId: "cnv_seeded",
          message: "Check order status in your account.",
          behaviour,
        },
      ),
    );

    expect(toolRuns).toBe(1);
    expect(seenRequests.at(-1)?.tools).toBeUndefined();
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.filter((e) => e.type === "token")).toEqual([
      { type: "token", text: "Finished within cap." },
    ]);
  });

  it("stops at the wall-time cap and still finishes the answer", async () => {
    let clock = 1000;
    const seenRequests: LlmRequest[] = [];
    const runner: ToolRunner = {
      kind: "mcp",
      definitions: [LOOKUP_TOOL],
      async run() {
        clock += TOOL_WALL_TIME_MS + 1;
        return { content: "{}", isError: false };
      },
    };
    const provider = scriptedProvider(
      [
        { text: "", calls: [{ callId: "c1", name: "lookup_order", input: { id: "1" } }] },
        { text: "", calls: [{ callId: "c2", name: "lookup_order", input: { id: "2" } }] },
        { text: "final answer", calls: [] },
      ],
      seenRequests,
    );

    const loop = runToolLoop(
      {
        provider,
        model: ANTHROPIC_MODELS.fast,
        runners: [runner],
        priorCalls: 0,
        onModelUsage: async () => {},
        now: () => clock,
      },
      { system: SAFETY_FRAME, messages: [{ role: "user", content: "q" }], maxTokens: 100 },
    );

    const yielded: unknown[] = [];
    let outcome: { text: string; calls: StoredToolCall[] } | undefined;
    for (;;) {
      const step = await loop.next();
      if (step.done) {
        outcome = step.value;
        break;
      }
      yielded.push(step.value);
    }

    expect(outcome?.text).toBe("final answer");
    expect(outcome?.calls).toHaveLength(1);
    expect(seenRequests.at(-1)?.tools).toBeUndefined();
  });

  it("handles a failing runner, an error result, and an unknown tool name without failing the answer", async () => {
    const seenRequests: LlmRequest[] = [];
    const throwingRunner: ToolRunner = {
      kind: "mcp",
      definitions: [LOOKUP_TOOL],
      async run(call) {
        if (call.input.mode === "throw") {
          throw new Error("secret upstream token leaked in error");
        }
        return { content: "order not found", isError: true };
      },
    };

    const provider = scriptedProvider(
      [
        {
          text: "",
          calls: [
            { callId: "c_throw", name: "lookup_order", input: { mode: "throw" } },
            { callId: "c_err", name: "lookup_order", input: { mode: "err" } },
            { callId: "c_unk", name: "no_such_tool", input: {} },
          ],
        },
        { text: "Could not look that up, sorry.", calls: [] },
      ],
      seenRequests,
    );

    const events = await collectEvents(
      answerMessage(
        {
          tenant,
          embedder,
          retriever,
          provider,
          model: ANTHROPIC_MODELS.fast,
          usage: { record: async () => {} },
          runners: [throwingRunner],
        },
        {
          orgId: TEST_ORG_ID,
          assistantId: "ast_1",
          visitorId: "vis_1",
          message: "Check order status in your account.",
          behaviour,
        },
      ),
    );

    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(seenRequests[1]?.messages.at(-1)).toEqual({
      role: "tool_results",
      results: [
        { callId: "c_throw", content: "The tool could not be called.", isError: true },
        { callId: "c_err", content: "order not found", isError: true },
        { callId: "c_unk", content: "No tool named no_such_tool is available.", isError: true },
      ],
    });

    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done && done.type === "done") {
      const stored = await tenant.messages.get(done.messageId);
      const calls = stored?.toolCalls as StoredToolCall[];
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.ok === false)).toBe(true);
    }
  });

  it("truncates oversized results with a visible marker and stores only byte count and preview", async () => {
    const seenRequests: LlmRequest[] = [];
    const hugeBody = `${"A".repeat(MAX_TOOL_RESULT_BYTES + 500)}TAIL_SECRET`;
    const runner: ToolRunner = {
      kind: "mcp",
      definitions: [LOOKUP_TOOL],
      async run() {
        return { content: hugeBody, isError: false };
      },
    };

    const provider = scriptedProvider(
      [
        { text: "", calls: [{ callId: "c_big", name: "lookup_order", input: { id: "1" } }] },
        { text: "Summary.", calls: [] },
      ],
      seenRequests,
    );

    const events = await collectEvents(
      answerMessage(
        {
          tenant,
          embedder,
          retriever,
          provider,
          model: ANTHROPIC_MODELS.fast,
          usage: { record: vi.fn(async () => {}) },
          runners: [runner],
        },
        {
          orgId: TEST_ORG_ID,
          assistantId: "ast_1",
          visitorId: "vis_1",
          message: "Check order status in your account.",
          behaviour,
        },
      ),
    );

    const toolResultMsg = seenRequests[1]?.messages.at(-1);
    expect(toolResultMsg?.role).toBe("tool_results");
    if (toolResultMsg && toolResultMsg.role === "tool_results") {
      const resultText = toolResultMsg.results[0]?.content;
      expect(resultText).toContain(
        `[truncated: result was ${new TextEncoder().encode(hugeBody).byteLength} bytes]`,
      );
      expect(resultText).not.toContain("TAIL_SECRET");
    }

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done && done.type === "done") {
      const row = await env.DB.prepare("SELECT tool_calls FROM messages WHERE id = ?1")
        .bind(done.messageId)
        .first<{ tool_calls: string | null }>();
      expect(row?.tool_calls).toBeTruthy();
      expect(row?.tool_calls).not.toContain("TAIL_SECRET");
      const parsed = JSON.parse(row?.tool_calls ?? "[]") as StoredToolCall[];
      expect(parsed[0]?.resultBytes).toBe(new TextEncoder().encode(hugeBody).byteLength);
      expect(parsed[0]?.resultPreview).toBe("A".repeat(200));
    }
  });
});
