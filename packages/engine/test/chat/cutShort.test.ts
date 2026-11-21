import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  CHAT_PROTOCOL_VERSION,
  type ChatEvent,
  type PageAction,
  parseChatEventLine,
} from "@solvchat/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { stopFor } from "../../src/chat/answer.js";
import { CUT_SHORT_LINE, cutShortSuffix, openFence } from "../../src/chat/cutShort.js";
import {
  ANSWER_REASONING_TOKENS,
  ANSWER_VISIBLE_TOKENS,
  answerOutputLimit,
  buildPrompt,
  MAX_OUTPUT_TOKENS,
  SAFETY_FRAME,
} from "../../src/chat/prompt.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS, costMicros } from "../../src/models.js";
import { anthropicProvider } from "../../src/providers/anthropic.js";
import type { LlmChunk, LlmProvider, LlmRequest, ToolCall } from "../../src/providers/types.js";
import type { UsageEvent } from "../../src/seams/types.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { fakeSeams, TEST_ORG_ID } from "../helpers/app.js";
import { numberedConfig } from "../helpers/config.js";

const QUESTION = "Show me example code for CORS headers in Express";
const CUT_IN_FENCE =
  "Set the headers in a middleware. A simpler setup looks like this:\n\n```js\napp.use((req, res, next) => {\n  res.set(";
