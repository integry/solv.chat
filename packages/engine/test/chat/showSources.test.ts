import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  CHAT_PROTOCOL_VERSION,
  type ChatEvent,
  defaultVersionConfig,
  type PageAction,
  parseChatEventLine,
  type SourcesMode,
  serializeChatEvent,
  type VersionConfig,
} from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { runAnswerTests } from "../../src/admin/answerTests.js";
import { getConversation } from "../../src/admin/conversations.js";
import { createApp } from "../../src/app.js";
import { actionRunnerFor } from "../../src/chat/actionRunner.js";
import { answerMessage, answerWithActionResults } from "../../src/chat/answer.js";
import {
  SAFETY_FRAME,
  SAFETY_FRAME_LINKS,
  SAFETY_FRAME_NO_CITATIONS,
} from "../../src/chat/prompt.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { LlmChunk, LlmProvider, LlmRequest, ToolCall } from "../../src/providers/types.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
// The numbered answer's public response as it was before "Show sources in
// answers" had three values, kept as bytes so a change to it shows.
import numberedAnswer from "../fixtures/numbered-answer.json";
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

  function withSources(mode: SourcesMode, builtins = false, listSources = false): VersionConfig {
    const config = defaultVersionConfig();
    config.behaviour.sources = mode;
    config.behaviour.listSources = listSources;
    config.actions = { builtins, allowedOrigins: [] };
    return config;
  }

  /** Stores a published version's config as written, as an older engine left it. */
  async function storeRaw(config: unknown, id = "ver_legacy", state = "published"): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at)
       VALUES (?1, ?2, 'ast_1', ?3, ?4, 1000, ?5)`,
    )
      .bind(id, TEST_ORG_ID, state, JSON.stringify(config), state === "published" ? 1000 : null)
      .run();
  }

  /** A config as an engine before the three choices stored it. */
  function legacyConfig(showSources: boolean | undefined): unknown {
    const legacy = defaultVersionConfig() as unknown as { behaviour: Record<string, unknown> };
    delete legacy.behaviour.sources;
    delete legacy.behaviour.listSources;
    if (showSources !== undefined) legacy.behaviour.showSources = showSources;
    return legacy;
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

  it("none: strips markers split across chunks, sends no citations, stores clean text and keeps the owner's records", async () => {
    await configure(withSources("none"));
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

  it("numbered: the public response is byte for byte the stored fixture of today's", async () => {
    await configure(withSources("numbered"));
    const seen: LlmRequest[] = [];
    const app = createApp(fakeSeams(), {
      chat: { embedder, retriever, provider: scriptedProvider([{ chunks: MARKED_CHUNKS }], seen) },
    });
    const body = await post(app, { message: QUESTION });
    const done = parseSseBody(body).at(-1);
    if (done?.type !== "done") throw new Error("expected done last");

    const expected = numberedAnswer.body
      .replace("{{messageId}}", done.messageId)
      .replace("{{conversationId}}", done.conversationId);
    expect(body).toBe(expected);
    // The fixture is what the event serializer makes of today's events.
    expect(expected).toBe(
      [
        ...MARKED_CHUNKS.map((text) => serializeChatEvent({ type: "token", text })),
        serializeChatEvent({ type: "citation", url: PAGE.url, title: PAGE.title }),
        serializeChatEvent({
          type: "done",
          messageId: done.messageId,
          conversationId: done.conversationId,
        }),
      ].join(""),
    );
    expect(seen[0]?.system).toBe(SAFETY_FRAME);

    const [reply] = (await tenant.messages.list(done.conversationId)).filter(
      (m) => m.role === "assistant",
    );
    expect(reply?.content).toBe(MARKED_CHUNKS.join(""));
    expect(reply?.citationsShown).toBe(true);
  });

  it("migration: a version stored with sources on now links in the text, with no list", async () => {
    for (const stored of [legacyConfig(true), legacyConfig(undefined)]) {
      await env.DB.prepare("DELETE FROM assistant_versions").run();
      await storeRaw(stored);
      const seen: LlmRequest[] = [];
      const app = createApp(fakeSeams(), {
        chat: {
          embedder,
          retriever,
          provider: scriptedProvider([{ chunks: ["Use [the reset page][1] [1]."] }], seen),
        },
      });
      const events = parseSseBody(await post(app, { message: QUESTION }));
      expect(seen[0]?.system).toBe(SAFETY_FRAME_LINKS);
      expect(tokenText(events)).toBe(`Use [the reset page](${PAGE.url}).`);
      expect(events.some((e) => e.type === "citation")).toBe(false);
    }
  });

  it("migration: a version stored with sources off stays on none", async () => {
    await storeRaw(legacyConfig(false));
    const seen: LlmRequest[] = [];
    const app = createApp(fakeSeams(), {
      chat: { embedder, retriever, provider: scriptedProvider([{ chunks: MARKED_CHUNKS }], seen) },
    });
    const events = parseSseBody(await post(app, { message: QUESTION }));
    expect(seen[0]?.system).toBe(SAFETY_FRAME_NO_CITATIONS);
    expect(tokenText(events)).toBe("Click Forgot Password to reset it.");
    expect(events.some((e) => e.type === "citation")).toBe(false);
  });

  it("migration: the admin reads both stored states as the new choice, draft and published alike", async () => {
    await storeRaw(legacyConfig(true), "ver_pub", "published");
    await storeRaw(legacyConfig(false), "ver_draft", "draft");
    expect((await tenant.versions.published("ast_1"))?.config.behaviour).toMatchObject({
      sources: "links",
      listSources: false,
    });
    expect((await tenant.versions.draft("ast_1"))?.config.behaviour).toMatchObject({
      sources: "none",
      listSources: false,
    });
    // Saving another field of the draft writes the new shape and keeps the choice.
    const draft = await tenant.versions.draft("ast_1");
    if (!draft) throw new Error("expected a draft");
    expect(await tenant.versions.updateDraft("ast_1", draft.config, draft)).toBe(true);
    const row = await env.DB.prepare(
      "SELECT config FROM assistant_versions WHERE org_id = ?1 AND id = 'ver_draft'",
    )
      .bind(TEST_ORG_ID)
      .first<{ config: string }>();
    const saved = JSON.parse(row?.config ?? "{}") as { behaviour: Record<string, unknown> };
    expect(saved.behaviour.sources).toBe("none");
    expect("showSources" in saved.behaviour).toBe(false);
  });

  it("Try it follows the draft and visitors follow the published version", async () => {
    // Published: off. Draft: on.
    await configure(withSources("none"), withSources("numbered"));
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
    await configure(withSources("numbered"), withSources("none"));
    const visitorOn = parseSseBody(await post(app, { message: QUESTION }));
    expect(visitorOn.some((e) => e.type === "citation")).toBe(true);
    const previewOff = parseSseBody(
      await post(app, { message: QUESTION, target: "draft" }, "/api/admin/chat"),
    );
    expect(previewOff.some((e) => e.type === "citation")).toBe(false);
    expect(tokenText(previewOff)).toBe("Click Forgot Password to reset it.");
  });

  it("none: a page action still pauses and resumes, and the completed reply stays clean", async () => {
    await configure(withSources("none", true));
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

  it("none: a marker attached to a word or in a long unfinished group is taken out, the rest kept", async () => {
    await configure(withSources("none", true));
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
          {
            chunks: ["Answer [1, 2, 3, 4, 5, 6, 1, 2, 3", "]. Click Forgot Password[1]. "],
            calls: [navigate],
          },
          {
            chunks: [
              "Then sign in[1",
              ", 2, 3, 4, 5, 6, 1, 2, 3, 4",
              "]. Done[2]. Use `items[1]`.",
            ],
          },
        ]),
      },
    });

    const first = parseSseBody(
      await post(app, { message: QUESTION, pageActions: [NAVIGATE_ACTION] }),
    );
    expect(tokenText(first)).toBe("Answer. Click Forgot Password. ");
    const done1 = first.at(-1);
    if (done1?.type !== "done") throw new Error("expected done last");

    const second = parseSseBody(
      await post(app, {
        conversationId: done1.conversationId,
        resumeMessageId: done1.messageId,
        actionResults: [{ callId: "call_nav_1", ok: true, result: "opened" }],
      }),
    );
    expect(second.some((e) => e.type === "citation")).toBe(false);
    expect(tokenText(second)).toBe("Then sign in. Done. Use `items[1]`.");

    const [reply] = (await tenant.messages.list(done1.conversationId)).filter(
      (m) => m.role === "assistant",
    );
    expect(reply?.content).toBe(
      "Answer. Click Forgot Password. Then sign in. Done. Use `items[1]`.",
    );
  });

  it("none: markers in indented code stay, in the answer and in its continuation", async () => {
    await configure(withSources("none", true));
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
          {
            chunks: ["Example [1]:\n\n  ", "  items[", "1]\n\n"],
            calls: [navigate],
          },
          { chunks: ["    pair[2", "]\n\nDone [1]."] },
        ]),
      },
    });

    const first = parseSseBody(
      await post(app, { message: QUESTION, pageActions: [NAVIGATE_ACTION] }),
    );
    expect(tokenText(first)).toBe("Example:\n\n    items[1]\n\n");
    const done1 = first.at(-1);
    if (done1?.type !== "done") throw new Error("expected done last");

    const second = parseSseBody(
      await post(app, {
        conversationId: done1.conversationId,
        resumeMessageId: done1.messageId,
        actionResults: [{ callId: "call_nav_1", ok: true, result: "opened" }],
      }),
    );
    expect(tokenText(second)).toBe("    pair[2]\n\nDone.");

    const [reply] = (await tenant.messages.list(done1.conversationId)).filter(
      (m) => m.role === "assistant",
    );
    expect(reply?.content).toBe("Example:\n\n    items[1]\n\n    pair[2]\n\nDone.");
  });

  it("none: CRLF line endings close a fence and start indented code, in the answer and in its continuation", async () => {
    await configure(withSources("none", true));
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
          {
            // The break after the closing fence is split between its "\r" and "\n".
            chunks: ["```js\r\nitems[1]\r", "\n```\r", "\nDone [1].\r\n\r\n    x[2]\r\n"],
            calls: [navigate],
          },
          { chunks: ["```\r\npair[", "2]\r\n```\r", "\nAfter [1]."] },
        ]),
      },
    });

    const first = parseSseBody(
      await post(app, { message: QUESTION, pageActions: [NAVIGATE_ACTION] }),
    );
    expect(tokenText(first)).toBe("```js\r\nitems[1]\r\n```\r\nDone.\r\n\r\n    x[2]\r\n");
    const done1 = first.at(-1);
    if (done1?.type !== "done") throw new Error("expected done last");

    const second = parseSseBody(
      await post(app, {
        conversationId: done1.conversationId,
        resumeMessageId: done1.messageId,
        actionResults: [{ callId: "call_nav_1", ok: true, result: "opened" }],
      }),
    );
    expect(tokenText(second)).toBe("```\r\npair[2]\r\n```\r\nAfter.");

    const [reply] = (await tenant.messages.list(done1.conversationId)).filter(
      (m) => m.role === "assistant",
    );
    expect(reply?.content).toBe(
      "```js\r\nitems[1]\r\n```\r\nDone.\r\n\r\n    x[2]\r\n```\r\npair[2]\r\n```\r\nAfter.",
    );
  });

  it("none: markers in fences inside list items and quotes stay, in the answer and in its continuation", async () => {
    await configure(withSources("none", true));
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
          {
            chunks: ["1. Example [1]:\n\n    ~~", "~js\n    items[", "1]\n"],
            calls: [navigate],
          },
          { chunks: ["    pair[2", "]\n    ~~~\n\n> ~~~\n> row[", "3]\n> ~~~\n\nDone [1]."] },
        ]),
      },
    });

    const first = parseSseBody(
      await post(app, { message: QUESTION, pageActions: [NAVIGATE_ACTION] }),
    );
    expect(tokenText(first)).toBe("1. Example:\n\n    ~~~js\n    items[1]\n");
    const done1 = first.at(-1);
    if (done1?.type !== "done") throw new Error("expected done last");

    const second = parseSseBody(
      await post(app, {
        conversationId: done1.conversationId,
        resumeMessageId: done1.messageId,
        actionResults: [{ callId: "call_nav_1", ok: true, result: "opened" }],
      }),
    );
    expect(tokenText(second)).toBe("    pair[2]\n    ~~~\n\n> ~~~\n> row[3]\n> ~~~\n\nDone.");

    const [reply] = (await tenant.messages.list(done1.conversationId)).filter(
      (m) => m.role === "assistant",
    );
    expect(reply?.content).toBe(
      "1. Example:\n\n    ~~~js\n    items[1]\n    pair[2]\n    ~~~\n\n> ~~~\n> row[3]\n> ~~~\n\nDone.",
    );
  });

  it("none: markers in a link's destination stay, in the answer and in its continuation", async () => {
    await configure(withSources("none", true));
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
          {
            chunks: ["Get [Download](https://example.com/files/report[", "1].pdf) [1]."],
            calls: [navigate],
          },
          {
            chunks: [
              " Or ![Chart](https://example.com/chart[2",
              "].png) and <https://example.com/files/report[3].pdf> [2].",
            ],
          },
        ]),
      },
    });

    const first = parseSseBody(
      await post(app, { message: QUESTION, pageActions: [NAVIGATE_ACTION] }),
    );
    expect(tokenText(first)).toBe("Get [Download](https://example.com/files/report[1].pdf).");
    const done1 = first.at(-1);
    if (done1?.type !== "done") throw new Error("expected done last");

    const second = parseSseBody(
      await post(app, {
        conversationId: done1.conversationId,
        resumeMessageId: done1.messageId,
        actionResults: [{ callId: "call_nav_1", ok: true, result: "opened" }],
      }),
    );
    expect(tokenText(second)).toBe(
      " Or ![Chart](https://example.com/chart[2].png) and <https://example.com/files/report[3].pdf>.",
    );

    const [reply] = (await tenant.messages.list(done1.conversationId)).filter(
      (m) => m.role === "assistant",
    );
    expect(reply?.content).toBe(
      "Get [Download](https://example.com/files/report[1].pdf). Or ![Chart](https://example.com/chart[2].png) and <https://example.com/files/report[3].pdf>.",
    );
  });

  it("none: a test run's cites check reads the pages the answer used", async () => {
    await configure(withSources("numbered"), withSources("none"));
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
  describe("links in the text", () => {
    const BILLING = { url: "https://site.example/docs/billing", title: "Billing" };
    const ENTRY_URL = "https://engine.example/admin/assistants/ast_1/sources/src_entry";

    /** A second page (whose text names the status page) and a written answer, both found. */
    async function addSources(): Promise<void> {
      await tenant.sources.create({
        id: "src_entry",
        assistantId: "ast_1",
        kind: "entry",
        label: "Written answers",
        settings: {},
        createdAt: 1000,
      });
      await tenant.documents.upsert({
        id: "doc_2",
        sourceId: "src_1",
        externalId: "docs/billing",
        url: BILLING.url,
        title: BILLING.title,
        contentHash: "hash_2",
        updatedAt: 1000,
      });
      await tenant.documents.replaceChunks("doc_2", [
        {
          id: "chk_2",
          ordinal: 0,
          text: "Change your card under Billing. Outages: https://status.example.net/.",
          headingPath: "Billing",
        },
      ]);
      await tenant.documents.upsert({
        id: "doc_3",
        sourceId: "src_entry",
        externalId: "entry/2fa",
        url: ENTRY_URL,
        title: "Do you support two-factor sign-in?",
        contentHash: "hash_3",
        updatedAt: 1000,
      });
      await tenant.documents.replaceChunks("doc_3", [
        { id: "chk_3", ordinal: 0, text: "Yes, under Security.", headingPath: "" },
      ]);
      const [vec] = (await embedder.embed([QUESTION], async () => {})).vectors;
      await retriever.upsert(
        ["chk_2", "chk_3"].map((chunkId) => ({
          chunkId,
          vector: vec ?? [],
          orgId: TEST_ORG_ID,
          assistantId: "ast_1",
        })),
      );
    }

    /** The number the prompt gave the source titled `title`. */
    function numberOf(request: LlmRequest, title: string): number {
      const last = request.messages.at(-1);
      const content = last && "content" in last ? String(last.content) : "";
      const match = new RegExp(
        `<<<source (\\d+)\\ntitle: ${title.replace(/[?]/gu, "\\?")}\\n`,
        "u",
      ).exec(content);
      if (match === null) throw new Error(`no source titled ${title}`);
      return Number(match[1]);
    }

    /**
     * Streams what `write` makes of the prompt's numbering, one character at a
     * time so every link is split across chunks, ending with `stop`.
     */
    function numberingProvider(
      write: (n: (title: string) => number) => string,
      seen: LlmRequest[] = [],
      stop: "end" | "length" = "end",
    ): LlmProvider {
      return {
        name: "anthropic",
        model: ANTHROPIC_MODELS.balanced.id,
        async *stream(request: LlmRequest): AsyncIterable<LlmChunk> {
          seen.push(request);
          for (const text of write((title) => numberOf(request, title))) {
            yield { kind: "text", text };
          }
          yield { kind: "usage", tokensIn: 100, tokensOut: 20, stopReason: stop };
        },
      };
    }

    it("links the words to the right pages, with no markers and no list, and keeps the owner's records", async () => {
      await addSources();
      await configure(withSources("links"));
      const seen: LlmRequest[] = [];
      const app = createApp(fakeSeams(), {
        chat: {
          embedder,
          retriever,
          provider: numberingProvider(
            (n) =>
              `Use [the reset page][${n(PAGE.title)}] [${n(PAGE.title)}]. ` +
              `Then update [billing][${n(BILLING.title)}] or check [the status page](https://status.example.net/). ` +
              `[Two-factor sign-in][${n("Do you support two-factor sign-in?")}] is under Security [${n("Do you support two-factor sign-in?")}].`,
            seen,
          ),
        },
      });

      const body = await post(app, { message: QUESTION });
      const events = parseSseBody(body);
      expect(seen[0]?.system).toBe(SAFETY_FRAME_LINKS);
      const expected =
        `Use [the reset page](${PAGE.url}). Then update [billing](${BILLING.url}) or check ` +
        "[the status page](https://status.example.net/). Two-factor sign-in is under Security.";
      expect(tokenText(events)).toBe(expected);
      // Every link arrives in one token, never half-written.
      for (const event of events) {
        if (event.type !== "token") continue;
        const open = event.text.lastIndexOf("[");
        if (open !== -1) expect(event.text.slice(open)).toMatch(/^\[[^\]]*\]\([^)]*\)/u);
      }
      expect(events.some((e) => e.type === "citation")).toBe(false);
      expect(body).not.toContain("event: citation");
      const done = events.at(-1);
      if (done?.type !== "done") throw new Error("expected done last");

      const [reply] = (await tenant.messages.list(done.conversationId)).filter(
        (m) => m.role === "assistant",
      );
      expect(reply?.content).toBe(expected);
      // No list was shown; what the answer used is recorded as before.
      expect(reply?.citationsShown).toBe(false);
      expect(reply?.citations).toEqual(expect.arrayContaining([PAGE, BILLING]));
      const used = await env.DB.prepare(
        "SELECT document_id FROM message_documents WHERE org_id = ?1 AND message_id = ?2",
      )
        .bind(TEST_ORG_ID, done.messageId)
        .all<{ document_id: string }>();
      expect(used.results.map((r) => r.document_id).sort()).toEqual(["doc_1", "doc_2", "doc_3"]);
      const detail = await getConversation(tenant, done.conversationId);
      const turn = detail.turns.find((t) => t.role === "assistant");
      expect(turn).toMatchObject({ citationsShown: false });
    });

    it("reduces a fabricated or off-site link to its text before it is sent or stored", async () => {
      await configure(withSources("links"));
      const app = createApp(fakeSeams(), {
        chat: {
          embedder,
          retriever,
          provider: numberingProvider(
            () =>
              "Read [the API guide](https://site.example/docs/api), ask [our partner](https://evil.example/x) " +
              `or [the reset guide](${PAGE.url}#steps).`,
          ),
        },
      });
      const body = await post(app, { message: QUESTION });
      const events = parseSseBody(body);
      const expected = `Read the API guide, ask our partner or [the reset guide](${PAGE.url}#steps).`;
      expect(tokenText(events)).toBe(expected);
      expect(body).not.toContain("evil.example");
      expect(body).not.toContain("/docs/api");
      const done = events.at(-1);
      if (done?.type !== "done") throw new Error("expected done last");
      const [reply] = (await tenant.messages.list(done.conversationId)).filter(
        (m) => m.role === "assistant",
      );
      expect(reply?.content).toBe(expected);
    });

    it("with List sources under answers, also sends the list", async () => {
      await configure(withSources("links", false, true));
      const app = createApp(fakeSeams(), {
        chat: {
          embedder,
          retriever,
          provider: numberingProvider((n) => `Use [the reset page][${n(PAGE.title)}].`),
        },
      });
      const events = parseSseBody(await post(app, { message: QUESTION }));
      expect(tokenText(events)).toBe(`Use [the reset page](${PAGE.url}).`);
      expect(events.filter((e) => e.type === "citation")).toEqual([
        { type: "citation", url: PAGE.url, title: PAGE.title },
      ]);
      const done = events.at(-1);
      if (done?.type !== "done") throw new Error("expected done last");
      const [reply] = (await tenant.messages.list(done.conversationId)).filter(
        (m) => m.role === "assistant",
      );
      expect(reply?.citationsShown).toBe(true);
    });

    it("cut short in the middle of a link leaves no open link", async () => {
      await configure(withSources("links"));
      const app = createApp(fakeSeams(), {
        chat: {
          embedder,
          retriever,
          provider: numberingProvider(
            () => `Open [the reset page](${PAGE.url.slice(0, 18)}`,
            [],
            "length",
          ),
        },
      });
      const events = parseSseBody(await post(app, { message: QUESTION }));
      const text = tokenText(events);
      expect(text).toBe("Open the reset page\n\nThat answer was cut short. Ask me to continue.");
      expect(text).not.toContain("[");
    });

    it("Try it follows the draft and visitors follow the published version", async () => {
      await configure(withSources("links"), withSources("numbered"));
      const seen: LlmRequest[] = [];
      const app = createApp(fakeSeams(), {
        chat: {
          embedder,
          retriever,
          provider: numberingProvider((n) => `Use [the reset page][${n(PAGE.title)}] [1].`, seen),
        },
      });
      const visitor = parseSseBody(await post(app, { message: QUESTION }));
      expect(tokenText(visitor)).toBe(`Use [the reset page](${PAGE.url}).`);
      expect(visitor.some((e) => e.type === "citation")).toBe(false);
      const preview = parseSseBody(
        await post(app, { message: QUESTION, target: "draft" }, "/api/admin/chat"),
      );
      // Numbered passes the model's text on as it is, and lists the page.
      expect(tokenText(preview)).toBe("Use [the reset page][1] [1].");
      expect(preview.some((e) => e.type === "citation")).toBe(true);
      expect(seen.map((r) => r.system)).toEqual([SAFETY_FRAME_LINKS, SAFETY_FRAME]);
    });

    it("a page action pauses and resumes, and a link before the pause counts for its paragraph", async () => {
      await configure(withSources("links", true));
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
            { chunks: ["I will open [the reset ", "page][1]. "], calls: [navigate] },
            { chunks: ["You are on [the reset page][1", "] now.\n\nSee [the reset page][1]."] },
          ]),
        },
      });
      const first = parseSseBody(
        await post(app, { message: QUESTION, pageActions: [NAVIGATE_ACTION] }),
      );
      expect(tokenText(first)).toBe(`I will open [the reset page](${PAGE.url}). `);
      const done1 = first.at(-1);
      if (done1?.type !== "done") throw new Error("expected done last");
      const second = parseSseBody(
        await post(app, {
          conversationId: done1.conversationId,
          resumeMessageId: done1.messageId,
          actionResults: [{ callId: "call_nav_1", ok: true, result: "opened" }],
        }),
      );
      expect(tokenText(second)).toBe(
        `You are on the reset page now.\n\nSee [the reset page](${PAGE.url}).`,
      );
      const [reply] = (await tenant.messages.list(done1.conversationId)).filter(
        (m) => m.role === "assistant",
      );
      expect(reply?.content).toBe(
        `I will open [the reset page](${PAGE.url}). You are on the reset page now.\n\nSee [the reset page](${PAGE.url}).`,
      );
    });

    it("a test run's cites check passes on a link, and on a page used but not linked", async () => {
      await addSources();
      await configure(withSources("numbered"), withSources("links"));
      for (const [id, url] of [
        ["tst_1", PAGE.url],
        ["tst_2", BILLING.url],
        ["tst_3", "https://site.example/docs/other"],
      ] as const) {
        await tenant.tests.create({
          id,
          assistantId: "ast_1",
          question: QUESTION,
          expectation: { kind: "cites", url },
          createdAt: id === "tst_1" ? 1000 : id === "tst_2" ? 1001 : 1002,
        });
      }
      const run = await runAnswerTests(
        {
          orgId: TEST_ORG_ID,
          tenant,
          embedder,
          retriever,
          provider: numberingProvider((n) => `Use [the reset page][${n(PAGE.title)}].`),
          usage: { record: async () => {} },
          limits: fakeSeams().limits,
        },
        "ast_1",
      );
      const byTest = Object.fromEntries(run.results.map((r) => [r.testId, r]));
      expect(byTest.tst_1).toMatchObject({ outcome: "passed", reason: `Linked to ${PAGE.url}.` });
      expect(byTest.tst_2).toMatchObject({ outcome: "passed", reason: `Used ${BILLING.url}.` });
      expect(byTest.tst_3).toMatchObject({ outcome: "failed" });
    });

    it.each([false, true])(
      "a test run's cites check passes on a link to a page's section (list sources: %s)",
      async (listSources) => {
        await addSources();
        await configure(withSources("numbered"), withSources("links", false, listSources));
        const SECTION = `${PAGE.url}#steps`;
        for (const [id, url] of [
          ["tst_1", SECTION],
          ["tst_2", `${PAGE.url}#other`],
        ] as const) {
          await tenant.tests.create({
            id,
            assistantId: "ast_1",
            question: QUESTION,
            expectation: { kind: "cites", url },
            createdAt: id === "tst_1" ? 1000 : 1001,
          });
        }
        const run = await runAnswerTests(
          {
            orgId: TEST_ORG_ID,
            tenant,
            embedder,
            retriever,
            provider: numberingProvider(() => `Follow [the reset steps](${SECTION}).`),
            usage: { record: async () => {} },
            limits: fakeSeams().limits,
          },
          "ast_1",
        );
        const byTest = Object.fromEntries(run.results.map((r) => [r.testId, r]));
        expect(byTest.tst_1).toMatchObject({ outcome: "passed", reason: `Linked to ${SECTION}.` });
        // Another section of the same page is not the link the answer gave.
        expect(byTest.tst_2).toMatchObject({ outcome: "failed" });
      },
    );

    it.each(["numbered", "none"] as const)(
      "a test run's cites check passes on a link to a page's section with sources set to %s",
      async (mode) => {
        await addSources();
        // Neither rewrites links: the visitor gets the one the model wrote.
        await configure(withSources("links"), withSources(mode));
        const SECTION = `${PAGE.url}#steps`;
        for (const [id, url] of [
          ["tst_1", SECTION],
          ["tst_2", `${PAGE.url}#other`],
        ] as const) {
          await tenant.tests.create({
            id,
            assistantId: "ast_1",
            question: QUESTION,
            expectation: { kind: "cites", url },
            createdAt: id === "tst_1" ? 1000 : 1001,
          });
        }
        const run = await runAnswerTests(
          {
            orgId: TEST_ORG_ID,
            tenant,
            embedder,
            retriever,
            provider: numberingProvider(() => `Follow [the reset steps](${SECTION}) [1].`),
            usage: { record: async () => {} },
            limits: fakeSeams().limits,
          },
          "ast_1",
        );
        const byTest = Object.fromEntries(run.results.map((r) => [r.testId, r]));
        expect(byTest.tst_1).toMatchObject({ outcome: "passed", reason: `Linked to ${SECTION}.` });
        expect(byTest.tst_2).toMatchObject({ outcome: "failed" });
      },
    );

    it.each(["links", "numbered", "none"] as const)(
      "a test run's cites check does not pass on an image (sources set to %s)",
      async (mode) => {
        await addSources();
        await configure(withSources(mode === "links" ? "numbered" : "links"), withSources(mode));
        // A link may go to the status page (the billing page's text names
        // it), but no page found is the status page.
        const STATUS = "https://status.example.net/";
        for (const [id, url] of [
          ["tst_1", STATUS],
          ["tst_2", BILLING.url],
        ] as const) {
          await tenant.tests.create({
            id,
            assistantId: "ast_1",
            question: QUESTION,
            expectation: { kind: "cites", url },
            createdAt: id === "tst_1" ? 1000 : 1001,
          });
        }
        const run = await runAnswerTests(
          {
            orgId: TEST_ORG_ID,
            tenant,
            embedder,
            retriever,
            provider: numberingProvider(
              () => `Check ![the status page](${STATUS}), or see [billing](${BILLING.url}).`,
            ),
            usage: { record: async () => {} },
            limits: fakeSeams().limits,
          },
          "ast_1",
        );
        const byTest = Object.fromEntries(run.results.map((r) => [r.testId, r]));
        // Kept as the model wrote it, the image is shown as text, not a link.
        expect(byTest.tst_1?.excerpt).toContain(`![the status page](${STATUS})`);
        expect(byTest.tst_1).toMatchObject({ outcome: "failed" });
        expect(byTest.tst_1?.reason).toMatch(
          /^Did not (cite|use) https:\/\/status\.example\.net\/\./u,
        );
        // The link beside it still counts.
        expect(byTest.tst_2).toMatchObject({
          outcome: "passed",
          reason: `Linked to ${BILLING.url}.`,
        });
      },
    );

    it.each(["numbered", "none"] as const)(
      "a resumed reply with sources set to %s reports its links from before and after the pause",
      async (mode) => {
        await addSources();
        const behaviour = withSources(mode, true).behaviour;
        const STEPS = `${PAGE.url}#steps`;
        const runner = actionRunnerFor([NAVIGATE_ACTION], { builtinsEnabled: true });
        if (runner === null) throw new Error("expected the navigate action");
        const navigate: ToolCall = {
          callId: "call_nav_1",
          name: "navigate",
          input: { path: "/docs/reset" },
        };
        const deps = {
          tenant,
          embedder,
          retriever,
          model: ANTHROPIC_MODELS.balanced,
          usage: { record: async () => {} },
          runners: [runner],
          provider: scriptedProvider([
            { chunks: [`See [the steps](${STEPS}). `], calls: [navigate] },
            { chunks: [`Then [billing](${BILLING.url}) [1].`] },
          ]),
        };
        const first: ChatEvent[] = [];
        for await (const event of answerMessage(deps, {
          orgId: TEST_ORG_ID,
          assistantId: "ast_1",
          visitorId: "vis_1",
          message: QUESTION,
          behaviour,
          pageActions: [NAVIGATE_ACTION],
        })) {
          first.push(event);
        }
        const done = first.at(-1);
        if (done?.type !== "done") throw new Error("expected done last");
        expect(done.awaitingActions).toEqual(["call_nav_1"]);

        let linked: readonly string[] = [];
        const second: ChatEvent[] = [];
        for await (const event of answerWithActionResults(
          { ...deps, onCitable: (_citations, links) => (linked = links) },
          {
            orgId: TEST_ORG_ID,
            assistantId: "ast_1",
            visitorId: "vis_1",
            conversationId: done.conversationId,
            resumeMessageId: done.messageId,
            actionResults: [{ callId: "call_nav_1", ok: true, result: "opened" }],
            behaviour,
            pageActions: [NAVIGATE_ACTION],
          },
        )) {
          second.push(event);
        }
        // The text is sent as the model wrote it (none only takes the marker out).
        expect(tokenText(second)).toBe(
          mode === "numbered"
            ? `Then [billing](${BILLING.url}) [1].`
            : `Then [billing](${BILLING.url}).`,
        );
        expect(linked).toEqual([STEPS, BILLING.url]);
      },
    );
  });
});
