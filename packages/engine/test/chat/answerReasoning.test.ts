import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  CHAT_PROTOCOL_VERSION,
  type ChatEvent,
  defaultVersionConfig,
  type PageAction,
  parseChatEventLine,
} from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { answerMessage } from "../../src/chat/answer.js";
import { answerReasoningOff, type ChatRouteOverrides } from "../../src/chat/route.js";
import type { ToolRunner } from "../../src/chat/toolLoop.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS, OPENAI_MODELS, type Tier } from "../../src/models.js";
import { REASONING_FALLBACK_MIN_OUTPUT_TOKENS } from "../../src/providers/reasoning.js";
import type { LlmProvider, LlmRequest, ToolCall } from "../../src/providers/types.js";
import type { LlmProviderName } from "../../src/seams/types.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

const QUESTION = "How do I change my plan?";

const NAVIGATE_ACTION: PageAction = {
  name: "navigate",
  description: "Open another page on this site.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  confirm: false,
};

const NAVIGATE_CALL: ToolCall = {
  callId: "call_nav_1",
  name: "navigate",
  input: { path: "/billing" },
};

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

/**
 * A provider that records every request. The first answer of a visitor
 * conversation asks for a page action (a tool round that pauses); every
 * other call just answers.
 */
function recordingProvider(name: LlmProviderName, seen: LlmRequest[]): LlmProvider {
  return {
    name,
    model: "model-under-test",
    async *stream(request) {
      seen.push(request);
      const asksAction =
        (request.tools ?? []).some((t) => t.name === "navigate") &&
        !request.messages.some((m) => m.role === "tool_results");
      if (asksAction) {
        yield { kind: "text", text: "Opening it. " };
        yield { kind: "tool_call", call: NAVIGATE_CALL };
        yield { kind: "usage", tokensIn: 10, tokensOut: 5, stopReason: "tools" };
        return;
      }
      yield { kind: "text", text: "Change it on the billing page." };
      yield { kind: "usage", tokensIn: 10, tokensOut: 5, stopReason: "end" };
    },
  };
}

/** The same request with the switch taken out, serialised. */
function withoutSwitch(request: LlmRequest | undefined): string {
  if (request === undefined) throw new Error("no request");
  const { reasoning: _reasoning, ...rest } = request;
  return JSON.stringify(rest);
}

