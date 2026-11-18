import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { MAX_TOPICS_PER_ASSISTANT, newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { forPrincipal } from "../../src/db/tenant.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

const ORG_A = TEST_ORG_ID;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const DAY_MS = 86_400_000;
const NOW = Date.now();

function appForOrg(orgId: string) {
  return createTestApp({
    auth: {
      async authenticate() {
        return { orgId, userId: "owner", role: "owner" };
      },
    },
  });
}

function tenantFor(orgId: string) {
  return forPrincipal(env.DB, { orgId, userId: "owner", role: "owner" });
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
    .bind(id, orgId, `pk_${newId("ast").slice(4)}`, NOW)
    .run();
  return id;
}

async function seedConversation(orgId: string, assistantId: string): Promise<string> {
  const id = newId("cnv");
  await env.DB.prepare(
    `INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url)
     VALUES (?1, ?2, ?3, 'vis_1', ?4, '')`,
  )
    .bind(id, orgId, assistantId, NOW - 60 * DAY_MS)
    .run();
  return id;
}

/** One question and its reply. `answered: false` is a reply that found nothing. */
async function seedExchange(
  orgId: string,
  conversationId: string,
  question: string,
  options: { at?: number; answered?: boolean; outcome?: string | null } = {},
): Promise<{ questionId: string; replyId: string }> {
  const questionId = newId("msg");
  const replyId = newId("msg");
  const at = options.at ?? NOW - DAY_MS;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, question_key, created_at)
       VALUES (?1, ?2, ?3, 'user', ?4, '[]', 1, ?5, ?6)`,
    ).bind(questionId, orgId, conversationId, question, question.toLowerCase(), at),
    env.DB.prepare(
      `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, outcome, reply_to, created_at)
       VALUES (?1, ?2, ?3, 'assistant', 'reply', '[]', ?4, ?5, ?6, ?7)`,
    ).bind(
      replyId,
      orgId,
      conversationId,
      options.answered === false ? 0 : 1,
      options.outcome ?? null,
      questionId,
      at + 1,
    ),
  ]);
  return { questionId, replyId };
}

async function topicOf(questionId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT topic_id FROM messages WHERE id = ?1")
    .bind(questionId)
    .first<{ topic_id: string | null }>();
  return row?.topic_id ?? null;
}

describe("topics", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM topics"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM org_provider_settings"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  describe("the store", () => {
    it("finds an existing topic by name whatever its case or spacing", async () => {
      const ast = await seedAssistant(ORG_A);
      const topics = tenantFor(ORG_A).topics;
      const first = await topics.resolve(ast, "Opening hours");
      const again = await topics.resolve(ast, "opening   HOURS");
      expect(again.id).toBe(first.id);
      expect(again.name).toBe("Opening hours");
      expect(await topics.list(ast)).toHaveLength(1);
    });

    it("ends with one topic when two reviews propose the same new one at once", async () => {
      const ast = await seedAssistant(ORG_A);
      const topics = tenantFor(ORG_A).topics;
      const results = await Promise.all(
        Array.from({ length: 6 }, () => topics.resolve(ast, "Delivery times")),
      );
      expect(new Set(results.map((t) => t.id)).size).toBe(1);
      expect(await topics.list(ast)).toHaveLength(1);
    });

    it("caps an assistant at 40 topics, after which a new name becomes Other", async () => {
      const ast = await seedAssistant(ORG_A);
      const topics = tenantFor(ORG_A).topics;
      for (let i = 0; i < MAX_TOPICS_PER_ASSISTANT - 1; i++)
        await topics.resolve(ast, `Topic ${i}`);
      // Two new proposals at once with room for one: the cap still holds.
      const [a, b] = await Promise.all([
        topics.resolve(ast, "Brand new"),
        topics.resolve(ast, "Also new"),
      ]);
      const names = [a?.name, b?.name].sort();
      expect(names).toContain("Other");
      const list = await topics.list(ast);
      expect(list.filter((t) => t.name !== "Other")).toHaveLength(MAX_TOPICS_PER_ASSISTANT);
      expect(list).toHaveLength(MAX_TOPICS_PER_ASSISTANT + 1);
      // An existing one is still picked.
      expect((await topics.resolve(ast, "topic 3")).name).toBe("Topic 3");
      expect((await topics.resolve(ast, "Yet another")).name).toBe("Other");
    });

    it("does not let renaming Other grow the list past 40 topics", async () => {
      const ast = await seedAssistant(ORG_A);
      const topics = tenantFor(ORG_A).topics;
      for (let i = 0; i < MAX_TOPICS_PER_ASSISTANT; i++) await topics.resolve(ast, `Topic ${i}`);
      const other = await topics.resolve(ast, "One too many");
      expect(other.name).toBe("Other");

      // Full: "Other" cannot become an ordinary topic.
      expect(await topics.rename(ast, other.id, "Fresh name")).toBe("full");
      expect((await topics.get(ast, other.id))?.name).toBe("Other");
      // A change of case only keeps it "Other", and ordinary topics still rename.
      expect(await topics.rename(ast, other.id, "OTHER")).toBe("renamed");
      const first = (await topics.list(ast)).find((t) => t.name === "Topic 0");
      expect(await topics.rename(ast, first?.id ?? "", "Topic zero")).toBe("renamed");
      // The next unmatched proposal still lands in the same "Other".
      expect((await topics.resolve(ast, "Another new one")).id).toBe(other.id);
      let list = await topics.list(ast);
      expect(list).toHaveLength(MAX_TOPICS_PER_ASSISTANT + 1);

      // With room for one, the rename goes through, and the next unmatched
      // proposal gets a new "Other" without passing the cap.
      await topics.remove(ast, first?.id ?? "");
      expect(await topics.rename(ast, other.id, "Fresh name")).toBe("renamed");
      const next = await topics.resolve(ast, "Yet another new one");
      expect(next.name).toBe("Other");
      expect(next.id).not.toBe(other.id);
      expect(await topics.rename(ast, next.id, "Second fresh")).toBe("full");
      list = await topics.list(ast);
      expect(list.filter((t) => t.name !== "Other")).toHaveLength(MAX_TOPICS_PER_ASSISTANT);
      expect(list).toHaveLength(MAX_TOPICS_PER_ASSISTANT + 1);
    });

    it("keeps the cap when renaming Other races a new proposal", async () => {
      const ast = await seedAssistant(ORG_A);
      const topics = tenantFor(ORG_A).topics;
      for (let i = 0; i < MAX_TOPICS_PER_ASSISTANT - 1; i++)
        await topics.resolve(ast, `Topic ${i}`);
      const other = await topics.resolve(ast, "Other");
      // One place left: the rename and a new proposal compete for it.
      const [renamed, proposed] = await Promise.all([
        topics.rename(ast, other.id, "Fresh name"),
        topics.resolve(ast, "Brand new"),
      ]);
      expect(["renamed", "full"]).toContain(renamed);
      expect(proposed.name === "Other" || renamed === "full").toBe(true);
      const list = await topics.list(ast);
      expect(list.filter((t) => t.name !== "Other")).toHaveLength(MAX_TOPICS_PER_ASSISTANT);
    });

    it("keeps topic names per assistant and per org", async () => {
      const astA = await seedAssistant(ORG_A);
      const astA2 = await seedAssistant(ORG_A);
      const astB = await seedAssistant(ORG_B);
      const a = await tenantFor(ORG_A).topics.resolve(astA, "Refunds");
      const a2 = await tenantFor(ORG_A).topics.resolve(astA2, "Refunds");
      const b = await tenantFor(ORG_B).topics.resolve(astB, "Refunds");
      expect(new Set([a.id, a2.id, b.id]).size).toBe(3);
      expect(await tenantFor(ORG_B).topics.list(astA)).toEqual([]);
      expect(await tenantFor(ORG_B).topics.get(astB, a.id)).toBeNull();
      expect(await tenantFor(ORG_A).topics.get(astA2, a.id)).toBeNull();
    });

    it("tags a question once, and never with another assistant's or org's topic", async () => {
      const astA = await seedAssistant(ORG_A);
      const astA2 = await seedAssistant(ORG_A);
      const astB = await seedAssistant(ORG_B);
      const conv = await seedConversation(ORG_A, astA);
      const { questionId, replyId } = await seedExchange(ORG_A, conv, "Refund?");
      const other = await tenantFor(ORG_A).topics.resolve(astA2, "Refunds");
      const foreign = await tenantFor(ORG_B).topics.resolve(astB, "Refunds");
      const mine = await tenantFor(ORG_A).topics.resolve(astA, "Refunds");

      expect(await tenantFor(ORG_A).topics.assignToQuestion(questionId, other.id)).toBe(false);
      expect(await tenantFor(ORG_A).topics.assignToQuestion(questionId, foreign.id)).toBe(false);
      expect(await tenantFor(ORG_B).topics.assignToQuestion(questionId, foreign.id)).toBe(false);
      expect(await tenantFor(ORG_A).topics.assignToQuestion(replyId, mine.id)).toBe(false);
      expect(await topicOf(questionId)).toBeNull();

      expect(await tenantFor(ORG_A).topics.assignToQuestion(questionId, mine.id)).toBe(true);
      const second = await tenantFor(ORG_A).topics.resolve(astA, "Prices");
      expect(await tenantFor(ORG_A).topics.assignToQuestion(questionId, second.id)).toBe(false);
      expect(await topicOf(questionId)).toBe(mine.id);
    });

    it("deletes an assistant's topics with it", async () => {
      const ast = await seedAssistant(ORG_A);
      await tenantFor(ORG_A).topics.resolve(ast, "Refunds");
      await env.DB.prepare("DELETE FROM assistants WHERE id = ?1").bind(ast).run();
      const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM topics").first<{ n: number }>();
      expect(left?.n).toBe(0);
    });
  });

  describe("managing topics", () => {
    async function setup() {
      const ast = await seedAssistant(ORG_A);
      const conv = await seedConversation(ORG_A, ast);
      const topics = tenantFor(ORG_A).topics;
      const hours = await topics.resolve(ast, "Opening hours");
      const times = await topics.resolve(ast, "When open");
      const q1 = await seedExchange(ORG_A, conv, "When are you open?");
      const q2 = await seedExchange(ORG_A, conv, "Opening hours?");
      await topics.assignToQuestion(q1.questionId, times.id);
      await topics.assignToQuestion(q2.questionId, hours.id);
      return { ast, conv, hours, times, q1, q2, app: appForOrg(ORG_A) };
    }

    it("lists the assistant's topics and the Review answers switch", async () => {
      const { ast, app } = await setup();
      const res = await call(app, "GET", `/api/admin/assistants/${ast}/topics`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        topics: Array<{ name: string }>;
        reviewAnswers: boolean;
      };
      expect(body.topics.map((t) => t.name)).toEqual(["Opening hours", "When open"]);
      expect(body.reviewAnswers).toBe(true);
      await tenantFor(ORG_A).providerSettings.upsert({ reviewAnswers: false });
      const off = (await (
        await call(app, "GET", `/api/admin/assistants/${ast}/topics`)
      ).json()) as {
        reviewAnswers: boolean;
      };
      expect(off.reviewAnswers).toBe(false);
    });

    it("renames a topic, and refuses a name taken or unsafe", async () => {
      const { ast, hours, times, q2, app } = await setup();
      const path = `/api/admin/assistants/${ast}/topics/${hours.id}`;
      const res = await call(app, "PATCH", path, { name: "  <b>Hours</b> " });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { topic: { name: string } }).topic.name).toBe("Hours");
      expect(await topicOf(q2.questionId)).toBe(hours.id);

      expect((await call(app, "PATCH", path, { name: "when OPEN" })).status).toBe(409);
      for (const name of ["jane@example.com", "Call 0161 496 0000", "", "x".repeat(41)]) {
        expect((await call(app, "PATCH", path, { name })).status, name).toBe(400);
      }
      // A change of case is a rename of the same topic.
      expect((await call(app, "PATCH", path, { name: "HOURS" })).status).toBe(200);
      expect((await tenantFor(ORG_A).topics.get(ast, times.id))?.name).toBe("When open");
    });

    it("refuses to rename Other while the list is full", async () => {
      const { ast, app } = await setup();
      const topics = tenantFor(ORG_A).topics;
      for (let i = 2; i < MAX_TOPICS_PER_ASSISTANT; i++) await topics.resolve(ast, `Topic ${i}`);
      const other = await topics.resolve(ast, "One too many");
      expect(other.name).toBe("Other");
      const res = await call(app, "PATCH", `/api/admin/assistants/${ast}/topics/${other.id}`, {
        name: "Fresh name",
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/Merge or delete one/);
      expect((await topics.get(ast, other.id))?.name).toBe("Other");
    });

    it("merges one topic into another: all its questions move and it is gone", async () => {
      const { ast, hours, times, q1, q2, app } = await setup();
      const res = await call(app, "POST", `/api/admin/assistants/${ast}/topics/${times.id}/merge`, {
        into: hours.id,
      });
      expect(res.status).toBe(200);
      expect(await topicOf(q1.questionId)).toBe(hours.id);
      expect(await topicOf(q2.questionId)).toBe(hours.id);
      expect((await tenantFor(ORG_A).topics.list(ast)).map((t) => t.name)).toEqual([
        "Opening hours",
      ]);
      // Into itself, or into a topic that is gone, is refused.
      expect(
        (
          await call(app, "POST", `/api/admin/assistants/${ast}/topics/${hours.id}/merge`, {
            into: hours.id,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call(app, "POST", `/api/admin/assistants/${ast}/topics/${hours.id}/merge`, {
            into: times.id,
          })
        ).status,
      ).toBe(404);
    });

    it("deletes a topic: its questions become untagged", async () => {
      const { ast, hours, times, q1, q2, app } = await setup();
      const res = await call(app, "DELETE", `/api/admin/assistants/${ast}/topics/${times.id}`);
      expect(res.status).toBe(200);
      expect(await topicOf(q1.questionId)).toBeNull();
      expect(await topicOf(q2.questionId)).toBe(hours.id);
      expect(
        (await call(app, "DELETE", `/api/admin/assistants/${ast}/topics/${times.id}`)).status,
      ).toBe(404);
    });

    it("cannot reach another org's or assistant's topics", async () => {
      const { ast, hours, times, q1 } = await setup();
      const otherAst = await seedAssistant(ORG_A);
      const appB = appForOrg(ORG_B);
      const astB = await seedAssistant(ORG_B);
      const topicB = await tenantFor(ORG_B).topics.resolve(astB, "Theirs");
      const a = appForOrg(ORG_A);

      expect((await call(appB, "GET", `/api/admin/assistants/${ast}/topics`)).status).toBe(404);
      for (const [app, assistant, topic] of [
        [appB, ast, hours.id],
        [appB, astB, hours.id],
        [a, otherAst, hours.id],
      ] as const) {
        const base = `/api/admin/assistants/${assistant}/topics/${topic}`;
        expect((await call(app, "PATCH", base, { name: "Mine now" })).status).toBe(404);
        expect((await call(app, "DELETE", base)).status).toBe(404);
        expect((await call(app, "POST", `${base}/merge`, { into: times.id })).status).toBe(404);
      }
      // Merging into another org's topic is refused too.
      expect(
        (
          await call(a, "POST", `/api/admin/assistants/${ast}/topics/${times.id}/merge`, {
            into: topicB.id,
          })
        ).status,
      ).toBe(404);
      expect(await topicOf(q1.questionId)).toBe(times.id);
      expect((await tenantFor(ORG_A).topics.get(ast, hours.id))?.name).toBe("Opening hours");
    });
  });

  describe("reports and the Conversations filter", () => {
    it("lists the period's topics by volume with the share that could not be answered", async () => {
      const ast = await seedAssistant(ORG_A);
      const conv = await seedConversation(ORG_A, ast);
      const topics = tenantFor(ORG_A).topics;
      const hours = await topics.resolve(ast, "Opening hours");
      const refunds = await topics.resolve(ast, "Refunds");
      const tag = async (q: { questionId: string }, id: string) =>
        topics.assignToQuestion(q.questionId, id);
      await tag(await seedExchange(ORG_A, conv, "open?", { outcome: "answered" }), hours.id);
      await tag(await seedExchange(ORG_A, conv, "hours?", { outcome: "declined" }), hours.id);
      await tag(
        await seedExchange(ORG_A, conv, "open sunday?", { answered: false, outcome: "declined" }),
        hours.id,
      );
      await tag(await seedExchange(ORG_A, conv, "refund?", { outcome: "partial" }), refunds.id);
      // Out of the period, and another org: not counted.
      await tag(
        await seedExchange(ORG_A, conv, "old refund?", { at: NOW - 40 * DAY_MS }),
        refunds.id,
      );
      const astB = await seedAssistant(ORG_B);
      const convB = await seedConversation(ORG_B, astB);
      const topicB = await tenantFor(ORG_B).topics.resolve(astB, "Opening hours");
      await tenantFor(ORG_B).topics.assignToQuestion(
        (await seedExchange(ORG_B, convB, "open?")).questionId,
        topicB.id,
      );

      const res = await call(
        appForOrg(ORG_A),
        "GET",
        `/api/admin/assistants/${ast}/report?days=30`,
      );
      const report = (await res.json()) as {
        topics: { reviewAnswers: boolean; rows: unknown[] };
        topGaps: Array<{ question: string; topic: { id: string; name: string } | null }>;
      };
      expect(report.topics).toEqual({
        reviewAnswers: true,
        rows: [
          {
            id: hours.id,
            name: "Opening hours",
            questions: 3,
            unanswered: 2,
            unansweredShare: 2 / 3,
          },
          { id: refunds.id, name: "Refunds", questions: 1, unanswered: 0, unansweredShare: 0 },
        ],
      });
      // "Most often unanswered" names each group's topic.
      expect(report.topGaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            question: "hours?",
            topic: { id: hours.id, name: "Opening hours" },
          }),
        ]),
      );
      expect(report.topGaps.every((g) => g.topic?.id === hours.id)).toBe(true);
    });

    it("says topics are off when Review answers is off", async () => {
      const ast = await seedAssistant(ORG_A);
      await tenantFor(ORG_A).providerSettings.upsert({ reviewAnswers: false });
      const res = await call(appForOrg(ORG_A), "GET", `/api/admin/assistants/${ast}/report`);
      const report = (await res.json()) as { topics: unknown };
      expect(report.topics).toEqual({ reviewAnswers: false, rows: [] });
    });

    it("filters Conversations to a topic, within the asked days when given", async () => {
      const ast = await seedAssistant(ORG_A);
      const topics = tenantFor(ORG_A).topics;
      const hours = await topics.resolve(ast, "Opening hours");
      const convIn = await seedConversation(ORG_A, ast);
      const convOld = await seedConversation(ORG_A, ast);
      const convNone = await seedConversation(ORG_A, ast);
      await topics.assignToQuestion(
        (await seedExchange(ORG_A, convIn, "open?")).questionId,
        hours.id,
      );
      await topics.assignToQuestion(
        (await seedExchange(ORG_A, convOld, "open?", { at: NOW - 20 * DAY_MS })).questionId,
        hours.id,
      );
      await seedExchange(ORG_A, convNone, "refund?");
      const app = appForOrg(ORG_A);
      const list = async (query: string) => {
        const res = await call(app, "GET", `/api/admin/assistants/${ast}/conversations?${query}`);
        return res;
      };
      const ids = async (query: string) =>
        (
          (await (await list(query)).json()) as { conversations: Array<{ id: string }> }
        ).conversations
          .map((c) => c.id)
          .sort();

      expect(await ids(`topic=${hours.id}`)).toEqual([convIn, convOld].sort());
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      expect(
        await ids(`topic=${hours.id}&askedFrom=${day(NOW - 7 * DAY_MS)}&askedTo=${day(NOW)}`),
      ).toEqual([convIn]);
      expect((await list("topic=opening%20hours")).status).toBe(400);
      // Another org's topic id finds nothing here.
      const astB = await seedAssistant(ORG_B);
      const topicB = await tenantFor(ORG_B).topics.resolve(astB, "Opening hours");
      expect(await ids(`topic=${topicB.id}`)).toEqual([]);
    });
  });
});
