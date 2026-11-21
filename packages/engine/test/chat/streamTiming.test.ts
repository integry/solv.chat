import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  CHAT_PROTOCOL_VERSION,
  defaultVersionConfig,
  SOURCES_MODES,
  type SourcesMode,
} from "@solvchat/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

/**
 * Issue #135: where is an answer held back on its way to the widget? The
 * whole engine path runs here in workerd (the runtime `wrangler dev` and a
 * deployed Worker use): the route, the answer pipeline, the tool loop, the
 * real Anthropic stream parser, the link and marker filters and the
 * cut-short handling. Only the model is a stand-in: an upstream that thinks
 * for a while (a thinking block, which shows nothing) and then writes one
 * text delta at a steady pace. Each `token` event's arrival is timed at the
 * response body, as the widget would read it.
 */

const QUESTION = "How do I reset my password?";
const THINK_MS = 400;
const DELTA_MS = 30;
const DELTAS = [
  "To reset ",
  "your password",
  " [1]:\n\n",
  "1. Open ",
  "[Settings](https://site.example/settings)",
  ".\n2. Choose ",
  "**Forgot ",
  "Password**",
  " [2].\n\n",
  "```sh\n",
  "solv reset --email you@example.com\n",
  "```\n",
  "That is ",
  "all [1",
  "].",
];

interface Timing {
  firstTokenMs: number;
  lastTokenMs: number;
  /** Separate reads of the body that carried at least one token. */
  tokenReads: number;
  tokenEvents: number;
  text: string;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The model: message start, a thinking block, then the deltas one at a time. */
function pacedUpstream(stopReason: "end_turn" | "max_tokens"): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (s: string) => controller.enqueue(encoder.encode(s));
        send(
          sse("message_start", { type: "message_start", message: { usage: { input_tokens: 50 } } }),
        );
        send(
          sse("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          }),
        );
        await wait(THINK_MS);
        send(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
        send(
          sse("content_block_start", {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          }),
        );
        for (const text of DELTAS) {
          send(
            sse("content_block_delta", {
              type: "content_block_delta",
              index: 1,
              delta: { type: "text_delta", text },
            }),
          );
          await wait(DELTA_MS);
        }
        send(sse("content_block_stop", { type: "content_block_stop", index: 1 }));
        send(
          sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason },
            usage: { output_tokens: 40 },
          }),
        );
        send(sse("message_stop", { type: "message_stop" }));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

