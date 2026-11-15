import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { defaultVersionConfig, newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { writeTheRightAnswer } from "../../src/admin/answers.js";
import { getConversation } from "../../src/admin/conversations.js";
import { NotFound } from "../../src/admin/errors.js";
import { listGaps } from "../../src/admin/gaps.js";
import { answerMessage } from "../../src/chat/answer.js";
import { normalizeQuestionText } from "../../src/db/messages.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { runIngestBatch } from "../../src/ingest/consumer.js";
import type { IngestQueueMessage } from "../../src/ingest/documents.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { acceptQueuedOrg, createTestApp, TEST_ORG_ID } from "../helpers/app.js";

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

async function seedGap(orgId: string, question: string) {
  const assistantId = newId("ast");
  const conversationId = newId("cnv");
  const questionId = newId("msg");
  const assistantMsgId = newId("msg");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at) VALUES (?1, ?2, 'Docs Bot', ?3, '[]', ?4)",
    ).bind(assistantId, orgId, `pk_${newId("ast").slice(4)}`, now),
    env.DB.prepare(
      "INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url) VALUES (?1, ?2, ?3, 'vis_1', ?4, '')",
    ).bind(conversationId, orgId, assistantId, now),
    env.DB.prepare(
      "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at, question_key) VALUES (?1, ?2, ?3, 'user', ?4, '[]', NULL, 0, 0, 1, ?5, ?6)",
    ).bind(questionId, orgId, conversationId, question, now, normalizeQuestionText(question)),
    env.DB.prepare(
      "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at, reply_to) VALUES (?1, ?2, ?3, 'assistant', 'No answer.', '[]', NULL, 0, 0, 0, ?4, ?5)",
    ).bind(assistantMsgId, orgId, conversationId, now + 1, questionId),
  ]);
  return { assistantId, conversationId, questionId, assistantMsgId };
}

