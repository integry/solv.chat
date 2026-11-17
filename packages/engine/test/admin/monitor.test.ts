import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { defaultVersionConfig, newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { NOT_INDEXED_AFTER_MS } from "../../src/admin/overview.js";
import { normalizeQuestionText } from "../../src/db/messages.js";
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
  options: { indexed: boolean; updatedAt: number },
): Promise<string> {
  const id = newId("doc");
  await env.DB.prepare(
    `INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, indexed_hash, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'Page', 'hash_1', ?6, ?7)`,
  )
    .bind(
      id,
      orgId,
      sourceId,
      id,
      `https://docs.example.com/${id}`,
      options.indexed ? "hash_1" : null,
      options.updatedAt,
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
    notIndexed: Array<{ sourceId: string; label: string; documents: number }>;
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
        notIndexed: [{ sourceId: docs, label: "Docs", documents: 2 }],
      });
      // A test run goes through the same pipeline as Try it.
      expect(body.setup.tried).toBe(true);
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

    it("refuses unknown filters and dates instead of showing everything", async () => {
      const ast = await seedAssistant(ORG_A);
      const app = appForOrg(ORG_A);
      for (const query of ["?filter=spam", "?days=5", `?q=${"x".repeat(201)}`]) {
        const res = await call(app, "GET", `/api/admin/assistants/${ast}/conversations${query}`);
        expect({ query, status: res.status }).toEqual({ query, status: 400 });
      }
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
