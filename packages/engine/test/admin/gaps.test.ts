import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
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

async function call(
  app: ReturnType<typeof createTestApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  if (method !== "GET" && method !== "HEAD") {
    headers.Origin = "https://example.com";
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await app.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function seedAssistant(orgId: string): Promise<string> {
  const id = newId("ast");
  await env.DB.prepare(
    `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at)
     VALUES (?1, ?2, 'Docs Bot', ?3, '[]', ?4)`,
  )
    .bind(id, orgId, `pk_${newId("ast").slice(4)}`, Date.now())
    .run();
  return id;
}

async function seedTurn(args: {
  orgId: string;
  assistantId: string;
  conversationId?: string;
  question: string;
  answered: boolean;
  createdAt: number;
}): Promise<{ conversationId: string; questionId: string; assistantMessageId: string }> {
  const conversationId = args.conversationId ?? newId("cnv");
  if (!args.conversationId) {
    await env.DB.prepare(
      `INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url)
       VALUES (?1, ?2, ?3, 'vis_1', ?4, '')`,
    )
      .bind(conversationId, args.orgId, args.assistantId, args.createdAt)
      .run();
  }
  const questionId = newId("msg");
  const assistantMessageId = newId("msg");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at)
       VALUES (?1, ?2, ?3, 'user', ?4, '[]', NULL, 0, 0, 1, ?5)`,
    ).bind(questionId, args.orgId, conversationId, args.question, args.createdAt),
    env.DB.prepare(
      `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at)
       VALUES (?1, ?2, ?3, 'assistant', 'Fallback.', '[]', NULL, 0, 0, ?4, ?5)`,
    ).bind(
      assistantMessageId,
      args.orgId,
      conversationId,
      args.answered ? 1 : 0,
      args.createdAt + 1,
    ),
  ]);
  return { conversationId, questionId, assistantMessageId };
}

describe("admin gaps API", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM gap_answers"),
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  it("includes only answered = 0 messages and groups questions differing only in case and whitespace", async () => {
    const astA = await seedAssistant(ORG_A);
    const astB = await seedAssistant(ORG_B);

    // Answered question must NOT appear in gaps.
    const answeredConv = await seedTurn({
      orgId: ORG_A,
      assistantId: astA,
      question: "What is your pricing?",
      answered: true,
      createdAt: 1000,
    });
    // A second turn in the same conversation that is unanswered should attribute only its own question.
    await seedTurn({
      orgId: ORG_A,
      assistantId: astA,
      conversationId: answeredConv.conversationId,
      question: "Do you ship to Spain?",
      answered: false,
      createdAt: 2000,
    });
    const latestSpain = await seedTurn({
      orgId: ORG_A,
      assistantId: astA,
      question: "  do   you  ship\tto  SPAIN? ",
      answered: false,
      createdAt: 3000,
    });
    await seedTurn({
      orgId: ORG_A,
      assistantId: astA,
      question: "Do you support SSO?",
      answered: false,
      createdAt: 2500,
    });

    // Other org's gap must never appear.
    await seedTurn({
      orgId: ORG_B,
      assistantId: astB,
      question: "Org B secret question?",
      answered: false,
      createdAt: 4000,
    });

    const app = appForOrg(ORG_A);
    const res = await call(app, "GET", `/api/admin/assistants/${astA}/gaps`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gaps: Array<{
        question: string;
        times: number;
        lastAsked: number;
        exampleMessageId: string;
        handled: boolean;
      }>;
    };

    expect(body.gaps).toHaveLength(2);
    expect(body.gaps[0]).toMatchObject({
      question: "do you ship to spain?",
      times: 2,
      lastAsked: 3000,
      exampleMessageId: latestSpain.questionId,
      handled: false,
    });
    expect(body.gaps[1]).toMatchObject({
      question: "do you support sso?",
      times: 1,
      lastAsked: 2500,
      handled: false,
    });

    // Cross-org assistant is 404.
    const crossRes = await call(app, "GET", `/api/admin/assistants/${astB}/gaps`);
    expect(crossRes.status).toBe(404);
  });

  it("marks a gap as handled after an answer is written for it", async () => {
    const astA = await seedAssistant(ORG_A);
    const turn = await seedTurn({
      orgId: ORG_A,
      assistantId: astA,
      question: "Do you offer refunds?",
      answered: false,
      createdAt: 1000,
    });

    const app = appForOrg(ORG_A);
    const writeRes = await call(app, "POST", `/api/admin/assistants/${astA}/answers`, {
      question: "Do you offer refunds?",
      answer: "Yes, within 30 days.",
      fromMessageId: turn.questionId,
    });
    expect(writeRes.status).toBe(201);
    const { documentId } = (await writeRes.json()) as { documentId: string };

    const gapsRes = await call(app, "GET", `/api/admin/assistants/${astA}/gaps`);
    expect(gapsRes.status).toBe(200);
    const body = (await gapsRes.json()) as {
      gaps: Array<{ question: string; handled: boolean; documentId: string | null }>;
    };
    expect(body.gaps).toHaveLength(1);
    expect(body.gaps[0]?.handled).toBe(true);
    expect(body.gaps[0]?.documentId).toBe(documentId);
  });

  it("keeps handled status consistent across Gaps and Conversations without inflating ask counts", async () => {
    const astA = await seedAssistant(ORG_A);
    const turn = await seedTurn({
      orgId: ORG_A,
      assistantId: astA,
      question: "Do you support SAML?",
      answered: false,
      createdAt: 1000,
    });

    const app = appForOrg(ORG_A);

    // 1. Answer from Gaps (user message ID).
    const writeFromGap = await call(app, "POST", `/api/admin/assistants/${astA}/answers`, {
      question: "Do you support SAML?",
      answer: "Yes, on Business plans.",
      fromMessageId: turn.questionId,
    });
    expect(writeFromGap.status).toBe(201);
    const { documentId } = (await writeFromGap.json()) as { documentId: string };

    // 2. Conversation detail must show the assistant turn as handled with the same documentId.
    const convRes = await call(app, "GET", `/api/admin/conversations/${turn.conversationId}`);
    expect(convRes.status).toBe(200);
    const convBody = (await convRes.json()) as {
      turns: Array<{ id: string; role: string; answerDocumentId: string | null }>;
    };
    const assistantTurn = convBody.turns.find((t) => t.id === turn.assistantMessageId);
    expect(assistantTurn?.answerDocumentId).toBe(documentId);

    // 3. Even if an answer is submitted with the assistant message ID, it normalizes to the
    // canonical user message ID and does not inflate the gap's "Asked" count.
    const writeFromAssistant = await call(app, "POST", `/api/admin/assistants/${astA}/answers`, {
      question: "Do you support SAML?",
      answer: "Yes, on Business and Enterprise plans.",
      fromMessageId: turn.assistantMessageId,
    });
    expect(writeFromAssistant.status).toBe(201);
    const { documentId: updatedDocId } = (await writeFromAssistant.json()) as {
      documentId: string;
    };

    const gapsRes = await call(app, "GET", `/api/admin/assistants/${astA}/gaps`);
    expect(gapsRes.status).toBe(200);
    const gapsBody = (await gapsRes.json()) as {
      gaps: Array<{ times: number; handled: boolean; documentId: string | null }>;
    };
    expect(gapsBody.gaps).toHaveLength(1);
    expect(gapsBody.gaps[0]).toMatchObject({
      times: 1,
      handled: true,
      documentId: updatedDocId,
    });

    // 4. Even if both user and assistant link rows exist in gap_answers, listGaps counts the exchange once.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO gap_answers (org_id, message_id, document_id, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(ORG_A, turn.assistantMessageId, documentId, 2000)
      .run();

    const dedupedGapsRes = await call(app, "GET", `/api/admin/assistants/${astA}/gaps`);
    expect(dedupedGapsRes.status).toBe(200);
    const dedupedBody = (await dedupedGapsRes.json()) as {
      gaps: Array<{ times: number; handled: boolean; documentId: string | null }>;
    };
    expect(dedupedBody.gaps).toHaveLength(1);
    expect(dedupedBody.gaps[0]).toMatchObject({
      times: 1,
      handled: true,
      documentId: updatedDocId,
    });
  });
});
