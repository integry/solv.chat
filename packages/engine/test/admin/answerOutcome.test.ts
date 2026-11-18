import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { type AnswerOutcome, newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { listGaps } from "../../src/admin/gaps.js";
import { overviewFor } from "../../src/admin/overview.js";
import { reportFor } from "../../src/admin/reports.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

const ORG_A = TEST_ORG_ID;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const FIXED_NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

function tenantFor(orgId: string) {
  return forPrincipal(env.DB, { orgId, userId: "owner", role: "owner" });
}

function appForOrg(orgId: string) {
  return createTestApp({
    auth: {
      async authenticate() {
        return { orgId, userId: "owner", role: "owner" };
      },
    },
  });
}

async function call(app: ReturnType<typeof createTestApp>, path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://example.com${path}`, {
      ...init,
      headers: { "content-type": "application/json", origin: "https://example.com" },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedAssistant(orgId: string): Promise<string> {
  const id = newId("ast");
  await env.DB.prepare(
    `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at)
     VALUES (?1, ?2, 'Docs Bot', ?3, '[]', ?4)`,
  )
    .bind(id, orgId, `pk_${newId("ast").slice(4)}`, FIXED_NOW)
    .run();
  return id;
}

/**
 * One question and its reply in a conversation of its own. `answered` is the
 * retrieval decision; `outcome` the review's, or undefined for an unreviewed
 * reply.
 */
async function seedTurn(params: {
  orgId: string;
  assistantId: string;
  question: string;
  answered: boolean;
  outcome?: AnswerOutcome;
  at?: number;
}): Promise<{ conversationId: string; questionId: string; replyId: string }> {
  const tenant = tenantFor(params.orgId);
  const at = params.at ?? FIXED_NOW - 60_000;
  const conversationId = newId("cnv");
  await tenant.conversations.create({
    id: conversationId,
    assistantId: params.assistantId,
    visitorId: "vis_1",
    startedAt: at,
    pageUrl: "",
  });
  const questionId = newId("msg");
  await tenant.messages.create({
    id: questionId,
    conversationId,
    role: "user",
    content: params.question,
    citations: [],
    toolCalls: null,
    tokensIn: 0,
    tokensOut: 0,
    answered: true,
    createdAt: at,
  });
  const replyId = newId("msg");
  await tenant.messages.create({
    id: replyId,
    conversationId,
    role: "assistant",
    content: params.answered ? "Here is something." : "I could not find that.",
    citations: [],
    toolCalls: null,
    tokensIn: 0,
    tokensOut: 0,
    answered: params.answered,
    createdAt: at + 1,
    replyTo: questionId,
  });
  if (params.outcome !== undefined) {
    expect(await tenant.messages.setOutcome(replyId, params.outcome, null)).toBe(true);
  }
  return { conversationId, questionId, replyId };
}

describe("answer outcome in the admin", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM usage_daily"),
      env.DB.prepare("DELETE FROM gap_dismissals"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM org_provider_settings"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  it("counts answered share from outcomes, partial as half, off topic left out, and unreviewed replies as before", async () => {
    const ast = await seedAssistant(ORG_A);
    // Reviewed: 1 + 0.5 + 0 (declined) + 0 (declined miss) + 0 (person, a
    // miss); the two off-topic replies (one a miss) are not counted at all.
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "a",
      answered: true,
      outcome: "answered",
    });
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "b",
      answered: true,
      outcome: "partial",
    });
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "c",
      answered: true,
      outcome: "declined",
    });
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "d",
      answered: true,
      outcome: "off_topic",
    });
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "e",
      answered: false,
      outcome: "declined",
    });
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "h",
      answered: false,
      outcome: "off_topic",
    });
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "i",
      answered: false,
      outcome: "wants_human",
    });
    // Unreviewed: today's rule, 1 + 0.
    await seedTurn({ orgId: ORG_A, assistantId: ast, question: "f", answered: true });
    await seedTurn({ orgId: ORG_A, assistantId: ast, question: "g", answered: false });

    // 9 replies, 7 of them not off topic, 2.5 answered.
    const report = await reportFor(tenantFor(ORG_A), ast, 30, FIXED_NOW);
    expect(report.replies).toBe(9);
    expect(report.answeredShare).toBeCloseTo(2.5 / 7);
    const overview = await overviewFor(tenantFor(ORG_A), ast, { at: FIXED_NOW });
    expect(overview.period.answeredShare).toBeCloseTo(2.5 / 7);
  });

  it("gives an answered share of 0, not a division by zero, when every reply was off topic", async () => {
    const ast = await seedAssistant(ORG_A);
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "Weather?",
      answered: false,
      outcome: "off_topic",
    });
    const report = await reportFor(tenantFor(ORG_A), ast, 30, FIXED_NOW);
    expect(report.replies).toBe(1);
    expect(report.answeredShare).toBe(0);
  });

  it("reads unreviewed data exactly as before", async () => {
    const ast = await seedAssistant(ORG_A);
    await seedTurn({ orgId: ORG_A, assistantId: ast, question: "a", answered: true });
    await seedTurn({ orgId: ORG_A, assistantId: ast, question: "b", answered: true });
    await seedTurn({ orgId: ORG_A, assistantId: ast, question: "c", answered: false });
    const report = await reportFor(tenantFor(ORG_A), ast, 30, FIXED_NOW);
    expect(report.answeredShare).toBeCloseTo(2 / 3);
    expect(report.topGaps).toEqual([{ question: "c", count: 1, topic: null }]);
  });

  it("lists declined replies in Gaps beside retrieval misses, labelled by which they were", async () => {
    const ast = await seedAssistant(ORG_A);
    const at = FIXED_NOW - 600_000;
    // Retrieval miss, reviewed (marked declined) and not.
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "Do you ship to Spain?",
      answered: false,
      outcome: "declined",
      at,
    });
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "Do you ship to Spain?",
      answered: false,
      at: at + 10,
    });
    // Had content, still declined.
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "Do you ship to Spain?",
      answered: true,
      outcome: "declined",
      at: at + 20,
    });
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "What is the refund window?",
      answered: true,
      outcome: "declined",
      at: at + 30,
    });
    // Not gaps: answered, partial, unreviewed with content, a person, off
    // topic, and retrieval misses reviewed as a person or off topic.
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "I want to speak to a real person about a complaint",
      answered: false,
      outcome: "wants_human",
    });
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "What is the capital of Australia?",
      answered: false,
      outcome: "off_topic",
    });
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "Price?",
      answered: true,
      outcome: "answered",
    });
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "Hours?",
      answered: true,
      outcome: "partial",
    });
    await seedTurn({ orgId: ORG_A, assistantId: ast, question: "Plans?", answered: true });
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "Call me",
      answered: true,
      outcome: "wants_human",
    });
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "Weather?",
      answered: true,
      outcome: "off_topic",
    });

    const page = await listGaps(tenantFor(ORG_A), ast, { openOnly: true });
    expect(page.total).toBe(2);
    expect(page.gaps.map((g) => [g.question, g.times, g.noContentTimes, g.declinedTimes])).toEqual([
      ["do you ship to spain?", 3, 2, 1],
      ["what is the refund window?", 1, 0, 1],
    ]);

    const report = await reportFor(tenantFor(ORG_A), ast, 30, FIXED_NOW);
    expect(report.topGaps).toEqual([
      { question: "do you ship to spain?", count: 3, topic: null },
      { question: "what is the refund window?", count: 1, topic: null },
    ]);
    const overview = await overviewFor(tenantFor(ORG_A), ast, { at: FIXED_NOW });
    expect(overview.attention.openGaps).toBe(2);
  });

  it("keeps each org's outcomes to itself", async () => {
    const astA = await seedAssistant(ORG_A);
    const astB = await seedAssistant(ORG_B);
    const a = await seedTurn({ orgId: ORG_A, assistantId: astA, question: "A?", answered: true });
    await seedTurn({
      orgId: ORG_B,
      assistantId: astB,
      question: "B?",
      answered: true,
      outcome: "declined",
    });

    // Org B cannot write an outcome on org A's reply.
    expect(await tenantFor(ORG_B).messages.setOutcome(a.replyId, "declined", null)).toBe(false);
    expect((await tenantFor(ORG_A).messages.get(a.replyId))?.outcome).toBeNull();
    // An outcome is written once and only on a reply.
    expect(await tenantFor(ORG_A).messages.setOutcome(a.questionId, "declined", null)).toBe(false);
    expect(await tenantFor(ORG_A).messages.setOutcome(a.replyId, "answered", null)).toBe(true);
    expect(await tenantFor(ORG_A).messages.setOutcome(a.replyId, "declined", null)).toBe(false);

    expect((await listGaps(tenantFor(ORG_A), astA)).gaps).toEqual([]);
    expect((await listGaps(tenantFor(ORG_B), astB)).gaps).toHaveLength(1);
    const appA = appForOrg(ORG_A);
    const res = await call(
      appA,
      `/api/admin/assistants/${astA}/conversations?filter=could_not_answer`,
    );
    expect(((await res.json()) as { total: number }).total).toBe(0);
  });

  it("filters conversations by 'could not answer', 'asked for a person' and 'off topic', and shows the outcome per reply", async () => {
    const ast = await seedAssistant(ORG_A);
    const declined = await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "x",
      answered: true,
      outcome: "declined",
    });
    const person = await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "y",
      answered: true,
      outcome: "wants_human",
    });
    await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "z",
      answered: true,
      outcome: "answered",
    });
    await seedTurn({ orgId: ORG_A, assistantId: ast, question: "w", answered: false });
    // Retrieval misses: the most common way a visitor asks for a person.
    const personMiss = await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "Can someone call me?",
      answered: false,
      outcome: "wants_human",
    });
    const offTopicMiss = await seedTurn({
      orgId: ORG_A,
      assistantId: ast,
      question: "Capital of Australia?",
      answered: false,
      outcome: "off_topic",
    });
    const app = appForOrg(ORG_A);

    const list = async (filter: string) => {
      const res = await call(app, `/api/admin/assistants/${ast}/conversations?filter=${filter}`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { conversations: Array<{ id: string }> }).conversations.map(
        (c) => c.id,
      );
    };
    expect(await list("could_not_answer")).toEqual([declined.conversationId]);
    expect((await list("asked_for_person")).sort()).toEqual(
      [person.conversationId, personMiss.conversationId].sort(),
    );
    expect(await list("off_topic")).toEqual([offTopicMiss.conversationId]);
    expect(await list("could_not_answer,asked_for_person")).toEqual([]);
    expect(await list("off_topic,asked_for_person")).toEqual([]);
    expect(
      (await call(app, `/api/admin/assistants/${ast}/conversations?filter=declined`)).status,
    ).toBe(400);

    const detail = await call(app, `/api/admin/conversations/${declined.conversationId}`);
    const body = (await detail.json()) as {
      turns: Array<{ role: string; outcome: AnswerOutcome | null }>;
    };
    expect(body.turns.map((t) => [t.role, t.outcome])).toEqual([
      ["user", null],
      ["assistant", "declined"],
    ]);
  });

  it("stores the 'Review answers' switch, on by default, with null restoring the default", async () => {
    const app = appForOrg(ORG_A);
    const read = async (res: Response) =>
      ((await res.json()) as { settings: { reviewAnswers: { value: boolean; source: string } } })
        .settings.reviewAnswers;

    expect(await read(await call(app, "/api/admin/providers"))).toEqual({
      value: true,
      source: "none",
    });
    const off = await call(app, "/api/admin/providers", {
      method: "PUT",
      body: JSON.stringify({ reviewAnswers: false }),
    });
    expect(off.status).toBe(200);
    expect(await read(off)).toEqual({ value: false, source: "stored" });
    // Other settings saved later leave it alone.
    await call(app, "/api/admin/providers", {
      method: "PUT",
      body: JSON.stringify({ llmTier: "balanced" }),
    });
    expect(await read(await call(app, "/api/admin/providers"))).toEqual({
      value: false,
      source: "stored",
    });
    // Org B is unaffected.
    expect(await read(await call(appForOrg(ORG_B), "/api/admin/providers"))).toEqual({
      value: true,
      source: "none",
    });
    const reset = await call(app, "/api/admin/providers", {
      method: "PUT",
      body: JSON.stringify({ reviewAnswers: null }),
    });
    expect(await read(reset)).toEqual({ value: true, source: "none" });
    const bad = await call(app, "/api/admin/providers", {
      method: "PUT",
      body: JSON.stringify({ reviewAnswers: "yes" }),
    });
    expect(bad.status).toBe(400);
  });
});
