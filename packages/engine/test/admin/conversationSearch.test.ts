import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { MAX_CONVERSATION_SEARCH_LENGTH, newId, toConversationSearch } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { conversationsFor } from "../../src/db/conversations.js";
import { messagesFor, normalizeQuestionText, searchableText } from "../../src/db/messages.js";
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

async function getJson<T>(orgId: string, path: string): Promise<T> {
  const ctx = createExecutionContext();
  const res = await appForOrg(orgId).fetch(
    new Request(`https://example.com${path}`),
    { ...env, INGEST_QUEUE: { async send() {}, async sendBatch() {} } as unknown as Queue },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
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

async function seedConversation(orgId: string, assistantId: string, at: number): Promise<string> {
  const id = newId("cnv");
  await conversationsFor(env.DB, orgId).create({
    id,
    assistantId,
    visitorId: "vis_1",
    startedAt: at,
    pageUrl: "",
  });
  return id;
}

/** A visitor question written the way the chat route writes it. */
async function ask(orgId: string, conversationId: string, content: string, at: number) {
  const id = newId("msg");
  await messagesFor(env.DB, orgId).create({
    id,
    conversationId,
    role: "user",
    content,
    citations: [],
    toolCalls: null,
    tokensIn: 0,
    tokensOut: 0,
    answered: true,
    createdAt: at,
  });
  return id;
}

/** A row as it was stored before migration 0018: no `search_text`. */
async function legacyMessage(
  orgId: string,
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  at: number,
  resumeContext: string | null = null,
): Promise<string> {
  const id = newId("msg");
  await env.DB.prepare(
    `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, created_at, question_key, resume_context)
     VALUES (?1, ?2, ?3, ?4, ?5, '[]', 1, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      orgId,
      conversationId,
      role,
      content,
      at,
      role === "user" ? normalizeQuestionText(content) : null,
      resumeContext,
    )
    .run();
  return id;
}

async function storedSearchText(id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT search_text FROM messages WHERE id = ?1")
    .bind(id)
    .first<{ search_text: string | null }>();
  return row?.search_text ?? null;
}

async function pendingCount(orgId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE org_id = ?1 AND search_text IS NULL",
  )
    .bind(orgId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

interface ConversationsBody {
  conversations: Array<{ id: string }>;
  total: number;
}

interface QuestionsBody {
  topQuestions: Array<{ question: string; count: number }>;
}

async function search(orgId: string, assistantId: string, q: string): Promise<string[]> {
  const body = await getJson<ConversationsBody>(
    orgId,
    `/api/admin/assistants/${assistantId}/conversations?q=${encodeURIComponent(q)}`,
  );
  return body.conversations.map((c) => c.id).sort();
}

/** What the admin's question links do: search for the grouped question, cut to the limit. */
function openQuestion(orgId: string, assistantId: string, question: string): Promise<string[]> {
  return search(orgId, assistantId, toConversationSearch(question));
}

describe("conversation search", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  describe("most-asked question links", () => {
    it("open every conversation the question groups, however its spaces were typed", async () => {
      const ast = await seedAssistant(ORG_A);
      const now = Date.now();
      const phrasings = [
        "Do you  ship?",
        "Do you\nship?",
        "  DO YOU\r\n\tSHIP?  ",
        "Do you\u00a0ship?",
      ];
      const expected: string[] = [];
      for (const [i, text] of phrasings.entries()) {
        const conversation = await seedConversation(ORG_A, ast, now - 10_000 + i * 100);
        await ask(ORG_A, conversation, text, now - 10_000 + i * 100);
        expected.push(conversation);
      }
      // One asked before migration 0018, with its runs of spaces.
      const older = await seedConversation(ORG_A, ast, now - 9000);
      await legacyMessage(ORG_A, older, "user", "Do  you   ship?", now - 9000);
      expected.push(older);
      const other = await seedConversation(ORG_A, ast, now - 8000);
      await ask(ORG_A, other, "Do you sell gift cards?", now - 8000);
      expected.sort();

      const overview = await getJson<QuestionsBody>(ORG_A, `/api/admin/assistants/${ast}/overview`);
      const report = await getJson<QuestionsBody>(
        ORG_A,
        `/api/admin/assistants/${ast}/report?days=7`,
      );
      for (const [screen, body] of [
        ["overview", overview],
        ["reports", report],
      ] as const) {
        const top = body.topQuestions[0];
        expect({ screen, top }).toEqual({ screen, top: { question: "do you ship?", count: 5 } });
        expect({ screen, ids: await openQuestion(ORG_A, ast, top?.question ?? "") }).toEqual({
          screen,
          ids: expected,
        });
      }
    });

    it("open a long question's conversation from a link cut to the search limit", async () => {
      const ast = await seedAssistant(ORG_A);
      const now = Date.now();
      const conversation = await seedConversation(ORG_A, ast, now - 1000);
      const question = `Can I return  ${"this item\n".repeat(30)}\n\nafter thirty days?`;
      await ask(ORG_A, conversation, question, now - 1000);

      const report = await getJson<QuestionsBody>(
        ORG_A,
        `/api/admin/assistants/${ast}/report?days=7`,
      );
      const grouped = report.topQuestions[0]?.question ?? "";
      expect(grouped.length).toBeGreaterThan(MAX_CONVERSATION_SEARCH_LENGTH);
      expect(await openQuestion(ORG_A, ast, grouped)).toEqual([conversation]);
    });
  });

  describe("messages written before search_text existed", () => {
    it("are found in any case, and only within their own org", async () => {
      const astA = await seedAssistant(ORG_A);
      const astB = await seedAssistant(ORG_B);
      const now = Date.now();
      const school = await seedConversation(ORG_A, astA, now - 3000);
      const question = await legacyMessage(ORG_A, school, "user", "Où est l'ÉCOLE?", now - 3000);
      const reply = await legacyMessage(
        ORG_A,
        school,
        "assistant",
        "In ZÜRICH, by the station.",
        now - 2999,
      );
      // The same word typed as E + combining accent.
      const decomposed = await seedConversation(ORG_A, astA, now - 2000);
      await legacyMessage(ORG_A, decomposed, "user", "E\u0301COLE fees?", now - 2000);
      const otherOrg = await seedConversation(ORG_B, astB, now - 1000);
      const otherQuestion = await legacyMessage(ORG_B, otherOrg, "user", "ÉCOLE?", now - 1000);

      const both = [school, decomposed].sort();
      for (const q of ["école", "École", "ÉCOLE", "e\u0301cole"]) {
        expect({ q, ids: await search(ORG_A, astA, q) }).toEqual({ q, ids: both });
      }
      for (const q of ["zürich", "Zürich", "ZÜRICH"]) {
        expect({ q, ids: await search(ORG_A, astA, q) }).toEqual({ q, ids: [school] });
      }

      // Folded once, with the same function new writes use.
      expect(await storedSearchText(question)).toBe(searchableText("Où est l'ÉCOLE?"));
      expect(await storedSearchText(reply)).toBe(searchableText("In ZÜRICH, by the station."));
      expect(await pendingCount(ORG_A)).toBe(0);
      // Another org's rows are not touched by this org's search.
      expect(await storedSearchText(otherQuestion)).toBeNull();
      expect(await search(ORG_B, astB, "école")).toEqual([otherOrg]);
      expect(await storedSearchText(otherQuestion)).toBe(searchableText("ÉCOLE?"));
    });

    it("are folded a bounded number at a time until none are left", async () => {
      const ast = await seedAssistant(ORG_A);
      const now = Date.now();
      const conversation = await seedConversation(ORG_A, ast, now - 1000);
      for (let i = 0; i < 5; i++) {
        await legacyMessage(ORG_A, conversation, "user", `QUESTION ${i} À ÉVITER`, now - 1000 + i);
      }
      const messages = messagesFor(env.DB, ORG_A);

      expect(await messages.fillSearchText({ batch: 2, rounds: 2 })).toBe(false);
      expect(await pendingCount(ORG_A)).toBe(1);
      expect(await messages.fillSearchText({ batch: 2, rounds: 2 })).toBe(true);
      expect(await pendingCount(ORG_A)).toBe(0);
      expect(await messages.fillSearchText({ batch: 2, rounds: 2 })).toBe(true);
    });

    it("keep the newer text of a reply that resumed while they were being folded", async () => {
      const ast = await seedAssistant(ORG_A);
      const now = Date.now();
      const conversation = await seedConversation(ORG_A, ast, now - 1000);
      const reply = await legacyMessage(
        ORG_A,
        conversation,
        "assistant",
        "One moment.",
        now - 1000,
        JSON.stringify({ step: 1 }),
      );

      // The fill reads "One moment."; the reply completes before its write lands.
      const resume = async () => {
        const messages = messagesFor(env.DB, ORG_A);
        expect(
          await messages.claimPendingReply({
            conversationId: conversation,
            id: reply,
            claimToken: "claim_1",
            revision: 0,
            now,
            ttlMs: 60_000,
          }),
        ).toBe(true);
        expect(
          await messages.completeReply({
            id: reply,
            claimToken: "claim_1",
            revision: 0,
            content: "ΩΜΈΓΑ opens at nine.",
            citations: [],
            toolCalls: [],
            resumeContext: null,
            tokensIn: 0,
            tokensOut: 0,
          }),
        ).toBe(true);
      };
      let resumed = false;
      const racing = {
        prepare: (sql: string) => env.DB.prepare(sql),
        async batch(statements: D1PreparedStatement[]) {
          if (!resumed) {
            resumed = true;
            await resume();
          }
          return env.DB.batch(statements);
        },
      } as unknown as D1Database;

      expect(await messagesFor(racing, ORG_A).fillSearchText()).toBe(true);
      expect(resumed).toBe(true);
      expect(await storedSearchText(reply)).toBe(searchableText("ΩΜΈΓΑ opens at nine."));
      expect(await search(ORG_A, ast, "ωμέγα")).toEqual([conversation]);
      expect(await search(ORG_A, ast, "one moment")).toEqual([]);
    });
  });
});
