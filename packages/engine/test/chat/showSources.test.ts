import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  CHAT_PROTOCOL_VERSION,
  type ChatEvent,
  defaultVersionConfig,
  type PageAction,
  parseChatEventLine,
  serializeChatEvent,
  type VersionConfig,
} from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { runAnswerTests } from "../../src/admin/answerTests.js";
import { getConversation } from "../../src/admin/conversations.js";
import { createApp } from "../../src/app.js";
import { SAFETY_FRAME, SAFETY_FRAME_NO_CITATIONS } from "../../src/chat/prompt.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { LlmChunk, LlmProvider, LlmRequest, ToolCall } from "../../src/providers/types.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

const QUESTION = "How do I reset my password?";
const PAGE = { url: "https://site.example/docs/reset", title: "Reset Password" };

/** A marker split between chunks, one whole, and one split after its number. */
const MARKED_CHUNKS = ["Click Forgot Password [", "1] to reset", " it [1", "]."];

const NAVIGATE_ACTION: PageAction = {
  name: "navigate",
  description: "Open another page on this site.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  confirm: false,
};

function parseSseBody(text: string): ChatEvent[] {
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

/** Streams `rounds` in order, one per model call, and keeps every request. */
function scriptedProvider(
  rounds: readonly { chunks: readonly string[]; calls?: readonly ToolCall[] }[],
  seen: LlmRequest[] = [],
): LlmProvider {
  let round = 0;
  return {
    name: "anthropic",
    model: ANTHROPIC_MODELS.balanced.id,
    async *stream(request: LlmRequest): AsyncIterable<LlmChunk> {
      seen.push(request);
      const step = rounds[Math.min(round++, rounds.length - 1)];
      for (const text of step?.chunks ?? []) yield { kind: "text", text };
      for (const call of step?.calls ?? []) yield { kind: "tool_call", call };
      yield {
        kind: "usage",
        tokensIn: 100,
        tokensOut: 20,
        stopReason: (step?.calls?.length ?? 0) > 0 ? "tools" : "end",
      };
    },
  };
}

function tokenText(events: readonly ChatEvent[]): string {
  return events.map((e) => (e.type === "token" ? e.text : "")).join("");
}

describe("chat: Show sources in answers", () => {
  const tenant = forPrincipal(env.DB, { orgId: TEST_ORG_ID, userId: "usr_1", role: "owner" });
  const embedder = fakeEmbedder();
  let retriever = memoryRetriever();

  beforeEach(async () => {
    retriever = memoryRetriever();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_daily"),
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM message_traces"),
      env.DB.prepare("DELETE FROM preview_traces"),
      env.DB.prepare("DELETE FROM message_documents"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM tests"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
    ]);
    await tenant.assistants.create({
      id: "ast_1",
      name: "Docs Bot",
      publicKey: "pk_src_1",
      allowedOrigins: ["https://site.example"],
      createdAt: 1000,
    });
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
      url: PAGE.url,
      title: PAGE.title,
      contentHash: "hash_1",
      updatedAt: 1000,
    });
    await tenant.documents.replaceChunks("doc_1", [
      { id: "chk_1", ordinal: 0, text: "Click Forgot Password to reset.", headingPath: "Reset" },
    ]);
    const [vec] = (await embedder.embed([QUESTION], async () => {})).vectors;
    await retriever.upsert([
      { chunkId: "chk_1", vector: vec ?? [], orgId: TEST_ORG_ID, assistantId: "ast_1" },
    ]);
  });

  /** Publishes `published`, then leaves `draft` (or the same) as the draft. */
  async function configure(published: VersionConfig, draft?: VersionConfig): Promise<void> {
    const first = await tenant.versions.createDraft({
      id: "ver_1",
      assistantId: "ast_1",
      config: published,
      createdAt: 1000,
    });
    await tenant.versions.publishDraft("ast_1", first.id, "ver_2", 2000);
    if (draft) await tenant.versions.updateDraft("ast_1", draft);
  }

  function withSources(showSources: boolean, builtins = false): VersionConfig {
    const config = defaultVersionConfig();
    config.behaviour.showSources = showSources;
    config.actions = { builtins, allowedOrigins: [] };
    return config;
  }

  async function post(
    app: ReturnType<typeof createApp>,
    body: Record<string, unknown>,
    path = "/v1/chat",
  ): Promise<string> {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`https://engine.example${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: path.startsWith("/api/admin/")
            ? "https://engine.example"
            : "https://site.example",
        },
        body: JSON.stringify({
          protocol: CHAT_PROTOCOL_VERSION,
          assistant: "pk_src_1",
          visitorId: "vis_1",
          ...body,
        }),
      }),
      env,
      ctx,
    );
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    return text;
  }

  it("off: strips markers split across chunks, sends no citations, stores clean text and keeps the owner's records", async () => {
    await configure(withSources(false));
    const seen: LlmRequest[] = [];
    const app = createApp(fakeSeams(), {
      chat: { embedder, retriever, provider: scriptedProvider([{ chunks: MARKED_CHUNKS }], seen) },
    });

    const body = await post(app, { message: QUESTION });
    const events = parseSseBody(body);

    expect(seen[0]?.system).toBe(SAFETY_FRAME_NO_CITATIONS);
    expect(events.some((e) => e.type === "citation")).toBe(false);
    expect(body).not.toContain("event: citation");
    expect(body).not.toContain("[1");
    expect(tokenText(events)).toBe("Click Forgot Password to reset it.");
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected done last");
    expect(Object.keys(done).sort()).toEqual(["conversationId", "messageId", "type"]);

    const [reply] = (await tenant.messages.list(done.conversationId)).filter(
      (m) => m.role === "assistant",
    );
    expect(reply?.content).toBe("Click Forgot Password to reset it.");
    expect(reply?.citationsShown).toBe(false);
    // The owner's record of the page the answer used is unchanged.
    expect(reply?.citations).toEqual([PAGE]);

    const used = await env.DB.prepare(
      "SELECT document_id FROM message_documents WHERE org_id = ?1 AND message_id = ?2",
    )
      .bind(TEST_ORG_ID, done.messageId)
      .all<{ document_id: string }>();
    expect(used.results.map((r) => r.document_id)).toEqual(["doc_1"]);
    const trace = await env.DB.prepare(
      "SELECT detail FROM message_traces WHERE org_id = ?1 AND message_id = ?2",
    )
      .bind(TEST_ORG_ID, done.messageId)
      .first<{ detail: string }>();
    expect(trace?.detail).toContain("chk_1");

    // Reports count the page as used, exactly as with sources shown.
    const range = { fromDay: "1970-01-01", toDay: "2999-12-31", fromMs: 0, toMs: 9e15 };
    expect(await tenant.reports.topSources("ast_1", range)).toEqual([
      expect.objectContaining({ documentId: "doc_1", count: 1 }),
    ]);
    expect((await tenant.reports.uncitedSources("ast_1", range)).total).toBe(0);

    // The admin's conversation view lists it, marked as not shown.
    const detail = await getConversation(tenant, done.conversationId);
    const turn = detail.turns.find((t) => t.role === "assistant");
    expect(turn).toMatchObject({ citations: [PAGE], citationsShown: false });
  });

  it("on: the public response is byte for byte what it was before the setting existed", async () => {
    // A version stored before the setting: no `showSources` key at all.
    const legacy = defaultVersionConfig() as unknown as { behaviour: Record<string, unknown> };
    delete legacy.behaviour.showSources;
    await env.DB.prepare(
      `INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at)
       VALUES ('ver_legacy', ?1, 'ast_1', 'published', ?2, 1000, 1000)`,
    )
      .bind(TEST_ORG_ID, JSON.stringify(legacy))
      .run();

    const seen: LlmRequest[] = [];
    const app = createApp(fakeSeams(), {
      chat: { embedder, retriever, provider: scriptedProvider([{ chunks: MARKED_CHUNKS }], seen) },
    });
    const body = await post(app, { message: QUESTION });
    const done = parseSseBody(body).at(-1);
    if (done?.type !== "done") throw new Error("expected done last");

    const expected = [
      ...MARKED_CHUNKS.map((text) => serializeChatEvent({ type: "token", text })),
      serializeChatEvent({ type: "citation", url: PAGE.url, title: PAGE.title }),
      serializeChatEvent({
        type: "done",
        messageId: done.messageId,
        conversationId: done.conversationId,
      }),
    ].join("");
    expect(body).toBe(expected);
    expect(seen[0]?.system).toBe(SAFETY_FRAME);

    const [reply] = (await tenant.messages.list(done.conversationId)).filter(
      (m) => m.role === "assistant",
    );
    expect(reply?.content).toBe(MARKED_CHUNKS.join(""));
    expect(reply?.citationsShown).toBe(true);

    // Turned on explicitly, the bytes are the same.
    await env.DB.prepare("DELETE FROM assistant_versions").run();
    await configure(withSources(true));
    const again = await post(app, { message: QUESTION });
    const done2 = parseSseBody(again).at(-1);
    if (done2?.type !== "done") throw new Error("expected done last");
    expect(again).toBe(
      expected
        .replace(done.messageId, done2.messageId)
        .replace(done.conversationId, done2.conversationId),
    );
  });

  it("Try it follows the draft and visitors follow the published version", async () => {
    // Published: off. Draft: on.
    await configure(withSources(false), withSources(true));
    const seen: LlmRequest[] = [];
    const app = createApp(fakeSeams(), {
      chat: {
        embedder,
        retriever,
        provider: scriptedProvider([{ chunks: MARKED_CHUNKS }], seen),
      },
    });

    const visitor = parseSseBody(await post(app, { message: QUESTION }));
    expect(visitor.some((e) => e.type === "citation")).toBe(false);
    expect(tokenText(visitor)).toBe("Click Forgot Password to reset it.");

    const preview = parseSseBody(
      await post(app, { message: QUESTION, target: "draft" }, "/api/admin/chat"),
    );
    expect(preview.filter((e) => e.type === "citation")).toEqual([
      { type: "citation", url: PAGE.url, title: PAGE.title },
    ]);
    expect(tokenText(preview)).toBe(MARKED_CHUNKS.join(""));
    expect(seen.map((r) => r.system)).toEqual([SAFETY_FRAME_NO_CITATIONS, SAFETY_FRAME]);

    // And the other way round: draft off, published on.
    await env.DB.prepare("DELETE FROM assistant_versions").run();
    await configure(withSources(true), withSources(false));
    const visitorOn = parseSseBody(await post(app, { message: QUESTION }));
    expect(visitorOn.some((e) => e.type === "citation")).toBe(true);
    const previewOff = parseSseBody(
      await post(app, { message: QUESTION, target: "draft" }, "/api/admin/chat"),
    );
    expect(previewOff.some((e) => e.type === "citation")).toBe(false);
    expect(tokenText(previewOff)).toBe("Click Forgot Password to reset it.");
  });

  it("off: a page action still pauses and resumes, and the completed reply stays clean", async () => {
    await configure(withSources(false, true));
    const navigate: ToolCall = {
      callId: "call_nav_1",
      name: "navigate",
      input: { path: "/docs/reset" },
    };
    const app = createApp(fakeSeams(), {
      chat: {
        embedder,
        retriever,
        model: ANTHROPIC_MODELS.balanced,
        provider: scriptedProvider([
          { chunks: ["I will open the reset page [", "1]. "], calls: [navigate] },
          { chunks: ["You are there now [1", "]. Click Forgot Password [1]."] },
        ]),
      },
    });

    const first = parseSseBody(
      await post(app, { message: QUESTION, pageActions: [NAVIGATE_ACTION] }),
    );
    expect(tokenText(first)).toBe("I will open the reset page. ");
    expect(first.filter((e) => e.type === "action")).toHaveLength(1);
    const done1 = first.at(-1);
    if (done1?.type !== "done") throw new Error("expected done last");
    expect(done1.awaitingActions).toEqual(["call_nav_1"]);

    const second = parseSseBody(
      await post(app, {
        conversationId: done1.conversationId,
        resumeMessageId: done1.messageId,
        actionResults: [{ callId: "call_nav_1", ok: true, result: "opened" }],
      }),
    );
    expect(second.some((e) => e.type === "citation")).toBe(false);
    expect(tokenText(second)).toBe("You are there now. Click Forgot Password.");

    const [reply] = (await tenant.messages.list(done1.conversationId)).filter(
      (m) => m.role === "assistant",
    );
    expect(reply?.content).toBe(
      "I will open the reset page. You are there now. Click Forgot Password.",
    );
    expect(reply?.citationsShown).toBe(false);
    expect(reply?.citations).toEqual([PAGE]);
  });

  it("off: a test run's cites check reads the pages the answer used", async () => {
    await configure(withSources(true), withSources(false));
    await tenant.tests.create({
      id: "tst_1",
      assistantId: "ast_1",
      question: QUESTION,
      expectation: { kind: "cites", url: PAGE.url },
      createdAt: 1000,
    });
    const run = await runAnswerTests(
      {
        orgId: TEST_ORG_ID,
        tenant,
        embedder,
        retriever,
        provider: scriptedProvider([{ chunks: MARKED_CHUNKS }]),
        usage: { record: async () => {} },
        limits: fakeSeams().limits,
      },
      "ast_1",
    );
    expect(run.results).toEqual([
      expect.objectContaining({
        outcome: "passed",
        reason: `Used ${PAGE.url}.`,
        excerpt: "Click Forgot Password to reset it.",
      }),
    ]);
  });
});
