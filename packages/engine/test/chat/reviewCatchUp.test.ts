import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { defaultVersionConfig } from "@solvchat/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { REVIEW_FRAME } from "../../src/chat/review.js";
import {
  MAX_REVIEW_CATCH_UP_PER_TICK,
  REVIEW_CATCH_UP_MIN_AGE_MS,
  REVIEW_CATCH_UP_WINDOW_MS,
} from "../../src/chat/reviewCatchUp.js";
import type { ChatRouteOverrides } from "../../src/chat/route.js";
import { forPrincipal } from "../../src/db/tenant.js";
import type { LimitAction, UsageEvent } from "../../src/seams/types.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const QUESTION = "VISITOR_TEXT_MARKER how do refunds work?";
const REPLY = "You can ask for a refund within 30 days.";
/** What a failing provider puts in its error body: must never be stored or shown. */
const PROVIDER_TEXT = "PROVIDER_TEXT_MARKER overloaded";

type ReviewReply = { status: number; text?: string } | "hang";

/**
 * The real Anthropic provider over a fake network, for review requests only:
 * each call takes the next scripted reply (the last one repeats). Every
 * request is recorded.
 */
function reviewFetch(replies: ReviewReply[], seen: string[] = []): typeof fetch {
  let call = 0;
  return async (_input, init) => {
    const raw = String(init?.body ?? "{}");
    const body = JSON.parse(raw) as { system: string };
    seen.push(raw);
    if (body.system !== REVIEW_FRAME) throw new Error("only review requests are expected here");
    const reply = replies[Math.min(call, replies.length - 1)] ?? { status: 200, text: "" };
    call++;
    if (reply === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    if (reply.status !== 200) {
      return new Response(JSON.stringify({ error: { message: PROVIDER_TEXT } }), {
        status: reply.status,
      });
    }
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":90}}}\n\n',
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: reply.text ?? "" } })}\n\n`,
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

const ok = (label: string, topic = "Refunds"): ReviewReply => ({
  status: 200,
  text: `outcome: ${label}\ntopic: ${topic}`,
});

function tenantFor(orgId: string) {
  return forPrincipal(env.DB, { orgId, userId: "owner", role: "owner" });
}

async function seedAssistant(orgId: string, id: string): Promise<void> {
  const tenant = tenantFor(orgId);
  await tenant.assistants.create({
    id,
    name: "Docs Bot",
    publicKey: `pk_${id}`,
    allowedOrigins: ["https://site.example"],
    createdAt: 1000,
  });
  const draft = await tenant.versions.createDraft({
    id: `${id}_v1`,
    assistantId: id,
    config: defaultVersionConfig(),
    createdAt: 1000,
  });
  await tenant.versions.publishDraft(id, draft.id, `${id}_v2`, 2000);
}

let seq = 0;

/** A visitor question and its stored reply, written `ageMs` before `NOW`, with no outcome. */
async function seedReply(params: {
  orgId?: string;
  assistantId?: string;
  ageMs?: number;
  answered?: boolean;
  paused?: boolean;
}): Promise<{ questionId: string; replyId: string; conversationId: string }> {
  const orgId = params.orgId ?? TEST_ORG_ID;
  const tenant = tenantFor(orgId);
  seq++;
  const at = NOW - (params.ageMs ?? 10 * 60 * 1000);
  const conversationId = `cnv_${seq}`;
  await tenant.conversations.create({
    id: conversationId,
    assistantId: params.assistantId ?? "ast_1",
    visitorId: "vis_1",
    startedAt: at,
    pageUrl: "",
  });
  const questionId = `msg_q${seq}`;
  const replyId = `msg_r${seq}`;
  await tenant.messages.create({
    id: questionId,
    conversationId,
    role: "user",
    content: QUESTION,
    citations: [],
    toolCalls: null,
    tokensIn: 0,
    tokensOut: 0,
    answered: true,
    createdAt: at,
  });
  await tenant.messages.create({
    id: replyId,
    conversationId,
    role: "assistant",
    content: REPLY,
    citations: [],
    toolCalls: null,
    tokensIn: 0,
    tokensOut: 0,
    answered: params.answered ?? true,
    createdAt: at + 1,
    replyTo: questionId,
    ...(params.paused ? { resumeContext: { messages: [], pendingTurn: {} } } : {}),
  });
  return { questionId, replyId, conversationId };
}

async function outcomeOf(orgId: string, id: string): Promise<string | null> {
  return (await tenantFor(orgId).messages.get(id))?.outcome ?? null;
}

async function topicOf(orgId: string, questionId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT t.name AS name FROM messages m JOIN topics t ON t.id = m.topic_id AND t.org_id = m.org_id
      WHERE m.org_id = ?1 AND m.id = ?2`,
  )
    .bind(orgId, questionId)
    .first<{ name: string }>();
  return row?.name ?? null;
}