describe("admin answers API", () => {
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

  it("creates an entry document, hashes and enqueues it, links it to the message, and is idempotent", async () => {
    const { assistantId, questionId } = await seedGap(ORG_A, "Do you ship to Spain?");
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const sent: IngestQueueMessage[] = [];
    const queue = {
      async send(msg: IngestQueueMessage) {
        sent.push(msg);
      },
    };
    const deps = { tenant, docs: env.DOCS, queue, publicBaseUrl: "https://admin.example.com" };

    const first = await writeTheRightAnswer(
      deps,
      { orgId: ORG_A },
      {
        assistantId,
        question: "Do you ship to Spain?",
        answer: "Yes, we ship to Spain within 3 business days.",
        fromMessageId: questionId,
      },
    );
    expect(first.counts).toEqual({ written: 1, unchanged: 0, deleted: 0 });
    expect(sent).toHaveLength(1);

    const source = await tenant.sources.get(first.sourceId);
    expect(source?.kind).toBe("entry");

    const doc = await tenant.documents.get(first.documentId);
    expect(doc).not.toBeNull();
    expect(doc?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const link = await env.DB.prepare(
      "SELECT document_id FROM gap_answers WHERE org_id = ?1 AND message_id = ?2",
    )
      .bind(ORG_A, questionId)
      .first<{ document_id: string }>();
    expect(link?.document_id).toBe(first.documentId);

    // Run the ingest batch so indexed_hash is populated, then repeat with identical content.
    await runIngestBatch(
      {
        messages: sent.map((body) => ({
          id: newId("msg"),
          timestamp: new Date(),
          attempts: 1,
          body,
          ack() {},
          retry() {},
        })),
      },
      {
        db: env.DB,
        resolveOrg: acceptQueuedOrg,
        docs: env.DOCS,
        embedder: fakeEmbedder(),
        retriever: memoryRetriever(),
      },
    );

    // Repeating with identical question & answer is idempotent (no new queue message).
    const second = await writeTheRightAnswer(
      deps,
      { orgId: ORG_A },
      {
        assistantId,
        question: "Do you ship to Spain?",
        answer: "Yes, we ship to Spain within 3 business days.",
        fromMessageId: questionId,
      },
    );
    expect(second.documentId).toBe(first.documentId);
    expect(second.counts).toEqual({ written: 0, unchanged: 1, deleted: 0 });
    expect(sent).toHaveLength(1);
  });

  it("returns 404 when the assistant or originating message belongs to another org", async () => {
    const gapA = await seedGap(ORG_A, "Org A question?");
    const gapB = await seedGap(ORG_B, "Org B question?");

    const appA = appForOrg(ORG_A);

    const wrongAssistantRes = await call(
      appA,
      "POST",
      `/api/admin/assistants/${gapB.assistantId}/answers`,
      {
        question: "Org B question?",
        answer: "Answer",
        fromMessageId: gapB.questionId,
      },
    );
    expect(wrongAssistantRes.status).toBe(404);

    const wrongMsgRes = await call(
      appA,
      "POST",
      `/api/admin/assistants/${gapA.assistantId}/answers`,
      {
        question: "Org B question?",
        answer: "Answer",
        fromMessageId: gapB.questionId,
      },
    );
    expect(wrongMsgRes.status).toBe(404);

    const tenantA = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    await expect(
      writeTheRightAnswer(
        {
          tenant: tenantA,
          docs: env.DOCS,
          queue: { async send() {} },
          publicBaseUrl: "https://admin.example.com",
        },
        { orgId: ORG_A },
        {
          assistantId: gapA.assistantId,
          question: "Test?",
          answer: "Answer",
          fromMessageId: gapB.questionId,
        },
      ),
    ).rejects.toThrow(NotFound);
  });

  it("produces content the chat pipeline retrieves when the same question is asked afterwards", async () => {
    const question = "Do you offer student discounts?";
    const { assistantId, questionId } = await seedGap(ORG_A, question);
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const sent: IngestQueueMessage[] = [];
    const deps = {
      tenant,
      docs: env.DOCS,
      queue: {
        async send(msg: IngestQueueMessage) {
          sent.push(msg);
        },
      },
      publicBaseUrl: "https://admin.example.com",
    };

    const saved = await writeTheRightAnswer(
      deps,
      { orgId: ORG_A },
      {
        assistantId,
        question,
        // None of the embedder's words appear in the answer: only the question,
        // which becomes the entry's heading, can make it retrievable.
        answer: "Yes, 50% off with a valid university email.",
        fromMessageId: questionId,
      },
    );

    // Bag-of-words embedder so the question and the entry chunk share semantic overlap.
    const vocab = ["student", "discounts", "pricing", "shipping"];
    const embedder = {
      dimensions: vocab.length,
      async embed(texts: readonly string[], onBilled: (tokens: number) => Promise<void>) {
        await onBilled(texts.length);
        const vectors = texts.map((t) => {
          const lower = t.toLowerCase();
          const vec = vocab.map((w) => (lower.includes(w) ? 1 : 0));
          const norm = Math.hypot(...vec) || 1;
          return vec.map((v) => v / norm);
        });
        return { vectors };
      },
    };
    const retriever = memoryRetriever();
    await runIngestBatch(
      {
        messages: sent.map((body) => ({
          id: newId("msg"),
          timestamp: new Date(),
          attempts: 1,
          body,
          ack() {},
          retry() {},
        })),
      },
      { db: env.DB, resolveOrg: acceptQueuedOrg, docs: env.DOCS, embedder, retriever },
    );

    let capturedContext = "";
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.fast.id,
      async *stream(req) {
        capturedContext = [
          req.system,
          ...req.messages.map((m) => ("content" in m ? m.content : "")),
        ].join("\n");
        yield { kind: "text", text: "Students get 50% off." };
        yield { kind: "usage", tokensIn: 20, tokensOut: 10 };
      },
    };

    const events = [];
    for await (const ev of answerMessage(
      {
        tenant,
        embedder,
        retriever,
        provider,
        model: ANTHROPIC_MODELS.fast,
        usage: { async record() {} },
      },
      {
        orgId: ORG_A,
        assistantId,
        visitorId: "vis_follow_up",
        message: question,
        behaviour: defaultVersionConfig().behaviour,
      },
    )) {
      events.push(ev);
    }

    expect(capturedContext).toContain("50% off");
    expect(capturedContext).toContain(`section: ${question}`);
    // The entry's URL is an admin link, so it is never shown to a visitor.
    expect(saved.url).toContain("/admin/");
    expect(events.some((e) => e.type === "citation")).toBe(false);
    expect(capturedContext).not.toContain(saved.url);
    expect(events.some((e) => e.type === "token" && e.text.includes("50% off"))).toBe(true);
  });

  it("links each unanswered reply to its own question when two requests interleave in one conversation", async () => {
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const assistantId = newId("ast");
    await tenant.assistants.create({
      id: assistantId,
      name: "Docs Bot",
      publicKey: `pk_${newId("ast").slice(4)}`,
      allowedOrigins: [],
      createdAt: 1000,
    });
    const conversationId = newId("cnv");
    await tenant.conversations.create({
      id: conversationId,
      assistantId,
      visitorId: "vis_1",
      startedAt: 1000,
      pageUrl: "",
    });

    // Request A stops inside retrieval until request B has finished, so B's
    // question and reply are written between A's question and A's reply.
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let enteredA: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredA = resolve;
    });
    let queries = 0;
    const retriever = {
      ...memoryRetriever(),
      async query() {
        queries += 1;
        if (queries === 1) {
          enteredA();
          await gate;
        }
        return [];
      },
    };
    const deps = {
      tenant,
      embedder: fakeEmbedder(),
      retriever,
      provider: {
        name: "anthropic" as const,
        model: ANTHROPIC_MODELS.fast.id,
        async *stream() {
          yield { kind: "text" as const, text: "unused" };
        },
      },
      model: ANTHROPIC_MODELS.fast,
      usage: { async record() {} },
    };
    const ask = async (message: string) => {
      let replyId = "";
      for await (const ev of answerMessage(deps, {
        orgId: ORG_A,
        assistantId,
        visitorId: "vis_1",
        conversationId,
        message,
        behaviour: defaultVersionConfig().behaviour,
      })) {
        if (ev.type === "done") replyId = ev.messageId;
      }
      return replyId;
    };

    const runA = ask("Question A about refunds?");
    await entered;
    const replyB = await ask("Question B about shipping?");
    releaseA();
    const replyA = await runA;

    const turns = await tenant.messages.list(conversationId);
    // The order a timestamp heuristic would get wrong: A's reply comes last.
    expect(turns.map((t) => t.content)).toEqual([
      "Question A about refunds?",
      "Question B about shipping?",
      defaultVersionConfig().behaviour.fallbackText,
      defaultVersionConfig().behaviour.fallbackText,
    ]);
    const questionA = turns[0]?.id ?? "";
    const questionB = turns[1]?.id ?? "";
    expect(turns.find((t) => t.id === replyA)?.replyTo).toBe(questionA);
    expect(turns.find((t) => t.id === replyB)?.replyTo).toBe(questionB);

    const gaps = await listGaps(tenant, assistantId);
    expect(gaps.total).toBe(2);
    expect(gaps.gaps.map((g) => [g.question, g.times, g.exampleMessageId]).sort()).toEqual([
      ["question a about refunds?", 1, questionA],
      ["question b about shipping?", 1, questionB],
    ]);

    // Answering from A's reply links A's question, and the conversation shows
    // the answer under A's reply only.
    const saved = await writeTheRightAnswer(
      {
        tenant,
        docs: env.DOCS,
        queue: { async send() {} },
        publicBaseUrl: "https://admin.example.com",
      },
      { orgId: ORG_A },
      {
        assistantId,
        question: "Question A about refunds?",
        answer: "Refunds take 5 days.",
        fromMessageId: replyA,
      },
    );
    const link = await env.DB.prepare(
      "SELECT message_id FROM gap_answers WHERE org_id = ?1 AND document_id = ?2",
    )
      .bind(ORG_A, saved.documentId)
      .first<{ message_id: string }>();
    expect(link?.message_id).toBe(questionA);

    const afterGaps = await listGaps(tenant, assistantId);
    const handled = Object.fromEntries(afterGaps.gaps.map((g) => [g.question, g.handled]));
    expect(handled).toEqual({
      "question a about refunds?": true,
      "question b about shipping?": false,
    });

    const detail = await getConversation(tenant, conversationId);
    const docByTurn = Object.fromEntries(detail.turns.map((t) => [t.id, t.answerDocumentId]));
    expect(docByTurn[replyA]).toBe(saved.documentId);
    expect(docByTurn[replyB]).toBeNull();

    // The admin resolves a reply's question from this field, not from the
    // turn order the timestamps produce.
    const replyToByTurn = Object.fromEntries(detail.turns.map((t) => [t.id, t.replyTo]));
    expect(replyToByTurn).toEqual({
      [questionA]: null,
      [questionB]: null,
      [replyA]: questionA,
      [replyB]: questionB,
    });
  });
});