const NAVIGATE_ACTION: PageAction = {
  name: "navigate",
  description: "Open another page on this site.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  confirm: false,
};
const NAVIGATE_CALL: ToolCall = {
  callId: "call_nav_1",
  name: "navigate",
  input: { path: "/cors" },
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

function streamedText(events: readonly ChatEvent[]): string {
  return events.map((e) => (e.type === "token" ? e.text : "")).join("");
}

/**
 * Answers with the scripted rounds in order; the answer review (its own
 * frame) is answered with a label and does not use up a round.
 */
function scripted(rounds: Array<() => AsyncGenerator<LlmChunk>>, seen: LlmRequest[] = []) {
  let next = 0;
  const provider: LlmProvider = {
    name: "anthropic",
    model: ANTHROPIC_MODELS.fast.id,
    async *stream(request) {
      if (!request.system.startsWith(SAFETY_FRAME)) {
        yield { kind: "text", text: "outcome: partial" };
        yield { kind: "usage", tokensIn: 1, tokensOut: 1, stopReason: "end" };
        return;
      }
      seen.push(request);
      const round = rounds[next++];
      if (!round) throw new Error("no more rounds");
      yield* round();
    },
  };
  return provider;
}

describe("chat/cutShort", () => {
  describe("closing a cut answer", () => {
    it("finds a fence left open, by the widget's rules", () => {
      expect(openFence("text")).toBeNull();
      expect(openFence("```js\ncode")).toBe("```");
      expect(openFence("```js\ncode\n```\nafter")).toBeNull();
      expect(openFence("````\ncode\n```\nmore")).toBe("````");
      expect(openFence("````\ncode\n````")).toBeNull();
      expect(openFence("Inline ```code``` only")).toBeNull();
      expect(openFence("   ```\nindented open")).toBe("```");
    });

    it("closes the fence on its own line, then adds the closing line", () => {
      expect(cutShortSuffix(CUT_IN_FENCE)).toBe(`\n\`\`\`\n\n${CUT_SHORT_LINE}`);
      expect(cutShortSuffix("```\ncode\n")).toBe(`\`\`\`\n\n${CUT_SHORT_LINE}`);
      expect(cutShortSuffix("Your server must still validate")).toBe(`\n\n${CUT_SHORT_LINE}`);
      expect(cutShortSuffix("A line.\n")).toBe(`\n${CUT_SHORT_LINE}`);
      expect(cutShortSuffix("A line.\n\n")).toBe(CUT_SHORT_LINE);
      expect(cutShortSuffix("")).toBe(CUT_SHORT_LINE);
    });

    it("maps each neutral stop reason to the trace's words", () => {
      expect(stopFor("end")).toBe("complete");
      expect(stopFor(undefined)).toBe("complete");
      expect(stopFor("length")).toBe("length");
      expect(stopFor("tools")).toBe("tool");
      expect(stopFor("refused")).toBe("refused");
    });
  });

  describe("the output limit", () => {
    it("leaves the visible answer its allowance on top of room for reasoning", () => {
      expect(MAX_OUTPUT_TOKENS).toBe(ANSWER_VISIBLE_TOKENS + ANSWER_REASONING_TOKENS);
      expect(answerOutputLimit(ANTHROPIC_MODELS.fast)).toBe(MAX_OUTPUT_TOKENS);
      expect(answerOutputLimit(undefined)).toBe(MAX_OUTPUT_TOKENS);
      // Never above what the model accepts.
      expect(answerOutputLimit({ maxOutputTokens: 2000 })).toBe(2000);
      const request = buildPrompt({
        behaviour: { persona: "" },
        chunks: [{ title: "CORS", url: "https://site.example/cors", text: "Set headers." }],
        history: [],
        question: QUESTION,
        model: { maxOutputTokens: 3000 },
      });
      expect(request.maxTokens).toBe(3000);
    });

    it("asks for a focused answer in the frame", () => {
      expect(SAFETY_FRAME).toContain(
        "Keep the answer focused so it finishes in the space you have: lead with the answer, prefer one code example, and name the page that has the rest.",
      );
    });
  });

  describe("on the answer path", () => {
    const tenant = forPrincipal(env.DB, { orgId: TEST_ORG_ID, userId: "usr_1", role: "owner" });
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
        publicKey: "pk_cut_1",
        allowedOrigins: ["https://site.example"],
        createdAt: 1000,
      });
      const config = numberedConfig();
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
        externalId: "cors",
        url: "https://site.example/docs/cors",
        title: "CORS",
        contentHash: "hash_1",
        updatedAt: 1000,
      });
      await tenant.documents.replaceChunks("doc_1", [
        { id: "chk_1", ordinal: 0, text: "Set CORS headers in middleware.", headingPath: "CORS" },
      ]);
      const [vec] = (await embedder.embed([QUESTION], async () => {})).vectors;
      await retriever.upsert([
        { chunkId: "chk_1", vector: vec ?? [], orgId: TEST_ORG_ID, assistantId: "ast_1" },
      ]);
    });

    async function post(
      app: ReturnType<typeof createApp>,
      body: Record<string, unknown>,
    ): Promise<ChatEvent[]> {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request("https://engine.example/v1/chat", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://site.example" },
          body: JSON.stringify({
            protocol: CHAT_PROTOCOL_VERSION,
            assistant: "pk_cut_1",
            visitorId: "vis_1",
            ...body,
          }),
        }),
        env,
        ctx,
      );
      const events = parseSse(await res.text());
      await waitOnExecutionContext(ctx);
      return events;
    }

    function doneOf(events: readonly ChatEvent[]) {
      const done = events.find((e) => e.type === "done");
      if (done?.type !== "done") throw new Error(`expected done, got ${JSON.stringify(events)}`);
      return done;
    }

    it("closes the fence and adds the closing line in what is streamed and stored", async () => {
      const usage: UsageEvent[] = [];
      const seen: LlmRequest[] = [];
      const provider = scripted(
        [
          async function* () {
            yield { kind: "text", text: CUT_IN_FENCE };
            yield { kind: "usage", tokensIn: 900, tokensOut: 5120, stopReason: "length" };
          },
        ],
        seen,
      );
      const app = createApp(
        fakeSeams({
          usage: {
            async record(event) {
              usage.push(event);
            },
          },
        }),
        { chat: { embedder, retriever, provider, model: ANTHROPIC_MODELS.fast } },
      );

      const events = await post(app, { message: QUESTION });
      const expected = `${CUT_IN_FENCE}\n\`\`\`\n\n${CUT_SHORT_LINE}`;
      expect(streamedText(events)).toBe(expected);
      // The closing words come before the citations, which stay as sent.
      expect(events.map((e) => e.type)).toEqual(["token", "token", "citation", "done"]);
      expect(events[2]).toEqual({
        type: "citation",
        url: "https://site.example/docs/cors",
        title: "CORS",
      });
      const done = doneOf(events);
      const stored = await tenant.messages.get(done.messageId);
      expect(stored?.content).toBe(expected);
      expect(stored?.answered).toBe(true);
      expect(stored?.citations).toEqual([{ url: "https://site.example/docs/cors", title: "CORS" }]);
      expect((await tenant.traces.get(done.messageId))?.parts.map((p) => p.stop)).toEqual([
        "length",
      ]);
      // The answer's own call asked for the full limit, and the billed tokens
      // (reasoning included) were counted as reported.
      expect(seen[0]?.maxTokens).toBe(MAX_OUTPUT_TOKENS);
      expect(stored?.tokensOut).toBe(5120);
      // The first event is the question's embedding (not a message).
      expect(usage.find((e) => e.messages === 1)).toMatchObject({
        messages: 1,
        tokensIn: 900,
        tokensOut: 5120,
        costMicros: costMicros(ANTHROPIC_MODELS.fast, 900, 5120),
      });
    });

    it("leaves a finished answer as it was", async () => {
      const provider = scripted([
        async function* () {
          yield { kind: "text", text: "Use the cors middleware.\n\n```js\napp.use(cors());\n```" };
          yield { kind: "usage", tokensIn: 900, tokensOut: 300, stopReason: "end" };
        },
      ]);
      const app = createApp(fakeSeams(), { chat: { embedder, retriever, provider } });
      const events = await post(app, { message: QUESTION });
      const done = doneOf(events);
      expect(streamedText(events)).not.toContain(CUT_SHORT_LINE);
      expect((await tenant.messages.get(done.messageId))?.content).toBe(
        "Use the cors middleware.\n\n```js\napp.use(cors());\n```",
      );
      expect((await tenant.traces.get(done.messageId))?.parts[0]?.stop).toBe("complete");
    });

    it("closes an answer cut after a page-action resume, once, on the whole reply", async () => {
      const provider = scripted([
        async function* () {
          yield { kind: "text", text: "Opening the CORS page. " };
          yield { kind: "tool_call", call: NAVIGATE_CALL };
          yield { kind: "usage", tokensIn: 100, tokensOut: 30, stopReason: "tools" };
        },
        async function* () {
          yield { kind: "text", text: "Here:\n\n```js\nres.set(" };
          yield { kind: "usage", tokensIn: 140, tokensOut: 5120, stopReason: "length" };
        },
      ]);
      const app = createApp(fakeSeams(), {
        chat: { embedder, retriever, provider, model: ANTHROPIC_MODELS.fast },
      });

      const first = await post(app, { message: QUESTION, pageActions: [NAVIGATE_ACTION] });
      const paused = doneOf(first);
      expect(streamedText(first)).toBe("Opening the CORS page. ");

      const second = await post(app, {
        conversationId: paused.conversationId,
        resumeMessageId: paused.messageId,
        actionResults: [{ callId: NAVIGATE_CALL.callId, ok: true, result: "opened" }],
      });
      const done = doneOf(second);
      expect(streamedText(second)).toBe(`Here:\n\n\`\`\`js\nres.set(\n\`\`\`\n\n${CUT_SHORT_LINE}`);
      expect(second.some((e) => e.type === "citation")).toBe(true);
      const stored = await tenant.messages.get(done.messageId);
      expect(stored?.content).toBe(
        `Opening the CORS page. Here:\n\n\`\`\`js\nres.set(\n\`\`\`\n\n${CUT_SHORT_LINE}`,
      );
      expect(stored?.tokensOut).toBe(5150);
      expect((await tenant.traces.get(done.messageId))?.parts.map((p) => p.stop)).toEqual([
        "paused",
        "length",
      ]);
    });

    it("records the real provider's length stop from a reply that reasoned first", async () => {
      const bodies: Record<string, unknown>[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          const answer = String(body.system ?? "").startsWith(SAFETY_FRAME);
          if (answer) bodies.push(body);
          const events = answer
            ? [
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":900}}}\n\n',
                'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
                'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
                `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "CORS doesn't replace authorization" } })}\n\n`,
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":5120,"output_tokens_details":{"thinking_tokens":4300}}}\n\n',
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
              ]
            : [
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
                'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"outcome: partial"}}\n\n',
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
              ];
          return new Response(events.join(""), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }),
      );
      try {
        const provider = anthropicProvider({ apiKey: "k", model: ANTHROPIC_MODELS.fast.id });
        const app = createApp(fakeSeams(), {
          chat: { embedder, retriever, provider, model: ANTHROPIC_MODELS.fast },
        });
        const events = await post(app, { message: QUESTION });
        const done = doneOf(events);
        expect(bodies[0]?.max_tokens).toBe(MAX_OUTPUT_TOKENS);
        expect(streamedText(events)).toBe(
          `CORS doesn't replace authorization\n\n${CUT_SHORT_LINE}`,
        );
        // Billed output is the provider's total, thinking included.
        expect((await tenant.messages.get(done.messageId))?.tokensOut).toBe(5120);
        expect((await tenant.traces.get(done.messageId))?.parts[0]?.stop).toBe("length");
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
