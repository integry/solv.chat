import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeQuestionText } from "../../src/db/messages.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

const ORG_A = TEST_ORG_ID;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";

function appForOrg(orgId: string) {
  return createTestApp({
    auth: {
      async authenticate() {
        return { orgId, userId: "owner", role: "owner" };
      },
      async login() {
        return Response.json({ ok: true });
      },
      async logout() {
        return Response.json({ ok: true });
      },
    },
  });
}

async function call(app: ReturnType<typeof createTestApp>, path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`https://example.com${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function seedAssistant(orgId: string, name = "Docs Bot"): Promise<string> {
  const id = newId("ast");
  await env.DB.prepare(
    `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at)
     VALUES (?1, ?2, ?3, ?4, '[]', ?5)`,
  )
    .bind(id, orgId, name, `pk_${newId("ast").slice(4)}`, Date.now())
    .run();
  return id;
}

async function seedConversation(
  orgId: string,
  assistantId: string,
  startedAt: number,
  pageUrl = "https://site.example.com/docs",
): Promise<string> {
  const id = newId("cnv");
  await env.DB.prepare(
    `INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(id, orgId, assistantId, "vis_1", startedAt, pageUrl)
    .run();
  return id;
}

const lastQuestion = new Map<string, string>();

async function seedMessage(args: {
  orgId: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  answered?: boolean;
  citations?: Array<{ url: string; title: string }>;
  /** For a reply; defaults to the last question seeded in the conversation. */
  replyTo?: string;
}): Promise<string> {
  const id = newId("msg");
  const replyTo =
    args.role === "assistant"
      ? (args.replyTo ?? lastQuestion.get(args.conversationId) ?? null)
      : null;
  if (args.role === "user") lastQuestion.set(args.conversationId, id);
  await env.DB.prepare(
    `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at, reply_to, question_key)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 10, 5, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id,
      args.orgId,
      args.conversationId,
      args.role,
      args.content,
      JSON.stringify(args.citations ?? []),
      args.answered === false ? 0 : 1,
      args.createdAt,
      replyTo,
      args.role === "user" ? normalizeQuestionText(args.content) : null,
    )
    .run();
  return id;
}

describe("admin conversations API", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM gap_answers"),
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  it("lists conversations newest-first and paged with first question, turn count, and unanswered flag", async () => {
    const astA = await seedAssistant(ORG_A);
    const c1 = await seedConversation(ORG_A, astA, 1000);
    await seedMessage({
      orgId: ORG_A,
      conversationId: c1,
      role: "user",
      content: "Oldest question?",
      createdAt: 1001,
    });
    await seedMessage({
      orgId: ORG_A,
      conversationId: c1,
      role: "assistant",
      content: "Oldest answer.",
      createdAt: 1002,
      answered: true,
    });

    const c2 = await seedConversation(ORG_A, astA, 2000);
    await seedMessage({
      orgId: ORG_A,
      conversationId: c2,
      role: "user",
      content: "Middle question?",
      createdAt: 2001,
    });
    await seedMessage({
      orgId: ORG_A,
      conversationId: c2,
      role: "assistant",
      content: "Sorry, no.",
      createdAt: 2002,
      answered: false,
    });

    const c3 = await seedConversation(ORG_A, astA, 3000);
    await seedMessage({
      orgId: ORG_A,
      conversationId: c3,
      role: "user",
      content: "Newest question?",
      createdAt: 3001,
    });
    await seedMessage({
      orgId: ORG_A,
      conversationId: c3,
      role: "assistant",
      content: "Newest answer.",
      createdAt: 3002,
      answered: true,
    });

    const app = appForOrg(ORG_A);

    const page1Res = await call(
      app,
      `/api/admin/assistants/${astA}/conversations?limit=2&offset=0`,
    );
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      conversations: Array<{
        id: string;
        firstQuestion: string | null;
        turnCount: number;
        hasUnanswered: boolean;
      }>;
      total: number;
      limit: number;
      offset: number;
    };
    expect(page1.total).toBe(3);
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);
    expect(page1.conversations.map((c) => c.id)).toEqual([c3, c2]);
    expect(page1.conversations[0]).toMatchObject({
      id: c3,
      firstQuestion: "Newest question?",
      turnCount: 2,
      hasUnanswered: false,
    });
    expect(page1.conversations[1]).toMatchObject({
      id: c2,
      firstQuestion: "Middle question?",
      turnCount: 2,
      hasUnanswered: true,
    });

    const page2Res = await call(
      app,
      `/api/admin/assistants/${astA}/conversations?limit=2&offset=2`,
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as {
      conversations: Array<{ id: string }>;
      total: number;
    };
    expect(page2.conversations.map((c) => c.id)).toEqual([c1]);
  });

  it("returns 404 when listing conversations for another org's assistant or reading another org's conversation", async () => {
    const astB = await seedAssistant(ORG_B);
    const convB = await seedConversation(ORG_B, astB, 1000);
    await seedMessage({
      orgId: ORG_B,
      conversationId: convB,
      role: "user",
      content: "Secret?",
      createdAt: 1001,
    });

    const appA = appForOrg(ORG_A);
    const listRes = await call(appA, `/api/admin/assistants/${astB}/conversations`);
    expect(listRes.status).toBe(404);

    const detailRes = await call(appA, `/api/admin/conversations/${convB}`);
    expect(detailRes.status).toBe(404);
  });

  it("returns turns with citations and feedback for a conversation", async () => {
    const astA = await seedAssistant(ORG_A);
    const conv = await seedConversation(ORG_A, astA, 1000, "https://docs.example.com/start");
    const qId = await seedMessage({
      orgId: ORG_A,
      conversationId: conv,
      role: "user",
      content: "How do I start?",
      createdAt: 1001,
    });
    const aId = await seedMessage({
      orgId: ORG_A,
      conversationId: conv,
      role: "assistant",
      content: "Follow the quickstart.",
      createdAt: 1002,
      answered: true,
      citations: [{ url: "https://docs.example.com/quickstart", title: "Quickstart" }],
    });

    await env.DB.prepare(
      `INSERT INTO feedback (id, org_id, message_id, visitor_id, value, note, created_at)
       VALUES (?1, ?2, ?3, 'vis_1', 'up', 'Very clear', 1003)`,
    )
      .bind(newId("fbk"), ORG_A, aId)
      .run();

    const app = appForOrg(ORG_A);
    const res = await call(app, `/api/admin/conversations/${conv}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: { id: string; pageUrl: string };
      turns: Array<{
        id: string;
        role: string;
        content: string;
        citations: Array<{ url: string; title: string }>;
        feedback: Array<{ value: string; note: string }>;
      }>;
    };

    expect(body.conversation.id).toBe(conv);
    expect(body.turns).toHaveLength(2);
    expect(body.turns[0]?.id).toBe(qId);
    expect(body.turns[1]).toMatchObject({
      id: aId,
      role: "assistant",
      content: "Follow the quickstart.",
      citations: [{ url: "https://docs.example.com/quickstart", title: "Quickstart" }],
      feedback: [{ value: "up", note: "Very clear" }],
    });
  });

  it("picks the same first question in list and detail when two questions share created_at", async () => {
    const astA = await seedAssistant(ORG_A);
    const conv = await seedConversation(ORG_A, astA, 1000);
    // Insert a lexicographically larger id first and a smaller id second with the
    // same created_at so ordering by (created_at, id) would disagree with (created_at, rowid).
    await env.DB.prepare(
      `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at, reply_to, question_key)
       VALUES (?1, ?2, ?3, 'user', ?4, '[]', NULL, 0, 0, 1, 1001, NULL, ?5)`,
    )
      .bind(
        "msg_zzzzzzzzzzzzzzzzzzzz",
        ORG_A,
        conv,
        "First written question",
        "first written question",
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at, reply_to, question_key)
       VALUES (?1, ?2, ?3, 'user', ?4, '[]', NULL, 0, 0, 1, 1001, NULL, ?5)`,
    )
      .bind(
        "msg_aaaaaaaaaaaaaaaaaaaa",
        ORG_A,
        conv,
        "Second written question",
        "second written question",
      )
      .run();

    const app = appForOrg(ORG_A);
    const [listRes, detailRes] = await Promise.all([
      call(app, `/api/admin/assistants/${astA}/conversations`),
      call(app, `/api/admin/conversations/${conv}`),
    ]);
    expect(listRes.status).toBe(200);
    expect(detailRes.status).toBe(200);

    const listBody = (await listRes.json()) as {
      conversations: Array<{ id: string; firstQuestion: string | null }>;
    };
    const detailBody = (await detailRes.json()) as {
      turns: Array<{ id: string; role: string; content: string }>;
    };

    const listFirst = listBody.conversations.find((c) => c.id === conv)?.firstQuestion;
    const detailFirst = detailBody.turns.find((t) => t.role === "user")?.content;
    expect(listFirst).toBe("First written question");
    expect(detailFirst).toBe("First written question");
  });
});