async function seed(sources: SourcesMode): Promise<void> {
  const tenant = forPrincipal(env.DB, { orgId: TEST_ORG_ID, userId: "usr_1", role: "owner" });
  await env.DB.batch(
    [
      "usage_daily",
      "messages",
      "conversations",
      "chunks",
      "documents",
      "sources",
      "assistant_versions",
      "assistants",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  await tenant.assistants.create({
    id: "ast_t",
    name: "Docs",
    publicKey: "pk_timing",
    allowedOrigins: ["https://site.example"],
    createdAt: 1000,
  });
  const config = defaultVersionConfig();
  config.behaviour.sources = sources;
  const draft = await tenant.versions.createDraft({
    id: "ver_t1",
    assistantId: "ast_t",
    config,
    createdAt: 1000,
  });
  await tenant.versions.publishDraft("ast_t", draft.id, "ver_t2", 2000);
  await tenant.sources.create({
    id: "src_t",
    assistantId: "ast_t",
    kind: "push",
    label: "CLI",
    settings: {},
    createdAt: 1000,
  });
  await tenant.documents.upsert({
    id: "doc_t",
    sourceId: "src_t",
    externalId: "docs/reset",
    url: "https://site.example/docs/reset",
    title: "Reset Password",
    contentHash: "hash_t",
    updatedAt: 1000,
  });
  await tenant.documents.replaceChunks("doc_t", [
    { id: "chk_t", ordinal: 0, text: "Click Forgot Password to reset.", headingPath: "Reset" },
  ]);
}

async function timedAnswer(
  sources: SourcesMode,
  stopReason: "end_turn" | "max_tokens" = "end_turn",
): Promise<Timing> {
  await seed(sources);
  const embedder = fakeEmbedder();
  const retriever = memoryRetriever();
  const {
    vectors: [vec],
  } = await embedder.embed([QUESTION], async () => {});
  await retriever.upsert([
    { chunkId: "chk_t", vector: vec ?? [], orgId: TEST_ORG_ID, assistantId: "ast_t" },
  ]);
  const app = createApp(fakeSeams(), {
    chat: { embedder, retriever, fetch: pacedUpstream(stopReason), reviewer: null },
  });
  const ctx = createExecutionContext();
  const started = Date.now();
  const res = await app.fetch(
    new Request("https://engine.example/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://site.example" },
      body: JSON.stringify({
        protocol: CHAT_PROTOCOL_VERSION,
        assistant: "pk_timing",
        visitorId: "vis_t",
        message: QUESTION,
      }),
    }),
    { ...env, SOLV_LLM_PROVIDER: "anthropic", SOLV_LLM_TIER: "fast" },
    ctx,
  );
  expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const times: number[] = [];
  let tokenReads = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    let tokensHere = 0;
    for (const block of blocks) {
      if (!block.startsWith("event: token")) continue;
      const data = block.slice(block.indexOf("data:") + 5).trim();
      text += (JSON.parse(data) as { text: string }).text;
      times.push(Date.now() - started);
      tokensHere++;
    }
    if (tokensHere > 0) tokenReads++;
  }
  await waitOnExecutionContext(ctx);
  return {
    firstTokenMs: times[0] ?? -1,
    lastTokenMs: times[times.length - 1] ?? -1,
    tokenReads,
    tokenEvents: times.length,
    text,
  };
}

/** Upstream: thinking, then the deltas 30 ms apart; 14 gaps between them. */
const UPSTREAM_SPREAD_MS = (DELTAS.length - 1) * DELTA_MS;

describe("issue #135: the engine passes text on as the model writes it", () => {
  for (const sources of SOURCES_MODES) {
    it(`sources ${sources}: first text right after the thinking, then spread as written`, async () => {
      const t = await timedAnswer(sources);
      // For the pull request: the numbers measured here.
      console.info(`stream timing, sources ${sources}`, JSON.stringify(t));
      // Nothing visible while the model thinks; the first text follows its
      // first delta, not the end of the answer.
      expect(t.firstTokenMs).toBeGreaterThanOrEqual(THINK_MS);
      expect(t.firstTokenMs).toBeLessThan(THINK_MS + 3 * DELTA_MS + 100);
      // Arrival is spread over most of the time the model took to write it,
      // in many separate reads: nothing gathers the deltas into one piece.
      expect(t.lastTokenMs - t.firstTokenMs).toBeGreaterThanOrEqual(UPSTREAM_SPREAD_MS * 0.7);
      expect(t.tokenReads).toBeGreaterThanOrEqual(DELTAS.length - 3);
      if (sources === "numbered") {
        // Numbered passes the stream on untouched.
        expect(t.tokenEvents).toBe(DELTAS.length);
        expect(t.text).toBe(DELTAS.join(""));
      } else {
        // The markers go, the code stays.
        expect(t.text).not.toMatch(/\[\d\]/);
        expect(t.text).toContain("solv reset --email you@example.com");
      }
      if (sources === "none") {
        expect(t.text).toContain("[Settings](https://site.example/settings)");
      }
    }, 30_000);
  }

  it("an answer cut at the output limit still streams, with the closing line at the end", async () => {
    const t = await timedAnswer("numbered", "max_tokens");
    expect(t.firstTokenMs).toBeLessThan(THINK_MS + 3 * DELTA_MS + 100);
    expect(t.lastTokenMs - t.firstTokenMs).toBeGreaterThanOrEqual(UPSTREAM_SPREAD_MS * 0.7);
    expect(t.text.startsWith(DELTAS.join(""))).toBe(true);
    expect(t.text.endsWith("That answer was cut short. Ask me to continue.")).toBe(true);
  }, 30_000);
});
