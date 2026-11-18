import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  defaultVersionConfig,
  MAX_CHAT_MESSAGE_LENGTH,
  newId,
  QUESTION_LINK_LENGTH,
  toQuestionLink,
} from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { NOT_INDEXED_AFTER_MS, overviewFor } from "../../src/admin/overview.js";
import { conversationsFor } from "../../src/db/conversations.js";
import { messagesFor, normalizeQuestionText } from "../../src/db/messages.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { utcDay } from "../../src/util/time.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

const ORG_A = TEST_ORG_ID;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const DAY = 86_400_000;

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
  if (method !== "GET") headers.Origin = "https://example.com";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await app.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    }),
    { ...env, INGEST_QUEUE: { async send() {}, async sendBatch() {} } as unknown as Queue },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function getJson<T>(app: ReturnType<typeof createTestApp>, path: string): Promise<T> {
  const res = await call(app, "GET", path);
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

const MESSAGE_COLUMNS =
  "id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at, reply_to, question_key";

interface TurnArgs {
  orgId: string;
  assistantId: string;
  conversationId?: string;
  question: string;
  reply?: string;
  answered: boolean;
  createdAt: number;
  toolCalls?: unknown[];
  thumbsDown?: boolean;
}

async function seedTurn(
  args: TurnArgs,
): Promise<{ conversationId: string; questionId: string; replyId: string }> {
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
  const replyId = newId("msg");
  const statements = [
    env.DB.prepare(
      `INSERT INTO messages (${MESSAGE_COLUMNS})
       VALUES (?1, ?2, ?3, 'user', ?4, '[]', NULL, 0, 0, 1, ?5, NULL, ?6)`,
    ).bind(
      questionId,
      args.orgId,
      conversationId,
      args.question,
      args.createdAt,
      normalizeQuestionText(args.question),
    ),
    env.DB.prepare(
      `INSERT INTO messages (${MESSAGE_COLUMNS})
       VALUES (?1, ?2, ?3, 'assistant', ?4, '[]', ?5, 0, 0, ?6, ?7, ?8, NULL)`,
    ).bind(
      replyId,
      args.orgId,
      conversationId,
      args.reply ?? "Fallback.",
      args.toolCalls ? JSON.stringify(args.toolCalls) : null,
      args.answered ? 1 : 0,
      args.createdAt + 1,
      questionId,
    ),
  ];
  if (args.thumbsDown) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO feedback (id, org_id, message_id, visitor_id, value, note, created_at)
         VALUES (?1, ?2, ?3, 'vis_1', 'down', '', ?4)`,
      ).bind(newId("fbk"), args.orgId, replyId, args.createdAt + 2),
    );
  }
  await env.DB.batch(statements);
  return { conversationId, questionId, replyId };
}

async function seedSource(orgId: string, assistantId: string, label: string): Promise<string> {
  const id = newId("src");
  await env.DB.prepare(
    `INSERT INTO sources (id, org_id, assistant_id, kind, label, settings, created_at)
     VALUES (?1, ?2, ?3, 'push', ?4, '{}', ?5)`,
  )
    .bind(id, orgId, assistantId, label, Date.now())
    .run();
  return id;
}

async function seedDocument(
  orgId: string,
  sourceId: string,
  options: {
    indexed: boolean;
    updatedAt: number;
    /** A failure indexing recorded, and the content hash it was for. */
    failedFor?: "current" | "earlier";
  },
): Promise<string> {
  const id = newId("doc");
  await env.DB.prepare(
    `INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, indexed_hash, updated_at, index_error, index_error_hash)
     VALUES (?1, ?2, ?3, ?4, ?5, 'Page', 'hash_1', ?6, ?7, ?8, ?9)`,
  )
    .bind(
      id,
      orgId,
      sourceId,
      id,
      `https://docs.example.com/${id}`,
      options.indexed ? "hash_1" : null,
      options.updatedAt,
      options.failedFor === undefined ? null : "embedding_failed",
      options.failedFor === undefined
        ? null
        : options.failedFor === "current"
          ? "hash_1"
          : "hash_0",
    )
    .run();
  return id;
}