async function rawTrace(orgId: string, messageId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT detail FROM message_traces WHERE org_id = ?1 AND message_id = ?2",
  )
    .bind(orgId, messageId)
    .first<{ detail: string }>();
  return row?.detail ?? null;
}

function setup(options: {
  replies: ReviewReply[];
  limits?: (action: LimitAction) => { ok: true } | { ok: false; reason: "spend_cap" };
  refuse?: string[];
  chat?: ChatRouteOverrides;
}) {
  const seen: string[] = [];
  const events: UsageEvent[] = [];
  const checks: LimitAction[] = [];
  const app = createApp(
    fakeSeams({
      usage: {
        async record(event) {
          events.push(event);
        },
      },
      limits: {
        async check(_orgId, _assistantId, action) {
          checks.push(action);
          return options.limits?.(action) ?? { ok: true };
        },
      },
      auth: {
        async resolveOrg(claim) {
          if (claim.kind !== "queued_ingest") return null;
          return options.refuse?.includes(claim.orgId) ? null : claim.orgId;
        },
      },
    }),
    // Fast retries: a hanging call gives up quickly.
    { chat: { fetch: reviewFetch(options.replies, seen), ...options.chat } },
  );
  const reviewCalls = () => seen.length;
  const runCatchUp = (maxAnswers?: number) =>
    app.runReviewCatchUp(env, { now: () => NOW, maxAnswers });
  return { app, seen, events, checks, reviewCalls, runCatchUp };
}

