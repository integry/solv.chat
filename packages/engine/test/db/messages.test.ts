import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { forPrincipal } from "../../src/db/tenant.js";

const ORG_ID = "org_00000000000000000000";

describe("db/messages", () => {
  const tenant = forPrincipal(env.DB, {
    orgId: ORG_ID,
    userId: "usr_1",
    role: "owner",
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM assistants"),
    ]);

    await tenant.assistants.create({
      id: "ast_1",
      name: "Docs",
      publicKey: "pk_1",
      allowedOrigins: ["https://example.com"],
      createdAt: 1000,
    });
    await tenant.conversations.create({
      id: "cnv_1",
      assistantId: "ast_1",
      visitorId: "vis_1",
      startedAt: 1000,
      pageUrl: "https://example.com/docs",
    });
  });

  it("maps every column to its camelCase field with parsed JSON and boolean answered", async () => {
    const created = await tenant.messages.create({
      id: "msg_1",
      conversationId: "cnv_1",
      role: "assistant",
      content: "Here is the answer.",
      citations: [{ url: "https://example.com/docs", title: "Docs" }],
      toolCalls: [{ name: "lookup", args: { id: "1" } }],
      tokensIn: 120,
      tokensOut: 45,
      costMicros: null,
      answered: true,
      createdAt: 2000,
      replyTo: "msg_0",
      firstTokenMs: 340,
      totalMs: 1250,
    });

    expect(created.answered).toBe(true);

    const fetched = await tenant.messages.get("msg_1");
    expect(fetched).toEqual({
      id: "msg_1",
      orgId: ORG_ID,
      conversationId: "cnv_1",
      role: "assistant",
      content: "Here is the answer.",
      citations: [{ url: "https://example.com/docs", title: "Docs" }],
      toolCalls: [{ name: "lookup", args: { id: "1" } }],
      tokensIn: 120,
      tokensOut: 45,
      costMicros: null,
      answered: true,
      createdAt: 2000,
      replyTo: "msg_0",
      firstTokenMs: 340,
      totalMs: 1250,
      outcome: null,
      outcomeConfidence: null,
      citationsShown: true,
    });
  });

  it("stores whether the visitor was shown a reply's citations, keeping them either way", async () => {
    const citations = [{ url: "https://example.com/docs", title: "Docs" }];
    const base = {
      conversationId: "cnv_1",
      role: "assistant" as const,
      content: "Here is the answer.",
      citations,
      toolCalls: null,
      tokensIn: 1,
      tokensOut: 1,
      answered: true,
      createdAt: 2000,
    };
    const hidden = await tenant.messages.create({ ...base, id: "msg_h", citationsShown: false });
    expect(hidden.citationsShown).toBe(false);
    await tenant.messages.create({ ...base, id: "msg_s" });
    expect(await tenant.messages.get("msg_h")).toMatchObject({ citations, citationsShown: false });
    expect(await tenant.messages.get("msg_s")).toMatchObject({ citations, citationsShown: true });
  });

  it("preserves null toolCalls and maps answered = 0 to false", async () => {
    await tenant.messages.create({
      id: "msg_2",
      conversationId: "cnv_1",
      role: "assistant",
      content: "I could not find an answer.",
      citations: [],
      toolCalls: null,
      tokensIn: 80,
      tokensOut: 12,
      answered: false,
      createdAt: 3000,
    });

    const fetched = await tenant.messages.get("msg_2");
    expect(fetched?.toolCalls).toBeNull();
    expect(fetched?.answered).toBe(false);

    const gaps = await tenant.messages.unanswered("ast_1");
    expect(gaps.map((m) => m.id)).toEqual(["msg_2"]);
  });

  it("yields an empty array when a JSON column is unparseable instead of throwing", async () => {
    await env.DB.prepare(
      `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at)
       VALUES (?1, ?2, ?3, 'assistant', 'bad json', '{not-json', 'also[bad', 10, 5, 1, 4000)`,
    )
      .bind("msg_bad", ORG_ID, "cnv_1")
      .run();

    const fetched = await tenant.messages.get("msg_bad");
    expect(fetched).not.toBeNull();
    expect(fetched?.citations).toEqual([]);
    expect(fetched?.toolCalls).toEqual([]);
    expect(fetched?.answered).toBe(true);
  });

  it("orders same-millisecond messages by insertion, and recent() returns the last N oldest first", async () => {
    // Ids chosen so that sorting by id would give the wrong order.
    const ids = ["msg_z", "msg_y", "msg_x", "msg_w"];
    for (const [i, id] of ids.entries()) {
      await tenant.messages.create({
        id,
        conversationId: "cnv_1",
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i}`,
        citations: [],
        toolCalls: null,
        tokensIn: 0,
        tokensOut: 0,
        answered: true,
        createdAt: 5000,
      });
    }

    expect((await tenant.messages.list("cnv_1")).map((m) => m.id)).toEqual(ids);
    expect((await tenant.messages.recent("cnv_1", 3)).map((m) => m.id)).toEqual(ids.slice(1));
  });
});