describe("fast-tier answers: reasoning off", () => {
  const tenant = forPrincipal(env.DB, { orgId: TEST_ORG_ID, userId: "owner", role: "owner" });
  const embedder = fakeEmbedder();
  let retriever = memoryRetriever();

  beforeEach(async () => {
    retriever = memoryRetriever();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_daily"),
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
      publicKey: "pk_reason_1",
      allowedOrigins: ["https://site.example"],
      createdAt: 1000,
    });
    const config = defaultVersionConfig();
    config.actions = { builtins: true, allowedOrigins: [] };
    const draft = await tenant.versions.createDraft({
      id: "ver_1",
      assistantId: "ast_1",
      config,
      createdAt: 1000,
    });
    await tenant.versions.publishDraft("ast_1", draft.id, "ver_2", 2000);
    await tenant.sources.create({
      id: "src_1",
      assistantId: "ast_1",
      kind: "push",
      label: "Docs",
      settings: {},
      createdAt: 1000,
    });
    await tenant.documents.upsert({
      id: "doc_1",
      sourceId: "src_1",
      externalId: "billing",
      url: "https://site.example/billing",
      title: "Billing",
      contentHash: "hash_1",
      updatedAt: 1000,
    });
    await tenant.documents.replaceChunks("doc_1", [
      { id: "chk_1", ordinal: 0, text: "Change your plan on the billing page.", headingPath: "" },
    ]);
    const [vec] = (await embedder.embed([QUESTION], async () => {})).vectors;
    await retriever.upsert([
      { chunkId: "chk_1", vector: vec ?? [], orgId: TEST_ORG_ID, assistantId: "ast_1" },
    ]);
    await tenant.tests.create({
      id: "tst_1",
      assistantId: "ast_1",
      question: QUESTION,
      expectation: { kind: "contains", phrase: "billing" },
      createdAt: 1000,
    });
  });

  async function post(
    app: ReturnType<typeof createApp>,
    path: string,
    body: Record<string, unknown>,
    extraEnv: Record<string, string> = {},
  ): Promise<Response> {
    const ctx = createExecutionContext();
    const admin = path.startsWith("/api/admin/");
    const res = await app.fetch(
      new Request(`https://engine.example${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: admin ? "https://engine.example" : "https://site.example",
        },
        body: JSON.stringify(body),
      }),
      { ...env, ...extraEnv },
      ctx,
    );
    const text = await res.clone().text();
    await waitOnExecutionContext(ctx);
    return new Response(text, { status: res.status, headers: res.headers });
  }

  async function chat(
    app: ReturnType<typeof createApp>,
    body: Record<string, unknown>,
    path = "/v1/chat",
    extraEnv: Record<string, string> = {},
  ): Promise<ChatEvent[]> {
    const res = await post(
      app,
      path,
      {
        protocol: CHAT_PROTOCOL_VERSION,
        assistant: "pk_reason_1",
        visitorId: "vis_1",
        ...body,
      },
      extraEnv,
    );
    return parseSse(await res.text());
  }

  /**
   * Every answer-generating call site, in order: the visitor's first call
   * (asks a page action), its page-action continuation, Try it, and a test
   * run. Returns the requests the provider saw for each.
   */
  async function everyCallSite(providerKind: LlmProviderName, tier: Tier) {
    const seen: LlmRequest[] = [];
    const overrides: ChatRouteOverrides = {
      embedder,
      retriever,
      provider: recordingProvider(providerKind, seen),
      providerKind,
      tier,
      reviewer: null,
    };
    const app = createApp(fakeSeams(), { chat: overrides });

    const first = await chat(app, { message: QUESTION, pageActions: [NAVIGATE_ACTION] });
    const paused = first.find((e) => e.type === "done");
    if (paused?.type !== "done") throw new Error("expected done");
    expect(paused.awaitingActions).toEqual([NAVIGATE_CALL.callId]);
    const visitor = seen.splice(0);

    const resumed = await chat(app, {
      conversationId: paused.conversationId,
      resumeMessageId: paused.messageId,
      actionResults: [{ callId: NAVIGATE_CALL.callId, ok: true, result: "opened" }],
      pageActions: [NAVIGATE_ACTION],
    });
    expect(resumed.some((e) => e.type === "error")).toBe(false);
    const resume = seen.splice(0);

    const tryIt = await chat(app, { message: QUESTION, target: "draft" }, "/api/admin/chat");
    expect(tryIt.some((e) => e.type === "done")).toBe(true);
    const preview = seen.splice(0);

    const run = await post(app, "/api/admin/assistants/ast_1/test-runs", {});
    expect(run.status).toBe(201);
    const testRun = seen.splice(0);

    const trace = await tenant.traces.get(paused.messageId);
    return { visitor, resume, preview, testRun, trace };
  }

  it.each([
    ["anthropic", "fast", true],
    ["openai", "fast", true],
    ["anthropic", "balanced", false],
    ["openai", "balanced", false],
    ["openrouter", "fast", false],
    ["openrouter", "balanced", false],
  ] as const)("decides %s %s: off = %s", (kind, tier, off) => {
    expect(answerReasoningOff(kind, tier)).toBe(off);
  });

  it.each(["anthropic", "openai"] as const)(
    "sends reasoning off on every %s fast-tier answer call, and only the switch differs from the balanced tier",
    async (kind) => {
      const fast = await everyCallSite(kind, "fast");
      for (const site of [fast.visitor, fast.resume, fast.preview, fast.testRun]) {
        expect(site).toHaveLength(1);
        expect(site.every((r) => r.reasoning === "off")).toBe(true);
      }

      const balanced = await everyCallSite(kind, "balanced");
      const pairs = [
        [fast.visitor, balanced.visitor],
        [fast.resume, balanced.resume],
        [fast.preview, balanced.preview],
        [fast.testRun, balanced.testRun],
      ] as const;
      for (const [fastSite, balancedSite] of pairs) {
        expect(balancedSite).toHaveLength(fastSite.length);
        balancedSite.forEach((request, i) => {
          // The balanced request is the request as it was before: no
          // `reasoning` key at all, and otherwise the same bytes.
          expect(Object.keys(request)).not.toContain("reasoning");
          expect(JSON.stringify(request)).toBe(withoutSwitch(fastSite[i]));
        });
      }

      // One boolean beside the model, on both parts of the paused answer.
      expect(fast.trace?.parts.map((p) => p.model?.reasoningOff)).toEqual([true, true]);
      expect(balanced.trace?.parts.map((p) => p.model?.reasoningOff)).toEqual([false, false]);
    },
  );

  it("leaves OpenRouter answers at the model's default", async () => {
    const openrouter = await everyCallSite("openrouter", "fast");
    const anthropicBalanced = await everyCallSite("anthropic", "balanced");
    for (const [site, same] of [
      [openrouter.visitor, anthropicBalanced.visitor],
      [openrouter.resume, anthropicBalanced.resume],
      [openrouter.preview, anthropicBalanced.preview],
      [openrouter.testRun, anthropicBalanced.testRun],
    ] as const) {
      expect(site).toHaveLength(1);
      expect(site.map((r) => JSON.stringify(r))).toEqual(same.map((r) => JSON.stringify(r)));
      expect(site.some((r) => "reasoning" in r)).toBe(false);
    }
    expect(openrouter.trace?.parts.map((p) => p.model?.reasoningOff)).toEqual([false, false]);
  });

  it("sends the switch on every round of the tool loop", async () => {
    const lookup: ToolCall = { callId: "call_lookup", name: "lookup", input: {} };
    const runner: ToolRunner = {
      kind: "mcp",
      definitions: [
        { name: "lookup", description: "Look something up.", inputSchema: { type: "object" } },
      ],
      async run() {
        return { content: "found", isError: false };
      },
    };
    for (const reasoningOff of [true, false]) {
      const seen: LlmRequest[] = [];
      let round = 0;
      const provider: LlmProvider = {
        name: "anthropic",
        model: ANTHROPIC_MODELS.fast.id,
        async *stream(request) {
          seen.push(request);
          round += 1;
          if (round < 3) {
            yield { kind: "tool_call", call: { ...lookup, callId: `${lookup.callId}_${round}` } };
            yield { kind: "usage", tokensIn: 5, tokensOut: 5, stopReason: "tools" };
            return;
          }
          yield { kind: "text", text: "Done." };
          yield { kind: "usage", tokensIn: 5, tokensOut: 5, stopReason: "end" };
        },
      };
      const events: ChatEvent[] = [];
      for await (const event of answerMessage(
        {
          tenant,
          embedder,
          retriever,
          provider,
          usage: { async record() {} },
          runners: [runner],
          reasoningOff,
        },
        {
          orgId: TEST_ORG_ID,
          assistantId: "ast_1",
          visitorId: "vis_loop",
          message: QUESTION,
          behaviour: defaultVersionConfig().behaviour,
          preview: true,
        },
      )) {
        events.push(event);
      }
      expect(events.some((e) => e.type === "done")).toBe(true);
      expect(seen).toHaveLength(3);
      if (reasoningOff) {
        expect(seen.map((r) => r.reasoning)).toEqual(["off", "off", "off"]);
      } else {
        expect(seen.some((r) => "reasoning" in r)).toBe(false);
      }
    }
  });

  describe("through the real provider clients", () => {
    const ANTHROPIC_TEXT = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Use the billing page."}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const OPENAI_TEXT = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Use the billing page."}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
    ].join("");

    function fakeFetch(bodies: string[], refuseSwitch = false): typeof fetch {
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const body = String(init?.body ?? "");
        bodies.push(body);
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (refuseSwitch && ("thinking" in parsed || "reasoning" in parsed)) {
          return Response.json(
            { type: "error", error: { type: "invalid_request_error" } },
            { status: 400 },
          );
        }
        const sse = url.includes("anthropic.com") ? ANTHROPIC_TEXT : OPENAI_TEXT;
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch;
    }

    function appWith(kind: LlmProviderName, tier: Tier, fetchImpl: typeof fetch) {
      return createApp(fakeSeams(), {
        chat: { embedder, retriever, providerKind: kind, tier, fetch: fetchImpl, reviewer: null },
      });
    }

    it.each([
      ["anthropic", ANTHROPIC_MODELS, "thinking", { type: "disabled" }],
      ["openai", OPENAI_MODELS, "reasoning", { effort: "none" }],
    ] as const)(
      "%s: the fast-tier body carries the switch; the balanced body is the body of today",
      async (kind, models, field, value) => {
        const fastBodies: string[] = [];
        const balancedBodies: string[] = [];
        await chat(appWith(kind, "fast", fakeFetch(fastBodies)), { message: QUESTION });
        await chat(appWith(kind, "balanced", fakeFetch(balancedBodies)), { message: QUESTION });
        expect(fastBodies).toHaveLength(1);
        expect(balancedBodies).toHaveLength(1);

        const fast = JSON.parse(fastBodies[0] ?? "{}") as Record<string, unknown>;
        expect(fast[field]).toEqual(value);
        expect(fast.model).toBe(models.fast.id);

        // Take the switch out and swap the model id: the same bytes as the
        // balanced request, which carries no switch.
        const { [field]: _switch, ...rest } = fast;
        expect(balancedBodies[0]).toBe(JSON.stringify({ ...rest, model: models.balanced.id }));
        expect(JSON.parse(balancedBodies[0] ?? "{}")).not.toHaveProperty(field);
      },
    );

    it("OpenRouter: the answer body has no reasoning field", async () => {
      const bodies: string[] = [];
      const app = createApp(fakeSeams(), {
        chat: {
          embedder,
          retriever,
          providerKind: "openrouter",
          fetch: fakeFetch(bodies),
          reviewer: null,
        },
      });
      await chat(app, { message: QUESTION }, "/v1/chat", { SOLV_LLM_MODEL: "vendor/model" });
      // The OpenRouter stream format differs; only the request is checked here.
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(Object.keys(JSON.parse(body) as object).sort()).toEqual(
          ["max_tokens", "messages", "model", "stream"].sort(),
        );
      }
    });

    it.each(["anthropic", "openai"] as const)(
      "%s: a model that refuses the switch still answers, with the fallback limit",
      async (kind) => {
        const bodies: string[] = [];
        const events = await chat(appWith(kind, "fast", fakeFetch(bodies, true)), {
          message: QUESTION,
        });
        expect(events.some((e) => e.type === "error")).toBe(false);
        expect(
          events
            .filter((e) => e.type === "token")
            .map((e) => (e.type === "token" ? e.text : ""))
            .join(""),
        ).toBe("Use the billing page.");
        expect(events.some((e) => e.type === "done")).toBe(true);

        expect(bodies).toHaveLength(2);
        const [refused, retried] = bodies.map((b) => JSON.parse(b) as Record<string, unknown>);
        const limit = kind === "anthropic" ? "max_tokens" : "max_output_tokens";
        expect(refused?.[limit]).toBe(1024);
        expect(retried).not.toHaveProperty(kind === "anthropic" ? "thinking" : "reasoning");
        expect(retried?.[limit]).toBe(REASONING_FALLBACK_MIN_OUTPUT_TOKENS);

        const done = events.find((e) => e.type === "done");
        if (done?.type !== "done") throw new Error("expected done");
        expect((await tenant.messages.get(done.messageId))?.answered).toBe(true);
      },
    );
  });
});
