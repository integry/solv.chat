import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { newId, parseChatEventLine } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { reportFor } from "../../src/admin/reports.js";
import { createApp } from "../../src/app.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { Embedder } from "../../src/providers/retrieval.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { fakeSeams, TEST_ORG_ID } from "../helpers/app.js";
import { numberedConfig } from "../helpers/config.js";

/**
 * Reports "Content used most" / "Content never used" through the real answer
 * pipeline: what a reply was given is recorded by document id (written
 * answers included), while the visitor still sees only public citations.
 */

const ORG_A = TEST_ORG_ID;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const SITE = "https://site.example";
const ANSWER_URL = "https://engine.example/admin/sources#entry:refunds";
const PAGE_URL = "https://site.example/docs/billing";

/** Every text embeds the same, so every seeded chunk is retrieved with score 1. */
const embedder: Embedder = {
  dimensions: 4,
  async embed(texts, onBilled) {
    await onBilled(texts.length);
    return { vectors: texts.map(() => [1, 0, 0, 0]) };
  },
};

const provider: LlmProvider = {
  name: "anthropic",
  model: ANTHROPIC_MODELS.balanced.id,
  async *stream() {
    yield { kind: "text", text: "Refunds take five days [1]." };
    yield { kind: "usage", tokensIn: 10, tokensOut: 5 };
  },
};

function parseSse(text: string) {
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
      return parseChatEventLine(name, data);
    });
}

function tenantFor(orgId: string) {
  return forPrincipal(env.DB, { orgId, userId: "owner", role: "owner" });
}

interface Seeded {
  assistantId: string;
  publicKey: string;
  answerDocId: string;
  pageDocId: string;
  unusedDocId: string;
}

/**
 * An assistant with a written answer, a page and a page nobody is given.
 * Only the chunks named in `retrievable` are in the vector index.
 */
async function seed(
  orgId: string,
  retriever: ReturnType<typeof memoryRetriever>,
  retrievable: { answer: boolean; page: boolean },
): Promise<Seeded> {
  const tenant = tenantFor(orgId);
  const assistantId = newId("ast");
  const publicKey = `pk_${newId("ast").slice(4)}`;
  await tenant.assistants.create({
    id: assistantId,
    name: "Docs Bot",
    publicKey,
    allowedOrigins: [SITE],
    createdAt: 1000,
  });
  const draft = await tenant.versions.createDraft({
    id: newId("ver"),
    assistantId,
    config: numberedConfig(),
    createdAt: 1000,
  });
  await tenant.versions.publishDraft(assistantId, draft.id, newId("ver"), 2000);

  const entrySource = newId("src");
  const pushSource = newId("src");
  await tenant.sources.create({
    id: entrySource,
    assistantId,
    kind: "entry",
    label: "Written answers",
    settings: {},
    createdAt: 1000,
  });
  await tenant.sources.create({
    id: pushSource,
    assistantId,
    kind: "push",
    label: "Docs",
    settings: {},
    createdAt: 1000,
  });

  const answerDocId = newId("doc");
  const pageDocId = newId("doc");
  const unusedDocId = newId("doc");
  const docs = [
    { id: answerDocId, sourceId: entrySource, url: ANSWER_URL, title: "How long do refunds take?" },
    { id: pageDocId, sourceId: pushSource, url: PAGE_URL, title: "Billing" },
    { id: unusedDocId, sourceId: pushSource, url: `${SITE}/docs/sso`, title: "SSO" },
  ];
  const vectors: Array<{ chunkId: string; vector: number[]; orgId: string; assistantId: string }> =
    [];
  for (const doc of docs) {
    await tenant.documents.upsert({
      id: doc.id,
      sourceId: doc.sourceId,
      externalId: doc.id,
      url: doc.url,
      title: doc.title,
      contentHash: doc.id,
      updatedAt: 1000,
    });
    const chunkId = newId("chk");
    await tenant.documents.replaceChunks(doc.id, [
      { id: chunkId, ordinal: 0, text: `${doc.title} text.`, headingPath: "" },
    ]);
    const wanted =
      (doc.id === answerDocId && retrievable.answer) || (doc.id === pageDocId && retrievable.page);
    if (wanted) vectors.push({ chunkId, vector: [1, 0, 0, 0], orgId, assistantId });
  }
  await retriever.upsert(vectors);
  return { assistantId, publicKey, answerDocId, pageDocId, unusedDocId };
}