describe("chat: answer review catch-up", () => {
  beforeEach(async () => {
    seq = 0;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM message_traces"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM topics"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM org_provider_settings"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(TEST_ORG_ID),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
    await seedAssistant(TEST_ORG_ID, "ast_1");
    await seedAssistant(ORG_B, "ast_b");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reviews an answer the live review left empty, once, with one metered call", async () => {
    const turn = await seedReply({});
    const { events, checks, reviewCalls, runCatchUp } = setup({ replies: [ok("answered")] });

    const first = await runCatchUp();
    expect(first.taken).toBe(1);
    expect(first.results).toEqual([{ status: "stored", outcome: "answered" }]);
    expect(await outcomeOf(TEST_ORG_ID, turn.replyId)).toBe("answered");
    expect(await topicOf(TEST_ORG_ID, turn.questionId)).toBe("Refunds");
    expect(reviewCalls()).toBe(1);
    // The same cap as the live path, asked before the call.
    expect(checks).toEqual([{ kind: "review" }]);
    // One metered call (tokens, not a message) and one outcome event; no
    // answered-message event is sent again.
    expect(events.filter((e) => e.tokensIn > 0)).toEqual([
      expect.objectContaining({ messages: 0, tokensIn: 90, tokensOut: 2 }),
    ]);
    expect(events.filter((e) => e.review !== undefined)).toEqual([
      expect.objectContaining({
        review: { messageId: turn.replyId, outcome: "answered", confidence: null },
      }),
    ]);
    expect(events.reduce((n, e) => n + e.messages, 0)).toBe(0);

    // Never again, even though the next tick would find it in the window.
    const second = await runCatchUp();
    expect(second.taken).toBe(0);
    expect(reviewCalls()).toBe(1);
  });

  it("attempts an answer at most once: a failed catch-up is not retried by the next tick", async () => {
    const turn = await seedReply({});
    const { reviewCalls, runCatchUp } = setup({ replies: [{ status: 500 }] });
    const first = await runCatchUp();
    expect(first.results).toEqual([{ status: "failed", failure: "review_provider_error" }]);
    // The live rule: one retry.
    expect(reviewCalls()).toBe(2);
    expect(await outcomeOf(TEST_ORG_ID, turn.replyId)).toBeNull();
    expect(JSON.parse((await rawTrace(TEST_ORG_ID, turn.replyId)) ?? "{}")).toEqual({
      v: 1,
      parts: [],
      review: { failed: "review_provider_error", catchUp: true },
    });
    expect((await runCatchUp()).taken).toBe(0);
    expect(reviewCalls()).toBe(2);
  });

  it("stores a retry's outcome and meters both calls", async () => {
    const turn = await seedReply({});
    const { events, reviewCalls, runCatchUp } = setup({
      replies: [{ status: 529 }, ok("partial")],
    });
    await runCatchUp();
    expect(reviewCalls()).toBe(2);
    expect(await outcomeOf(TEST_ORG_ID, turn.replyId)).toBe("partial");
    // The failed call reported no usage, so only the second is metered; the
    // outcome event fires once.
    expect(events.filter((e) => e.review !== undefined)).toHaveLength(1);
    expect(events.filter((e) => e.tokensIn > 0)).toHaveLength(1);
  });

  it("stores declined for a retrieval miss the live review never reached", async () => {
    const turn = await seedReply({ answered: false });
    const { runCatchUp } = setup({ replies: [ok("wants_human", "Opening hours")] });
    await runCatchUp();
    expect(await outcomeOf(TEST_ORG_ID, turn.replyId)).toBe("wants_human");
  });

  it("skips an answer when Review answers is off: no call and no outcome", async () => {
    await tenantFor(TEST_ORG_ID).providerSettings.upsert({ reviewAnswers: false });
    const turn = await seedReply({});
    const { reviewCalls, checks, runCatchUp } = setup({ replies: [ok("answered")] });
    const result = await runCatchUp();
    expect(result.results).toEqual([{ status: "not_reviewed" }]);
    expect(reviewCalls()).toBe(0);
    expect(checks).toEqual([]);
    expect(await outcomeOf(TEST_ORG_ID, turn.replyId)).toBeNull();
    // Taken all the same, so it never fills a later tick.
    expect((await runCatchUp()).taken).toBe(0);
  });

  it("skips an answer over the spend cap and records why", async () => {
    const turn = await seedReply({});
    const { reviewCalls, runCatchUp } = setup({
      replies: [ok("answered")],
      limits: () => ({ ok: false, reason: "spend_cap" }),
    });
    const result = await runCatchUp();
    expect(result.results).toEqual([{ status: "failed", failure: "review_skipped_spend_cap" }]);
    expect(reviewCalls()).toBe(0);
    expect(await outcomeOf(TEST_ORG_ID, turn.replyId)).toBeNull();
    expect(JSON.parse((await rawTrace(TEST_ORG_ID, turn.replyId)) ?? "{}").review).toEqual({
      failed: "review_skipped_spend_cap",
      catchUp: true,
    });
  });

  it("skips answers whose live review recorded a final failure", async () => {
    const turn = await seedReply({});
    await tenantFor(TEST_ORG_ID).traces.recordReview(
      turn.replyId,
      { failed: "review_timeout" },
      NOW,
    );
    const { reviewCalls, runCatchUp } = setup({ replies: [ok("answered")] });
    expect((await runCatchUp()).taken).toBe(0);
    expect(reviewCalls()).toBe(0);
  });

  it("takes only replies from the last day, old enough, complete, of an org the seam vouches for", async () => {
    const tooOld = await seedReply({ ageMs: REVIEW_CATCH_UP_WINDOW_MS + 60_000 });
    const tooNew = await seedReply({ ageMs: REVIEW_CATCH_UP_MIN_AGE_MS - 60_000 });
    const paused = await seedReply({ paused: true });
    const refused = await seedReply({ orgId: ORG_B, assistantId: "ast_b" });
    const reviewed = await seedReply({});
    await tenantFor(TEST_ORG_ID).messages.setOutcome(reviewed.replyId, "answered", null);
    const eligible = await seedReply({ ageMs: 60 * 60 * 1000 });

    const { reviewCalls, runCatchUp } = setup({ replies: [ok("declined")], refuse: [ORG_B] });
    const result = await runCatchUp();
    expect(result.taken).toBe(1);
    expect(reviewCalls()).toBe(1);
    expect(await outcomeOf(TEST_ORG_ID, eligible.replyId)).toBe("declined");
    for (const turn of [tooOld, tooNew, paused]) {
      expect(await outcomeOf(TEST_ORG_ID, turn.replyId)).toBeNull();
    }
    expect(await outcomeOf(ORG_B, refused.replyId)).toBeNull();
    expect(await rawTrace(ORG_B, refused.replyId)).toBeNull();
  });

  it("reviews each org's answers within that org", async () => {
    const a = await seedReply({});
    const b = await seedReply({ orgId: ORG_B, assistantId: "ast_b" });
    const { runCatchUp } = setup({ replies: [ok("answered")] });
    expect((await runCatchUp()).taken).toBe(2);
    expect(await outcomeOf(TEST_ORG_ID, a.replyId)).toBe("answered");
    expect(await outcomeOf(ORG_B, b.replyId)).toBe("answered");
    // Each topic belongs to its own org's assistant.
    const topics = await env.DB.prepare(
      "SELECT org_id, assistant_id FROM topics ORDER BY org_id",
    ).all();
    expect(topics.results).toEqual(
      [
        { org_id: ORG_B, assistant_id: "ast_b" },
        { org_id: TEST_ORG_ID, assistant_id: "ast_1" },
      ].sort((x, y) => x.org_id.localeCompare(y.org_id)),
    );
  });

  it("takes a small bounded number per tick", async () => {
    for (let i = 0; i < 3; i++) await seedReply({});
    const { reviewCalls, runCatchUp } = setup({ replies: [ok("answered")] });
    expect((await runCatchUp(2)).taken).toBe(2);
    expect(reviewCalls()).toBe(2);
    expect((await runCatchUp(2)).taken).toBe(1);
    expect(MAX_REVIEW_CATCH_UP_PER_TICK).toBeLessThanOrEqual(20);
  });

  it("runs from the scheduled handler", async () => {
    const turn = await seedReply({ ageMs: 10 * 60 * 1000 - (NOW - Date.now()) });
    const { app } = setup({ replies: [ok("answered")] });
    // `scheduled` uses the real clock: the reply is 10 minutes old now.
    const ctx = createExecutionContext();
    await app.scheduled({} as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await outcomeOf(TEST_ORG_ID, turn.replyId)).toBe("answered");
  });

  it("never stores or logs the provider's text or the visitor's", async () => {
    const turn = await seedReply({});
    const { runCatchUp } = setup({ replies: [{ status: 500 }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runCatchUp();
    const detail = (await rawTrace(TEST_ORG_ID, turn.replyId)) ?? "";
    expect(detail).not.toContain("PROVIDER_TEXT_MARKER");
    expect(detail).not.toContain("VISITOR_TEXT_MARKER");
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    // It did log: the fixed reason code.
    expect(logged).toContain("review_provider_error");
    expect(logged).not.toContain("PROVIDER_TEXT_MARKER");
    expect(logged).not.toContain("VISITOR_TEXT_MARKER");
  });
});

describe("chat: a failed live review says why in the answer's trace", () => {
  const PUBLIC_KEY = "pk_ast_1";

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM message_traces"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM topics"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM org_provider_settings"),
    ]);
    await seedAssistant(TEST_ORG_ID, "ast_1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A visitor asks; nothing is retrieved, so the reply is the fallback, then reviewed. */
  async function askAndReadTrace(replies: ReviewReply[]) {
    const seen: string[] = [];
    const app = createApp(fakeSeams(), {
      chat: {
        fetch: reviewFetch(replies, seen),
        // Nothing is indexed, so the reply is the fallback and no answer model is asked.
        embedder: fakeEmbedder(),
        retriever: memoryRetriever(),
      },
    });
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: PUBLIC_KEY,
          visitorId: "vis_1",
          message: QUESTION,
        }),
      }),
      env,
      ctx,
    );
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    const id = /"messageId":"([^"]+)"/.exec(text)?.[1] ?? "";
    const reply = await tenantFor(TEST_ORG_ID).messages.get(id);
    const traceCtx = createExecutionContext();
    const traceRes = await app.fetch(
      new Request(
        `https://engine.example/api/admin/conversations/${reply?.conversationId}/messages/${id}/trace`,
        { headers: { origin: "https://engine.example" } },
      ),
      env,
      traceCtx,
    );
    await waitOnExecutionContext(traceCtx);
    return { reply, seen, view: (await traceRes.json()) as Record<string, unknown> };
  }

  // A timeout is the same path with its own code (unit tests in review.test.ts).
  it.each([
    ["review_provider_error", [{ status: 500 }]],
    ["review_unparseable", [{ status: 200, text: "I am not sure" }]],
  ] as const)("records %s after one retry, and the admin shows it", async (code, replies) => {
    const { reply, seen, view } = await askAndReadTrace([...replies]);
    expect(seen).toHaveLength(2);
    // A retrieval miss is still stored, as declined.
    expect(reply?.outcome).toBe("declined");
    expect(view.reviewFailure).toBe(code);
    const body = JSON.stringify(view);
    expect(body).not.toContain("PROVIDER_TEXT_MARKER");
    expect(body).not.toContain("VISITOR_TEXT_MARKER");
  });
});