async function seedVersion(
  orgId: string,
  assistantId: string,
  state: "draft" | "published",
): Promise<string> {
  const id = newId("ver");
  await env.DB.prepare(
    `INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      id,
      orgId,
      assistantId,
      state,
      JSON.stringify(defaultVersionConfig()),
      Date.now(),
      state === "published" ? Date.now() : null,
    )
    .run();
  return id;
}

interface OverviewBody {
  period: {
    days: number;
    from: string;
    to: string;
    questions: number;
    answeredShare: number;
    thumbsDownShare: number;
    costMicros: number;
    previous: { from: string; to: string; questions: number; answeredShare: number };
  };
  daily: Array<{ day: string; questions: number }>;
  setup: Record<string, boolean>;
  attention: {
    openGaps: number;
    failingTests: number;
    notIndexed: Array<{ sourceId: string; label: string; failed: number; waiting: number }>;
  };
}

interface ConversationsBody {
  conversations: Array<{
    id: string;
    hasUnanswered: boolean;
    hasNotHelpful: boolean;
    usedTool: boolean;
    lastMessageAt: number;
  }>;
  total: number;
}

interface GapsBody {
  gaps: Array<{ question: string; times: number; handled: boolean }>;
  total: number;
}

describe("admin Monitor screen APIs", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM gap_dismissals"),
      env.DB.prepare("DELETE FROM gap_answers"),
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM test_runs"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM usage_daily"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  describe("overview", () => {
    it("gives the last 7 days against the 7 before, with one count per day", async () => {
      const ast = await seedAssistant(ORG_A);
      const now = Date.now();
      // Current period: 3 questions, 2 answered, 1 thumbs down.
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "A?",
        answered: true,
        createdAt: now - 60_000,
      });
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "B?",
        answered: false,
        createdAt: now - 2 * DAY,
      });
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "C?",
        answered: true,
        thumbsDown: true,
        createdAt: now - 2 * DAY + 1000,
      });
      // Previous period: 1 question.
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "D?",
        answered: true,
        createdAt: now - 9 * DAY,
      });
      // Older than both: not counted.
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "E?",
        answered: true,
        createdAt: now - 30 * DAY,
      });
      // Another org's assistant: never counted.
      const other = await seedAssistant(ORG_B);
      await seedTurn({
        orgId: ORG_B,
        assistantId: other,
        question: "F?",
        answered: true,
        createdAt: now - 60_000,
      });
      await env.DB.prepare(
        "INSERT INTO usage_daily (org_id, assistant_id, day, messages, tokens_in, tokens_out, cost_micros) VALUES (?1, ?2, ?3, 1, 1, 1, 3000)",
      )
        .bind(ORG_A, ast, utcDay(now))
        .run();

      const body = await getJson<OverviewBody>(
        appForOrg(ORG_A),
        `/api/admin/assistants/${ast}/overview`,
      );
      expect(body.period).toMatchObject({
        days: 7,
        from: utcDay(now - 6 * DAY),
        to: utcDay(now),
        questions: 3,
        costMicros: 3000,
      });
      expect(body.period.answeredShare).toBeCloseTo(2 / 3);
      expect(body.period.thumbsDownShare).toBeCloseTo(1 / 3);
      expect(body.period.previous).toMatchObject({
        from: utcDay(now - 13 * DAY),
        to: utcDay(now - 7 * DAY),
        questions: 1,
        answeredShare: 1,
      });

      expect(body.daily.map((d) => d.day)).toEqual(
        Array.from({ length: 7 }, (_, i) => utcDay(now - (6 - i) * DAY)),
      );
      const count = (ts: number) => body.daily.find((d) => d.day === utcDay(ts))?.questions;
      expect(count(now - 60_000)).toBe(1);
      expect(count(now - 2 * DAY)).toBe(2);
      expect(body.daily.reduce((sum, d) => sum + d.questions, 0)).toBe(3);
    });

    it("counts a question at either edge of the day where the two periods meet once", async () => {
      const ast = await seedAssistant(ORG_A);
      // Mid-afternoon UTC, so the previous period's last day ends hours after
      // the same time of day 7 days ago.
      const startOfToday = Date.UTC(2026, 10, 17);
      const at = startOfToday + 15 * 60 * 60 * 1000;
      const startOfCurrent = startOfToday - 6 * DAY;
      const startOfPrevious = startOfToday - 13 * DAY;
      const turns: Array<[string, number]> = [
        ["Current, first moment?", startOfCurrent],
        // Day −7, later than `at - 7 days`: the previous period's.
        ["Previous, last moment?", startOfCurrent - 2],
        ["Previous, late evening?", startOfCurrent - 60 * 60 * 1000],
        ["Previous, first moment?", startOfPrevious],
        ["Before both?", startOfPrevious - 2],
      ];
      for (const [question, createdAt] of turns) {
        await seedTurn({ orgId: ORG_A, assistantId: ast, question, answered: true, createdAt });
      }
      const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });

      const overview = await overviewFor(tenant, ast, { at, today: utcDay(at) });
      expect(overview.period).toMatchObject({
        from: utcDay(startOfCurrent),
        to: utcDay(at),
        questions: 1,
      });
      expect(overview.period.previous).toMatchObject({
        from: utcDay(startOfPrevious),
        to: utcDay(startOfCurrent - 1),
        questions: 3,
      });
    });

    it("ticks each getting-started step from stored state", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      const setup = async () =>
        (await getJson<OverviewBody>(app, `/api/admin/assistants/${ast}/overview`)).setup;

      expect(await setup()).toEqual({
        hasContent: false,
        tried: false,
        published: false,
        installed: false,
        visitorQuestion: false,
      });

      const source = await seedSource(ORG_A, ast, "Docs");
      await seedDocument(ORG_A, source, { indexed: true, updatedAt: Date.now() });
      await env.DB.prepare("UPDATE assistants SET tried_at = 1 WHERE id = ?1").bind(ast).run();
      await seedVersion(ORG_A, ast, "published");
      expect(await setup()).toEqual({
        hasContent: true,
        tried: true,
        published: true,
        installed: false,
        visitorQuestion: false,
      });

      await env.DB.prepare("UPDATE assistants SET widget_seen_at = 1 WHERE id = ?1")
        .bind(ast)
        .run();
      expect((await setup()).installed).toBe(true);
      expect((await setup()).visitorQuestion).toBe(false);

      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Hi?",
        answered: true,
        createdAt: Date.now(),
      });
      expect((await setup()).visitorQuestion).toBe(true);
    });

    it("counts a visitor question as installed for sites installed before it was recorded", async () => {
      const ast = await seedAssistant(ORG_A);
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Hi?",
        answered: true,
        createdAt: Date.now(),
      });
      const body = await getJson<OverviewBody>(
        appForOrg(ORG_A),
        `/api/admin/assistants/${ast}/overview`,
      );
      expect(body.setup.installed).toBe(true);
    });

    it("lists open gaps, failing tests and sources that did not index", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      const now = Date.now();

      // Three unanswered groups: one open, one with an answer written, one dismissed.
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Open?",
        answered: false,
        createdAt: now - 5000,
      });
      const handled = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Handled?",
        answered: false,
        createdAt: now - 4000,
      });
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Dismissed?",
        answered: false,
        createdAt: now - 3000,
      });
      const entrySource = await seedSource(ORG_A, ast, "Answers");
      const entryDoc = await seedDocument(ORG_A, entrySource, { indexed: true, updatedAt: now });
      await env.DB.prepare(
        "INSERT INTO gap_answers (org_id, message_id, document_id, created_at) VALUES (?1, ?2, ?3, ?4)",
      )
        .bind(ORG_A, handled.questionId, entryDoc, now)
        .run();
      expect(
        (
          await call(app, "POST", `/api/admin/assistants/${ast}/gaps/dismiss`, {
            question: "Dismissed?",
          })
        ).status,
      ).toBe(200);

      // Latest run: one failure (an older run with more failures is ignored).
      const draft = await seedVersion(ORG_A, ast, "draft");
      const result = (outcome: string) => ({ testId: newId("tst"), outcome });
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO test_runs (id, org_id, version_id, started_at, results, passed) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
        ).bind(
          newId("run"),
          ORG_A,
          draft,
          now - 10_000,
          JSON.stringify([result("failed"), result("failed")]),
        ),
        env.DB.prepare(
          "INSERT INTO test_runs (id, org_id, version_id, started_at, results, passed) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
        ).bind(
          newId("run"),
          ORG_A,
          draft,
          now,
          JSON.stringify([result("passed"), result("failed")]),
        ),
      ]);

      // A source with two stale unindexed pages, one just written (still queued) and one indexed.
      const docs = await seedSource(ORG_A, ast, "Docs");
      const stale = now - NOT_INDEXED_AFTER_MS - 1000;
      await seedDocument(ORG_A, docs, { indexed: false, updatedAt: stale });
      await seedDocument(ORG_A, docs, { indexed: false, updatedAt: stale });
      await seedDocument(ORG_A, docs, { indexed: false, updatedAt: now });
      await seedDocument(ORG_A, docs, { indexed: true, updatedAt: stale });

      const body = await getJson<OverviewBody>(app, `/api/admin/assistants/${ast}/overview`);
      expect(body.attention).toEqual({
        openGaps: 1,
        failingTests: 1,
        notIndexed: [{ sourceId: docs, label: "Docs", failed: 0, waiting: 2 }],
      });
      // A test run goes through the same pipeline as Try it.
      expect(body.setup.tried).toBe(true);
    });

    it("reports a recorded indexing failure at once, apart from pages still waiting", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      const now = Date.now();
      const stale = now - NOT_INDEXED_AFTER_MS - 1000;

      const docs = await seedSource(ORG_A, ast, "Docs");
      // Failed moments ago: reported without waiting 15 minutes.
      await seedDocument(ORG_A, docs, { indexed: false, updatedAt: now, failedFor: "current" });
      await seedDocument(ORG_A, docs, { indexed: false, updatedAt: stale, failedFor: "current" });
      // A failure for earlier content: the new content is just waiting.
      await seedDocument(ORG_A, docs, { indexed: false, updatedAt: stale, failedFor: "earlier" });
      await seedDocument(ORG_A, docs, { indexed: false, updatedAt: now, failedFor: "earlier" });
      // Indexed after an earlier failure: nothing to report.
      await seedDocument(ORG_A, docs, { indexed: true, updatedAt: stale, failedFor: "earlier" });
      const fresh = await seedSource(ORG_A, ast, "Blog");
      await seedDocument(ORG_A, fresh, { indexed: false, updatedAt: now });
      const failedOnly = await seedSource(ORG_A, ast, "Help");
      await seedDocument(ORG_A, failedOnly, {
        indexed: false,
        updatedAt: now,
        failedFor: "current",
      });

      const body = await getJson<OverviewBody>(app, `/api/admin/assistants/${ast}/overview`);
      // Sources seeded in the same millisecond have no set order.
      const byLabel = [...body.attention.notIndexed].sort((a, b) => a.label.localeCompare(b.label));
      expect(byLabel).toEqual([
        { sourceId: docs, label: "Docs", failed: 2, waiting: 1 },
        { sourceId: failedOnly, label: "Help", failed: 1, waiting: 0 },
      ]);
    });
  });

  describe("conversations list", () => {
    async function seedFour(ast: string) {
      const now = Date.now();
      const unanswered = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Do you ship to Spain?",
        answered: false,
        createdAt: now - 4000,
      });
      const notHelpful = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Pricing?",
        reply: "See the Refund page.",
        answered: true,
        thumbsDown: true,
        createdAt: now - 3000,
      });
      const tool = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Where is my order?",
        answered: true,
        toolCalls: [{ callId: "c1", name: "lookup_order", kind: "mcp", ok: true }],
        createdAt: now - 2000,
      });
      const old = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Old question about refunds",
        answered: true,
        createdAt: now - 40 * DAY,
      });
      return {
        unanswered: unanswered.conversationId,
        notHelpful: notHelpful.conversationId,
        tool: tool.conversationId,
        old: old.conversationId,
      };
    }

    it("returns the flags each row shows and filters on them", async () => {
      const ast = await seedAssistant(ORG_A);
      const ids = await seedFour(ast);
      const app = appForOrg(ORG_A);
      const list = (query: string) =>
        getJson<ConversationsBody>(app, `/api/admin/assistants/${ast}/conversations${query}`);

      const all = await list("");
      expect(all.total).toBe(4);
      const byId = new Map(all.conversations.map((c) => [c.id, c]));
      expect(byId.get(ids.unanswered)).toMatchObject({
        hasUnanswered: true,
        hasNotHelpful: false,
        usedTool: false,
      });
      expect(byId.get(ids.notHelpful)).toMatchObject({
        hasUnanswered: false,
        hasNotHelpful: true,
        usedTool: false,
      });
      expect(byId.get(ids.tool)).toMatchObject({
        hasUnanswered: false,
        hasNotHelpful: false,
        usedTool: true,
      });
      expect(byId.get(ids.tool)?.lastMessageAt).toBeGreaterThan(Date.now() - 3000);

      const ids_ = (body: ConversationsBody) => body.conversations.map((c) => c.id);
      expect(ids_(await list("?filter=unanswered"))).toEqual([ids.unanswered]);
      expect(ids_(await list("?filter=not_helpful"))).toEqual([ids.notHelpful]);
      expect(ids_(await list("?filter=used_tool"))).toEqual([ids.tool]);
      const none = await list("?filter=unanswered,used_tool");
      expect(none).toMatchObject({ conversations: [], total: 0 });
      const recent = await list("?days=30");
      expect(recent.total).toBe(3);
      expect(ids_(recent)).not.toContain(ids.old);
    });

    it("searches questions and replies by text, ignoring case", async () => {
      const ast = await seedAssistant(ORG_A);
      const ids = await seedFour(ast);
      const app = appForOrg(ORG_A);

      const found = await getJson<ConversationsBody>(
        app,
        `/api/admin/assistants/${ast}/conversations?q=${encodeURIComponent("REFUND")}`,
      );
      expect(found.conversations.map((c) => c.id).sort()).toEqual([ids.notHelpful, ids.old].sort());
      expect(found.total).toBe(2);

      // Wildcards are text, not patterns.
      const literal = await getJson<ConversationsBody>(
        app,
        `/api/admin/assistants/${ast}/conversations?q=${encodeURIComponent("%")}`,
      );
      expect(literal.total).toBe(0);

      const combined = await getJson<ConversationsBody>(
        app,
        `/api/admin/assistants/${ast}/conversations?q=refund&days=30`,
      );
      expect(combined.conversations.map((c) => c.id)).toEqual([ids.notHelpful]);
    });

    it("finds non-ASCII text exactly and in any case", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      const now = Date.now();
      const conversations = conversationsFor(env.DB, ORG_A);
      const messages = messagesFor(env.DB, ORG_A);

      // A visitor question, written the way the chat route writes it.
      const asked = newId("cnv");
      await conversations.create({
        id: asked,
        assistantId: ast,
        visitorId: "vis_1",
        startedAt: now - 3000,
        pageUrl: "",
      });
      await messages.create({
        id: newId("msg"),
        conversationId: asked,
        role: "user",
        content: "Is the École course in Ålesund?",
        citations: [],
        toolCalls: null,
        tokensIn: 0,
        tokensOut: 0,
        answered: true,
        createdAt: now - 3000,
      });

      // A reply rewritten when a paused page action resumes.
      const resumed = newId("cnv");
      await conversations.create({
        id: resumed,
        assistantId: ast,
        visitorId: "vis_2",
        startedAt: now - 2000,
        pageUrl: "",
      });
      const question = newId("msg");
      await messages.create({
        id: question,
        conversationId: resumed,
        role: "user",
        content: "Opening hours?",
        citations: [],
        toolCalls: null,
        tokensIn: 0,
        tokensOut: 0,
        answered: true,
        createdAt: now - 2000,
      });
      const reply = newId("msg");
      await messages.create({
        id: reply,
        conversationId: resumed,
        role: "assistant",
        content: "One moment.",
        citations: [],
        toolCalls: [],
        tokensIn: 0,
        tokensOut: 0,
        answered: true,
        createdAt: now - 1999,
        replyTo: question,
        resumeContext: { step: 1 },
      });
      const claimed = await messages.claimPendingReply({
        conversationId: resumed,
        id: reply,
        claimToken: "claim_1",
        revision: 0,
        now,
        ttlMs: 60_000,
      });
      expect(claimed).toBe(true);
      const completed = await messages.completeReply({
        id: reply,
        claimToken: "claim_1",
        revision: 0,
        content: "ΩΜΈΓΑ opens at nine.",
        citations: [],
        toolCalls: [],
        resumeContext: null,
        tokensIn: 0,
        tokensOut: 0,
      });
      expect(completed).toBe(true);

      // A row written before `search_text` existed.
      const legacy = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Où est ZÜRICH?",
        answered: true,
        createdAt: now - 1000,
      });

      const search = async (q: string) =>
        (
          await getJson<ConversationsBody>(
            app,
            `/api/admin/assistants/${ast}/conversations?q=${encodeURIComponent(q)}`,
          )
        ).conversations.map((c) => c.id);

      for (const q of ["École", "école", "ÉCOLE", "ålesund", "ÅLESUND"]) {
        expect({ q, ids: await search(q) }).toEqual({ q, ids: [asked] });
      }
      // The same letter typed as e + combining accent.
      expect(await search("e\u0301cole")).toEqual([asked]);
      for (const q of ["ΩΜΈΓΑ", "ωμέγα", "Ωμέγα"]) {
        expect({ q, ids: await search(q) }).toEqual({ q, ids: [resumed] });
      }
      // The text before the reply resumed is gone from the search.
      expect(await search("one moment")).toEqual([]);
      // Older rows are folded before the search, so they match in any case too.
      for (const q of ["ZÜRICH", "zürich", "Zürich"]) {
        expect({ q, ids: await search(q) }).toEqual({ q, ids: [legacy.conversationId] });
      }
    });

    it("refuses unknown filters and dates instead of showing everything", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      // Names an object has by inheritance are not filters either.
      for (const query of [
        "?filter=spam",
        "?filter=constructor",
        "?filter=toString",
        "?filter=__proto__",
        "?filter=unanswered,hasOwnProperty",
        "?days=5",
        `?q=${"x".repeat(201)}`,
      ]) {
        const res = await call(app, "GET", `/api/admin/assistants/${ast}/conversations${query}`);
        expect({ query, status: res.status }).toEqual({ query, status: 400 });
      }
    });

    it("lists the conversations that asked a grouped question; its count is of asks", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      const now = Date.now();
      const asked = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Pricing?",
        answered: true,
        createdAt: now - 4000,
      });
      const askedAgain = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "  PRICING?  ",
        answered: true,
        createdAt: now - 3000,
      });
      // Asked a second time in the same conversation: one more ask, not one
      // more conversation.
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        conversationId: asked.conversationId,
        question: "pricing?",
        answered: true,
        createdAt: now - 3500,
      });
      // The phrase only in a reply, or inside a longer question: not this question.
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Hello",
        reply: "Ask me pricing? any time.",
        answered: true,
        createdAt: now - 2000,
      });
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Pricing? For teams",
        answered: true,
        createdAt: now - 1000,
      });
      // Another assistant's visitor asking the same.
      const other = await seedAssistant(ORG_A);
      await seedTurn({
        orgId: ORG_A,
        assistantId: other,
        question: "pricing?",
        answered: true,
        createdAt: now - 500,
      });

      const overview = await getJson<{ topQuestions: Array<{ question: string; count: number }> }>(
        app,
        `/api/admin/assistants/${ast}/overview`,
      );
      const top = overview.topQuestions.find((item) => item.question === "pricing?");
      // Overview and Reports count each time it was asked; the list has each
      // conversation once.
      expect(top?.count).toBe(3);

      const list = (query: string) =>
        getJson<ConversationsBody>(app, `/api/admin/assistants/${ast}/conversations${query}`);
      const byKey = await list(`?question=${encodeURIComponent("pricing?")}`);
      expect(byKey.total).toBe(2);
      expect(byKey.conversations.map((c) => c.id)).toEqual([
        askedAgain.conversationId,
        asked.conversationId,
      ]);
      // The text as a visitor typed it finds the same group.
      expect((await list(`?question=${encodeURIComponent(" Pricing? ")}`)).total).toBe(2);
      // It narrows with the other filters.
      expect((await list("?question=pricing%3F&q=again")).total).toBe(0);
      // The same words as a search find every conversation with them anywhere.
      expect((await list("?q=pricing%3F")).total).toBe(4);
      const tooLong = await call(
        app,
        "GET",
        `/api/admin/assistants/${ast}/conversations?question=${"x".repeat(MAX_CHAT_MESSAGE_LENGTH * 3 + 1)}`,
      );
      expect(tooLong.status).toBe(400);
    });

    it("finds a report question's conversations by when it was asked, not when they started", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      const now = Date.now();
      // Started 40 days ago, with the question asked in it today.
      const old = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Hello",
        answered: true,
        createdAt: now - 40 * DAY,
      });
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        conversationId: old.conversationId,
        question: "Pricing?",
        answered: true,
        createdAt: now - 1000,
      });
      // Asked 20 days ago, before the period, in a conversation that goes on
      // into it with another question.
      const earlier = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Pricing?",
        answered: true,
        createdAt: now - 20 * DAY,
      });
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        conversationId: earlier.conversationId,
        question: "Other?",
        answered: true,
        createdAt: now - 2000,
      });

      const report = await getJson<{
        from: string;
        to: string;
        topQuestions: Array<{ question: string; count: number }>;
      }>(app, `/api/admin/assistants/${ast}/report?days=7`);
      expect(report.topQuestions).toContainEqual({ question: "pricing?", count: 1 });

      const list = (query: string) =>
        getJson<ConversationsBody>(app, `/api/admin/assistants/${ast}/conversations${query}`);
      const link = `?question=pricing%3F&askedFrom=${report.from}&askedTo=${report.to}`;
      // The one conversation holding the ask the report counted.
      const drilled = await list(link);
      expect(drilled.conversations.map((c) => c.id)).toEqual([old.conversationId]);
      // The days a report covers are whole UTC days, to the last millisecond.
      expect(
        (
          await list(
            `?question=pricing%3F&askedFrom=${utcDay(now - 1000)}&askedTo=${utcDay(now - 1000)}`,
          )
        ).total,
      ).toBe(1);
      expect(
        (await list(`?question=pricing%3F&askedTo=${utcDay(now - 2 * DAY)}`)).conversations.map(
          (c) => c.id,
        ),
      ).toEqual([earlier.conversationId]);
      // "Started" stays its own filter, on when a conversation started.
      expect((await list(`${link}&days=7`)).total).toBe(0);
      expect((await list(`${link}&days=90`)).total).toBe(1);
      expect((await list("?question=pricing%3F&days=7")).total).toBe(0);
    });

    it("refuses an asked-in period that is not a day, is reversed, or has no question", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      for (const query of [
        "?question=pricing&askedFrom=2026-02-30",
        "?question=pricing&askedFrom=yesterday",
        "?question=pricing&askedTo=2026-11-1",
        "?question=pricing&askedFrom=2026-11-17&askedTo=2026-11-10",
        "?askedFrom=2026-11-10&askedTo=2026-11-16",
      ]) {
        const res = await call(app, "GET", `/api/admin/assistants/${ast}/conversations${query}`);
        expect({ query, status: res.status }).toEqual({ query, status: 400 });
      }
    });

    it("finds a long grouped question's conversations by the start its link sends", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      const now = Date.now();
      const start = "ё".repeat(QUESTION_LINK_LENGTH - 1);
      // Long questions that agree on the first characters a link carries.
      const long = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: `${start}a and then a lot more`,
        answered: true,
        createdAt: now - 3000,
      });
      const sameStart = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: `${start}a, put another way`,
        answered: true,
        createdAt: now - 2000,
      });
      // Shorter than a link's start: only found by its whole text.
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: start,
        answered: true,
        createdAt: now - 1000,
      });
      // Agrees until the last character of the start.
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: `${start}b and more`,
        answered: true,
        createdAt: now - 500,
      });

      const list = async (question: string) =>
        (
          await getJson<ConversationsBody>(
            app,
            `/api/admin/assistants/${ast}/conversations?question=${encodeURIComponent(question)}`,
          )
        ).conversations.map((c) => c.id);
      const link = toQuestionLink(normalizeQuestionText(`${start}a and then a lot more`));
      expect(Array.from(link)).toHaveLength(QUESTION_LINK_LENGTH);
      expect(await list(link)).toEqual([sameStart.conversationId, long.conversationId]);
      // The whole key still finds only its own conversations.
      expect(await list(`${start}a and then a lot more`)).toEqual([long.conversationId]);
      // Text shorter than a link's start is a whole question, not a start.
      expect(await list(start.slice(0, -10))).toEqual([]);

      // A cut that lands on a space keeps the next character, so trimming
      // what is sent leaves a start the list still reads as one.
      const spaced = `${"x".repeat(QUESTION_LINK_LENGTH - 1)} y and more`;
      const spacedTurn = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: spaced,
        answered: true,
        createdAt: now,
      });
      const spacedLink = toQuestionLink(normalizeQuestionText(spaced));
      expect(spacedLink.endsWith(" y")).toBe(true);
      expect(await list(spacedLink)).toEqual([spacedTurn.conversationId]);
    });

    it("never finds another org's conversations by search", async () => {
      const astA = await seedAssistant(ORG_A);
      const astB = await seedAssistant(ORG_B);
      await seedTurn({
        orgId: ORG_B,
        assistantId: astB,
        question: "Secret refund",
        answered: true,
        createdAt: Date.now(),
      });
      const body = await getJson<ConversationsBody>(
        appForOrg(ORG_A),
        `/api/admin/assistants/${astA}/conversations?q=refund`,
      );
      expect(body.total).toBe(0);
      const cross = await call(
        appForOrg(ORG_A),
        "GET",
        `/api/admin/assistants/${astB}/conversations?q=refund`,
      );
      expect(cross.status).toBe(404);
    });
  });

  describe("gaps", () => {
    it("lists only gaps without an answer when asked for open ones", async () => {
      const ast = await seedAssistant(ORG_A);
      const now = Date.now();
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Open?",
        answered: false,
        createdAt: now - 2000,
      });
      const handled = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Handled?",
        answered: false,
        createdAt: now - 1000,
      });
      const app = appForOrg(ORG_A);
      const write = await call(app, "POST", `/api/admin/assistants/${ast}/answers`, {
        question: "Handled?",
        answer: "Yes.",
        fromMessageId: handled.replyId,
      });
      expect(write.status).toBe(201);

      const all = await getJson<GapsBody>(app, `/api/admin/assistants/${ast}/gaps`);
      expect(all.total).toBe(2);
      const open = await getJson<GapsBody>(app, `/api/admin/assistants/${ast}/gaps?status=open`);
      expect(open).toMatchObject({ total: 1, gaps: [{ question: "open?", handled: false }] });
      expect(
        (await getJson<GapsBody>(app, `/api/admin/assistants/${ast}/gaps?status=`)).total,
      ).toBe(2);
    });

    it("refuses an unknown gaps status instead of listing every group", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      for (const status of ["opne", "OPEN", "closed", "all", "constructor"]) {
        const res = await call(app, "GET", `/api/admin/assistants/${ast}/gaps?status=${status}`);
        expect({ status, code: res.status }).toEqual({ status, code: 400 });
      }
    });

    it("lists an answered group again once it is asked after the answer, wherever gaps show", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      const first = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Do you ship?",
        answered: false,
        createdAt: Date.now() - 60_000,
      });
      const answer = async (fromMessageId: string) => {
        const res = await call(app, "POST", `/api/admin/assistants/${ast}/answers`, {
          question: "Do you ship?",
          answer: "Yes, everywhere.",
          fromMessageId,
        });
        expect(res.status).toBe(201);
      };
      const open = () => getJson<GapsBody>(app, `/api/admin/assistants/${ast}/gaps?status=open`);
      const all = () => getJson<GapsBody>(app, `/api/admin/assistants/${ast}/gaps`);
      const openGaps = async () =>
        (await getJson<OverviewBody>(app, `/api/admin/assistants/${ast}/overview`)).attention
          .openGaps;
      const unanswered = async () =>
        (
          await getJson<{ topGaps: Array<{ question: string; count: number }> }>(
            app,
            `/api/admin/assistants/${ast}/report?days=7`,
          )
        ).topGaps;

      await answer(first.replyId);
      expect((await open()).total).toBe(0);
      expect(await openGaps()).toBe(0);
      expect(await unanswered()).toEqual([]);
      expect((await all()).gaps).toMatchObject([{ question: "do you ship?", handled: true }]);

      // Asked again after the answer, and still not answered.
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "do you SHIP?",
        answered: false,
        createdAt: Date.now() + 5,
      });
      expect(await open()).toMatchObject({
        total: 1,
        gaps: [{ question: "do you ship?", times: 2, handled: false }],
      });
      expect(await openGaps()).toBe(1);
      expect(await unanswered()).toEqual([{ question: "do you ship?", count: 2, topic: null }]);
      expect((await all()).gaps).toMatchObject([{ question: "do you ship?", handled: false }]);

      // A new answer, even one written from the first ask again, covers both.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await answer(first.replyId);
      expect((await open()).total).toBe(0);
      expect(await openGaps()).toBe(0);
      expect(await unanswered()).toEqual([]);
    });

    it("closes a reopened group with an answer written from an ask before its dismissal", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      const first = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Do you ship?",
        answered: false,
        createdAt: Date.now() - 60_000,
      });
      const dismiss = await call(app, "POST", `/api/admin/assistants/${ast}/gaps/dismiss`, {
        question: "do you ship?",
      });
      expect(dismiss.status).toBe(200);
      // Asked again after the dismissal, and still not answered: open again.
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Do you ship?",
        answered: false,
        createdAt: Date.now() + 5,
      });
      const open = () => getJson<GapsBody>(app, `/api/admin/assistants/${ast}/gaps?status=open`);
      const all = () => getJson<GapsBody>(app, `/api/admin/assistants/${ast}/gaps`);
      const openGaps = async () =>
        (await getJson<OverviewBody>(app, `/api/admin/assistants/${ast}/overview`)).attention
          .openGaps;
      const unanswered = async () =>
        (
          await getJson<{ topGaps: Array<{ question: string; count: number }> }>(
            app,
            `/api/admin/assistants/${ast}/report?days=7`,
          )
        ).topGaps;
      expect(await open()).toMatchObject({ total: 1, gaps: [{ times: 1, handled: false }] });
      expect(await openGaps()).toBe(1);
      expect(await unanswered()).toEqual([{ question: "do you ship?", count: 1, topic: null }]);

      // The owner writes the answer from the first conversation, after the
      // second ask: it answers the group everywhere gaps show.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const res = await call(app, "POST", `/api/admin/assistants/${ast}/answers`, {
        question: "Do you ship?",
        answer: "Yes, everywhere.",
        fromMessageId: first.replyId,
      });
      expect(res.status).toBe(201);
      expect((await open()).total).toBe(0);
      expect(await openGaps()).toBe(0);
      expect(await unanswered()).toEqual([]);
      // Still listed under all gaps as handled, counting only the ask after
      // the dismissal.
      expect(await all()).toMatchObject({
        total: 1,
        gaps: [{ question: "do you ship?", times: 1, handled: true }],
      });
    });

    it("lists no group whose every ask was dismissed, even with an answer written from one", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      const asked = await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Do you ship?",
        answered: false,
        createdAt: Date.now() - 60_000,
      });
      await call(app, "POST", `/api/admin/assistants/${ast}/gaps/dismiss`, {
        question: "do you ship?",
      });
      const res = await call(app, "POST", `/api/admin/assistants/${ast}/answers`, {
        question: "Do you ship?",
        answer: "Yes, everywhere.",
        fromMessageId: asked.replyId,
      });
      expect(res.status).toBe(201);
      expect(await getJson<GapsBody>(app, `/api/admin/assistants/${ast}/gaps`)).toMatchObject({
        total: 0,
        gaps: [],
      });
    });

    it("leaves dismissed asks out of Reports' unanswered list, as Gaps does", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      const now = Date.now();
      for (const at of [now - 3000, now - 2000]) {
        await seedTurn({
          orgId: ORG_A,
          assistantId: ast,
          question: "Do you ship?",
          answered: false,
          createdAt: at,
        });
      }
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Other?",
        answered: false,
        createdAt: now - 1000,
      });
      const unanswered = async () =>
        (
          await getJson<{ topGaps: Array<{ question: string; count: number }> }>(
            app,
            `/api/admin/assistants/${ast}/report?days=7`,
          )
        ).topGaps;
      expect(await unanswered()).toEqual([
        { question: "do you ship?", count: 2, topic: null },
        { question: "other?", count: 1, topic: null },
      ]);

      await call(app, "POST", `/api/admin/assistants/${ast}/gaps/dismiss`, {
        question: "do you ship?",
      });
      expect(await unanswered()).toEqual([{ question: "other?", count: 1, topic: null }]);

      // Asked again after the dismissal: back, counting only the new ask.
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Do you ship?",
        answered: false,
        createdAt: Date.now() + 5,
      });
      expect(await unanswered()).toEqual([
        { question: "do you ship?", count: 1, topic: null },
        { question: "other?", count: 1, topic: null },
      ]);
      const gaps = await getJson<GapsBody>(app, `/api/admin/assistants/${ast}/gaps?status=open`);
      expect(gaps.gaps.map((g) => [g.question, g.times])).toEqual([
        ["do you ship?", 1],
        ["other?", 1],
      ]);
    });

    it("dismisses a group until the question is asked again, and undoes", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      const now = Date.now();
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Do you ship?",
        answered: false,
        createdAt: now - 2000,
      });
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "do you  SHIP?",
        answered: false,
        createdAt: now - 1000,
      });
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Other?",
        answered: false,
        createdAt: now - 500,
      });
      const list = () => getJson<GapsBody>(app, `/api/admin/assistants/${ast}/gaps?status=open`);
      expect((await list()).gaps.map((g) => [g.question, g.times])).toEqual([
        ["do you ship?", 2],
        ["other?", 1],
      ]);

      // The display text normalises to the same key.
      const dismiss = await call(app, "POST", `/api/admin/assistants/${ast}/gaps/dismiss`, {
        question: "  Do You Ship? ",
      });
      expect(dismiss.status).toBe(200);
      expect(await dismiss.json()).toEqual({ question: "do you ship?", dismissed: true });
      expect((await list()).gaps.map((g) => g.question)).toEqual(["other?"]);
      expect((await getJson<GapsBody>(app, `/api/admin/assistants/${ast}/gaps`)).total).toBe(1);

      const restore = await call(app, "POST", `/api/admin/assistants/${ast}/gaps/restore`, {
        question: "do you ship?",
      });
      expect(restore.status).toBe(200);
      expect((await list()).gaps.map((g) => [g.question, g.times])).toEqual([
        ["do you ship?", 2],
        ["other?", 1],
      ]);

      // Dismissed again, then asked again later: back, counting only the new ask.
      await call(app, "POST", `/api/admin/assistants/${ast}/gaps/dismiss`, {
        question: "do you ship?",
      });
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question: "Do you ship?",
        answered: false,
        createdAt: Date.now() + 60_000,
      });
      // Equal counts: the more recently asked group comes first.
      expect((await list()).gaps.map((g) => [g.question, g.times])).toEqual([
        ["do you ship?", 1],
        ["other?", 1],
      ]);
    });

    it("dismisses the longest question a visitor can ask, even once lowercasing lengthens it", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      // "İ" lowercases to two code units, so the key is twice the message.
      const question = "İ".repeat(MAX_CHAT_MESSAGE_LENGTH);
      await seedTurn({
        orgId: ORG_A,
        assistantId: ast,
        question,
        answered: false,
        createdAt: Date.now(),
      });
      const listed = await getJson<GapsBody>(app, `/api/admin/assistants/${ast}/gaps?status=open`);
      const key = listed.gaps[0]?.question ?? "";
      expect(key.length).toBe(MAX_CHAT_MESSAGE_LENGTH * 2);

      const dismiss = await call(app, "POST", `/api/admin/assistants/${ast}/gaps/dismiss`, {
        question: key,
      });
      expect(dismiss.status).toBe(200);
      expect(
        (await getJson<GapsBody>(app, `/api/admin/assistants/${ast}/gaps?status=open`)).total,
      ).toBe(0);
    });

    it("says a dismissal's question is too long rather than empty", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      const res = await call(app, "POST", `/api/admin/assistants/${ast}/gaps/dismiss`, {
        question: "a".repeat(MAX_CHAT_MESSAGE_LENGTH * 3 + 1),
      });
      expect(res.status).toBe(400);
      const body = JSON.stringify(await res.json());
      expect(body).toContain(`question: must be at most ${MAX_CHAT_MESSAGE_LENGTH * 3} characters`);
      expect(body).not.toContain("must not be empty");
    });

    it("refuses a dismissal without a question, and for another org's assistant", async () => {
      const astA = await seedAssistant(ORG_A);
      const astB = await seedAssistant(ORG_B);
      const app = appForOrg(ORG_A);
      expect(
        (await call(app, "POST", `/api/admin/assistants/${astA}/gaps/dismiss`, { question: "  " }))
          .status,
      ).toBe(400);
      expect(
        (await call(app, "POST", `/api/admin/assistants/${astA}/gaps/dismiss`, {})).status,
      ).toBe(400);
      expect(
        (await call(app, "POST", `/api/admin/assistants/${astB}/gaps/dismiss`, { question: "x" }))
          .status,
      ).toBe(404);
      expect(
        (await call(app, "POST", `/api/admin/assistants/${astB}/gaps/restore`, { question: "x" }))
          .status,
      ).toBe(404);
      const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM gap_dismissals").first<{
        n: number;
      }>();
      expect(rows?.n).toBe(0);
    });
  });
});