async function post(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  origin: string,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://engine.example${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function askAsVisitor(
  app: ReturnType<typeof createApp>,
  publicKey: string,
  message = "How long do refunds take?",
): Promise<string> {
  const res = await post(
    app,
    "/v1/chat",
    { protocol: 1, assistant: publicKey, visitorId: "vis_1", message },
    SITE,
  );
  expect(res.status).toBe(200);
  return res.text();
}

describe("reports: content used, written answers included", () => {
  let retriever = memoryRetriever();
  let app = createApp(fakeSeams(), { chat: { embedder, retriever, provider } });

  beforeEach(async () => {
    retriever = memoryRetriever();
    app = createApp(fakeSeams(), { chat: { embedder, retriever, provider } });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM test_runs"),
      env.DB.prepare("DELETE FROM tests"),
      env.DB.prepare("DELETE FROM usage_daily"),
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  it("counts a written answer that was used and does not list it as never used", async () => {
    const s = await seed(ORG_A, retriever, { answer: true, page: false });
    await askAsVisitor(app, s.publicKey);
    await askAsVisitor(app, s.publicKey, "Refund time?");

    const report = await reportFor(tenantFor(ORG_A), s.assistantId, 7);
    expect(report.topSources).toEqual([
      {
        documentId: s.answerDocId,
        kind: "answer",
        url: ANSWER_URL,
        title: "How long do refunds take?",
        count: 2,
      },
    ]);
    expect(report.uncitedSources.map((d) => d.documentId).sort()).toEqual(
      [s.pageDocId, s.unusedDocId].sort(),
    );
    expect(report.uncitedTotal).toBe(2);
  });

  it("never sends a written answer, its admin address or its id to the visitor", async () => {
    const s = await seed(ORG_A, retriever, { answer: true, page: true });
    const body = await askAsVisitor(app, s.publicKey);

    const citations = parseSse(body).filter((e) => e.type === "citation");
    expect(citations).toEqual([{ type: "citation", url: PAGE_URL, title: "Billing" }]);
    // Nothing internal anywhere in the public response.
    expect(body).not.toContain("/admin/");
    expect(body).not.toContain(s.answerDocId);
    expect(body).not.toContain(s.pageDocId);

    // The stored citations (what Conversations and a restored widget show)
    // stay public too: the record of use is kept apart from them.
    const stored = await env.DB.prepare(
      "SELECT citations FROM messages WHERE org_id = ?1 AND role = 'assistant'",
    )
      .bind(ORG_A)
      .first<{ citations: string }>();
    expect(JSON.parse(stored?.citations ?? "null")).toEqual([{ url: PAGE_URL, title: "Billing" }]);
  });

  it("counts a used page as before, and both kinds when one answer used both", async () => {
    const s = await seed(ORG_A, retriever, { answer: true, page: true });
    await askAsVisitor(app, s.publicKey);

    const report = await reportFor(tenantFor(ORG_A), s.assistantId, 7);
    expect(
      report.topSources.map(({ documentId, kind, count }) => ({ documentId, kind, count })),
    ).toEqual(
      expect.arrayContaining([
        { documentId: s.answerDocId, kind: "answer", count: 1 },
        { documentId: s.pageDocId, kind: "page", count: 1 },
      ]),
    );
    expect(report.topSources).toHaveLength(2);
    expect(report.uncitedSources).toEqual([
      { documentId: s.unusedDocId, kind: "page", url: `${SITE}/docs/sso`, title: "SSO" },
    ]);
    expect(report.uncitedTotal).toBe(1);
  });

  it("counts a page used by a reply from before the record existed, by its citation", async () => {
    const s = await seed(ORG_A, retriever, { answer: false, page: false });
    const conversationId = newId("cnv");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url)
         VALUES (?1, ?2, ?3, 'vis_1', ?4, '')`,
      ).bind(conversationId, ORG_A, s.assistantId, Date.now()),
      // An older reply: citations only, no `message_documents` rows. Its
      // written answer was never in the citations, so it cannot be counted.
      env.DB.prepare(
        `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, created_at)
         VALUES (?1, ?2, ?3, 'assistant', 'Old answer', ?4, 1, ?5)`,
      ).bind(
        newId("msg"),
        ORG_A,
        conversationId,
        JSON.stringify([{ url: PAGE_URL, title: "Billing" }]),
        Date.now(),
      ),
    ]);

    const report = await reportFor(tenantFor(ORG_A), s.assistantId, 7);
    expect(report.topSources).toEqual([
      { documentId: s.pageDocId, kind: "page", url: PAGE_URL, title: "Billing", count: 1 },
    ]);
    expect(report.uncitedSources.map((d) => d.documentId)).toContain(s.answerDocId);
  });

  it("does not count content used only in Try it or in a test run", async () => {
    const s = await seed(ORG_A, retriever, { answer: true, page: true });

    const preview = await post(
      app,
      "/api/admin/chat",
      {
        protocol: 1,
        assistant: s.publicKey,
        visitorId: "vis_admin",
        message: "How long do refunds take?",
        target: "draft",
      },
      "https://engine.example",
    );
    expect(preview.status).toBe(200);
    // The preview did answer from the content: it is just not stored.
    expect(parseSse(await preview.text()).filter((e) => e.type === "citation")).toEqual([
      { type: "citation", url: PAGE_URL, title: "Billing" },
    ]);

    const created = await post(
      app,
      `/api/admin/assistants/${s.assistantId}/tests`,
      { question: "How long do refunds take?", expectation: { kind: "contains", phrase: "five" } },
      "https://engine.example",
    );
    expect(created.status).toBe(201);
    const run = await post(
      app,
      `/api/admin/assistants/${s.assistantId}/test-runs`,
      undefined,
      "https://engine.example",
    );
    expect(run.status).toBe(201);
    expect(((await run.json()) as { passed: boolean }).passed).toBe(true);

    const recorded = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM message_documents WHERE org_id = ?1",
    )
      .bind(ORG_A)
      .first<{ n: number }>();
    expect(recorded?.n).toBe(0);
    const report = await reportFor(tenantFor(ORG_A), s.assistantId, 7);
    expect(report.topSources).toEqual([]);
    expect(report.uncitedTotal).toBe(3);
  });

  it("keeps each org's use to itself", async () => {
    const a = await seed(ORG_A, retriever, { answer: false, page: false });
    const b = await seed(ORG_B, retriever, { answer: true, page: true });
    await askAsVisitor(app, b.publicKey);

    // A row in org B naming org A's document must not count for A.
    const convB = await env.DB.prepare(
      "SELECT id FROM conversations WHERE org_id = ?1 AND assistant_id = ?2",
    )
      .bind(ORG_B, b.assistantId)
      .first<{ id: string }>();
    const replyB = await env.DB.prepare(
      "SELECT id FROM messages WHERE org_id = ?1 AND conversation_id = ?2 AND role = 'assistant'",
    )
      .bind(ORG_B, convB?.id)
      .first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO message_documents (org_id, message_id, document_id) VALUES (?1, ?2, ?3)",
    )
      .bind(ORG_B, replyB?.id, a.answerDocId)
      .run();

    const reportA = await reportFor(tenantFor(ORG_A), a.assistantId, 7);
    expect(reportA.topSources).toEqual([]);
    expect(reportA.uncitedTotal).toBe(3);

    const reportB = await reportFor(tenantFor(ORG_B), b.assistantId, 7);
    expect(reportB.topSources.map((d) => d.documentId).sort()).toEqual(
      [b.answerDocId, b.pageDocId].sort(),
    );
    // Org A's assistant is not org B's to read.
    await expect(reportFor(tenantFor(ORG_B), a.assistantId, 7)).rejects.toThrow();
  });

  it("drops a deleted document from both lists without breaking the report", async () => {
    const s = await seed(ORG_A, retriever, { answer: true, page: true });
    await askAsVisitor(app, s.publicKey);

    await tenantFor(ORG_A).documents.remove(s.answerDocId);

    const report = await reportFor(tenantFor(ORG_A), s.assistantId, 7);
    expect(report.topSources.map((d) => d.documentId)).toEqual([s.pageDocId]);
    expect(report.uncitedSources.map((d) => d.documentId)).toEqual([s.unusedDocId]);
    // The record of use is kept with the reply.
    const kept = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM message_documents WHERE org_id = ?1 AND document_id = ?2",
    )
      .bind(ORG_A, s.answerDocId)
      .first<{ n: number }>();
    expect(kept?.n).toBe(1);
  });

  it("forgets the record with the reply", async () => {
    const s = await seed(ORG_A, retriever, { answer: true, page: false });
    await askAsVisitor(app, s.publicKey);
    await env.DB.prepare("DELETE FROM messages WHERE org_id = ?1").bind(ORG_A).run();
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM message_documents WHERE org_id = ?1",
    )
      .bind(ORG_A)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
