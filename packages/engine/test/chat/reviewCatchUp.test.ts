import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { defaultVersionConfig } from "@solvchat/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAnswerTrace } from "../../src/admin/conversations.js";
import { createApp } from "../../src/app.js";
import { REVIEW_FRAME } from "../../src/chat/review.js";
import {
  MAX_REVIEW_CATCH_UP_PER_TICK,
  REVIEW_CATCH_UP_MIN_AGE_MS,
  REVIEW_CATCH_UP_WINDOW_MS,
} from "../../src/chat/reviewCatchUp.js";
import type { ChatRouteOverrides } from "../../src/chat/route.js";
import {
  MAX_TRACE_BYTES,
  MAX_TRACE_CANDIDATES,
  MAX_TRACE_PARTS,
  REVIEW_CLAIM_EXPIRY_MS,
  type StoredTrace,
  TRACE_REVIEW_RESERVE_BYTES,
  type TracePart,
  type TraceReviewNote,
} from "../../src/chat/trace.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { tracesFor } from "../../src/db/traces.js";
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

type ReviewReply = { status: number; text?: string } | "hang" | "thinking_only";

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
    if (reply === "thinking_only") {
      // What Claude Haiku 5.5 sent when it thought through all 64 tokens:
      // a thinking block, no text block, stopped at max_tokens.
      const sse = [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":90}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":64}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join("");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
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

const encoder = new TextEncoder();
const byteSize = (text: string) => encoder.encode(text).byteLength;

/** The bytes `json_set` adds to a trace that has no note yet, writing this one in place. */
const inPlaceBytes = (note: TraceReviewNote) => byteSize(`,"review":${JSON.stringify(note)}`);

/**
 * A trace as the engine stored it before `boundTrace` kept room for the
 * review's note: within every bound it had (at most 8 parts of 20
 * candidates, ids of at most 256 characters, as a host's retriever may
 * return), exactly `bytes` long, which may be up to the table's whole cap.
 */
function preChangeTrace(bytes: number): StoredTrace {
  const parts: TracePart[] = [];
  const trace: StoredTrace = { v: 1, parts };
  const size = () => byteSize(JSON.stringify(trace));
  while (size() < bytes) {
    let current = parts[parts.length - 1];
    if (current === undefined || current.retrieval.candidates.length === MAX_TRACE_CANDIDATES) {
      current = {
        kind: parts.length === 0 ? "answer" : "resume",
        version: { id: "ver_1", state: "published" },
        model: { provider: "anthropic", id: "vendor-model", keySource: "environment" },
        retrieval: { floor: 0.3, ms: 12, candidates: [] },
        // Each part told apart by its timing.
        timing: { firstTokenMs: 300, totalMs: 900 + parts.length },
        tools: { rounds: 1, ms: 40 },
        stop: "complete",
      };
      parts.push(current);
    }
    const n = current.retrieval.candidates.length;
    current.retrieval.candidates.push({
      chunkId: `chk_${parts.length}_${n}_`.padEnd(256, "c"),
      documentId: `doc_${parts.length}_${n}_`.padEnd(256, "d"),
      score: 0.5,
      used: true,
    });
  }
  // Chunk ids shortened from the end, to land on `bytes` exactly.
  for (const c of parts.flatMap((p) => p.retrieval.candidates).reverse()) {
    const over = size() - bytes;
    if (over <= 0) break;
    c.chunkId = c.chunkId.slice(0, Math.max(12, c.chunkId.length - over));
  }
  expect(size()).toBe(bytes);
  expect(parts.length).toBeLessThanOrEqual(MAX_TRACE_PARTS);
  return trace;
}

/** Stores a trace's JSON as it is, as an engine before this one wrote it. */
async function seedStoredTrace(orgId: string, messageId: string, trace: StoredTrace) {
  await env.DB.prepare(
    `INSERT INTO message_traces (org_id, message_id, detail, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
  )
    .bind(orgId, messageId, JSON.stringify(trace), NOW - 10 * 60 * 1000)
    .run();
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
  const resolved: string[] = [];
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
          resolved.push(claim.orgId);
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
  return { app, seen, events, checks, resolved, reviewCalls, runCatchUp };
}

describe("chat: answer review catch-up", () => {
  beforeEach(async () => {
    seq = 0;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM message_traces"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM topics"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
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

  it("takes the topic an interrupted run stored off a question it then reviews as off topic", async () => {
    // The live review stored the topic and was cut off before the outcome:
    // the question is tagged, its answer has no outcome and no note.
    const turn = await seedReply({});
    const tenant = tenantFor(TEST_ORG_ID);
    const topic = await tenant.topics.resolve("ast_1", "Refunds");
    expect(await tenant.topics.assignToQuestion(turn.questionId, topic.id)).toBe(true);
    expect(await rawTrace(TEST_ORG_ID, turn.replyId)).toBeNull();
    const { runCatchUp } = setup({ replies: [ok("off_topic", "Australian capital city")] });

    const run = await runCatchUp();
    expect(run.results).toEqual([{ status: "stored", outcome: "off_topic" }]);
    expect(await outcomeOf(TEST_ORG_ID, turn.replyId)).toBe("off_topic");
    expect(await topicOf(TEST_ORG_ID, turn.questionId)).toBeNull();
    expect((await tenant.topics.list("ast_1")).map((t) => t.name)).toEqual(["Refunds"]);
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

  it("tells the reviewer of a miss what the site is about from the published version", async () => {
    const tenant = tenantFor(TEST_ORG_ID);
    const config = defaultVersionConfig();
    config.behaviour.greeting = "Hello! Ask about our bread and cakes.";
    config.behaviour.persona = "You answer for Rose Bakery, a family bakery.";
    // seedAssistant left `ast_1_v2` as the draft; it becomes the published version.
    await tenant.versions.updateDraft("ast_1", config);
    await tenant.versions.publishDraft("ast_1", "ast_1_v2", "ast_1_v3", 4000);
    await tenant.sources.create({
      id: "src_bakery",
      assistantId: "ast_1",
      kind: "push",
      label: "CLI",
      settings: {},
      createdAt: 1000,
    });
    await tenant.documents.upsert({
      id: "doc_hours",
      sourceId: "src_bakery",
      externalId: "hours",
      url: "https://site.example/hours",
      title: "Opening hours",
      contentHash: "hash_hours",
      updatedAt: 1000,
    });
    const turn = await seedReply({ answered: false });
    const { seen, runCatchUp } = setup({ replies: [ok("off_topic", "Mona Lisa painter")] });
    await runCatchUp();
    expect(seen).toHaveLength(1);
    const body = seen[0] ?? "";
    expect(body).toContain(
      "The assistant found nothing on the website for this question: the reply is its fixed fallback text.",
    );
    expect(body).toContain("name: Docs Bot");
    expect(body).toContain("greeting: Hello! Ask about our bread and cakes.");
    expect(body).toContain("description: You answer for Rose Bakery, a family bakery.");
    expect(body).toContain("Opening hours");
    expect(await outcomeOf(TEST_ORG_ID, turn.replyId)).toBe("off_topic");
    // An off-topic miss names no topic.
    expect(await topicOf(TEST_ORG_ID, turn.questionId)).toBeNull();
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

  it("waits past a page-action continuation's completion, not the reply's first write", async () => {
    // Paused an hour ago; the visitor's continuation completes it later.
    const turn = await seedReply({ ageMs: 60 * 60 * 1000, paused: true });
    const messages = tenantFor(TEST_ORG_ID).messages;
    const complete = async (at: number) => {
      expect(
        await messages.claimPendingReply({
          conversationId: turn.conversationId,
          id: turn.replyId,
          revision: 0,
          claimToken: "claim_1",
          now: at,
          ttlMs: 60_000,
        }),
      ).toBe(true);
      expect(
        await messages.completeReply({
          id: turn.replyId,
          claimToken: "claim_1",
          revision: 0,
          content: REPLY,
          citations: [],
          toolCalls: [],
          resumeContext: null,
          tokensIn: 0,
          tokensOut: 0,
          now: at,
        }),
      ).toBe(true);
    };
    await complete(NOW - REVIEW_CATCH_UP_MIN_AGE_MS + 60_000);
    const { reviewCalls, app } = setup({ replies: [ok("answered")] });

    // Completed four minutes ago: its live review may still be running.
    expect((await app.runReviewCatchUp(env, { now: () => NOW })).taken).toBe(0);
    expect(reviewCalls()).toBe(0);
    expect(await rawTrace(TEST_ORG_ID, turn.replyId)).toBeNull();

    // Two minutes on, the live review is long over and left nothing: taken.
    const later = await app.runReviewCatchUp(env, { now: () => NOW + 2 * 60 * 1000 });
    expect(later.results).toEqual([{ status: "stored", outcome: "answered" }]);
    expect(reviewCalls()).toBe(1);
  });

  it("pages past a refused org's backlog to reach other orgs' answers", async () => {
    // More refused replies than one page holds, all older than the answer
    // from the org the seam vouches for.
    const refused: string[] = [];
    for (let i = 0; i < 60; i++) {
      const turn = await seedReply({
        orgId: ORG_B,
        assistantId: "ast_b",
        ageMs: 20 * 60 * 60 * 1000 - i * 1000,
      });
      refused.push(turn.replyId);
    }
    const eligible = await seedReply({ ageMs: 10 * 60 * 1000 });
    const { resolved, reviewCalls, runCatchUp } = setup({
      replies: [ok("answered")],
      refuse: [ORG_B],
    });
    const result = await runCatchUp();
    expect(result.taken).toBe(1);
    expect(reviewCalls()).toBe(1);
    expect(await outcomeOf(TEST_ORG_ID, eligible.replyId)).toBe("answered");
    // The refused org is asked about once per tick, and nothing of its is touched.
    expect(resolved.filter((o) => o === ORG_B)).toHaveLength(1);
    for (const id of refused) expect(await rawTrace(ORG_B, id)).toBeNull();
  });

  it("records review_error when a read fails after the claim, and goes on", async () => {
    const broken = await seedReply({ orgId: ORG_B, assistantId: "ast_b", ageMs: 30 * 60 * 1000 });
    const fine = await seedReply({});
    const { app, runCatchUp } = setup({ replies: [ok("answered")] });
    // A transient read failure on one org's provider settings, after its claim.
    const db = env.DB;
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!sql.includes("org_provider_settings")) return stmt;
            return new Proxy(stmt, {
              get(s, p) {
                if (p === "bind") {
                  return (...args: unknown[]) => {
                    const bound = s.bind(...args);
                    if (args[0] !== ORG_B) return bound;
                    return {
                      first: async () => {
                        throw new Error("D1_ERROR: network lost");
                      },
                      all: async () => {
                        throw new Error("D1_ERROR: network lost");
                      },
                      run: async () => {
                        throw new Error("D1_ERROR: network lost");
                      },
                      raw: async () => {
                        throw new Error("D1_ERROR: network lost");
                      },
                    };
                  };
                }
                const value = Reflect.get(s, p);
                return typeof value === "function" ? value.bind(s) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await app.runReviewCatchUp({ ...env, DB: failing }, { now: () => NOW });
    expect(result.taken).toBe(2);
    expect(result.results).toEqual([
      { status: "failed", failure: "review_error" },
      { status: "stored", outcome: "answered" },
    ]);
    expect(JSON.parse((await rawTrace(ORG_B, broken.replyId)) ?? "{}").review).toEqual({
      catchUp: true,
      failed: "review_error",
    });
    expect(await outcomeOf(TEST_ORG_ID, fine.replyId)).toBe("answered");
    // Taken once: the next tick leaves it, and the admin can say why.
    expect((await runCatchUp()).taken).toBe(0);
  });

  /** What the admin's answer trace says about the review, read at `now`. */
  async function reviewFailureAt(turn: { conversationId: string; replyId: string }, now: number) {
    const view = await getAnswerTrace(
      tenantFor(TEST_ORG_ID),
      turn.conversationId,
      turn.replyId,
      now,
    );
    return view.reviewFailure;
  }

  it("leaves an answer whose catch-up is cut off mid-review saying why, with no help from the run", async () => {
    const turn = await seedReply({});
    let during: { note: unknown; soon: unknown; later: unknown } | undefined;
    const provider = reviewFetch([ok("answered")]);
    const { runCatchUp } = setup({
      replies: [ok("answered")],
      chat: {
        // During the provider request, where a cut-off run stops: only what
        // is already committed counts.
        fetch: async (input, init) => {
          during = {
            note: JSON.parse((await rawTrace(TEST_ORG_ID, turn.replyId)) ?? "{}").review,
            soon: await reviewFailureAt(turn, NOW + 30_000),
            later: await reviewFailureAt(turn, NOW + REVIEW_CLAIM_EXPIRY_MS),
          };
          return provider(input, init);
        },
      },
    });

    const run = await runCatchUp();
    expect(run.results).toEqual([{ status: "stored", outcome: "answered" }]);
    // The claim is committed with its time before the call: a run stopped
    // there says nothing while it might still be running, then review_error.
    expect(during).toEqual({
      note: { catchUp: true, claimedAt: NOW },
      soon: null,
      later: "review_error",
    });
    // The run finished: its claim is closed, and the answer has its outcome.
    expect(JSON.parse((await rawTrace(TEST_ORG_ID, turn.replyId)) ?? "{}").review).toEqual({
      catchUp: true,
    });
    expect(await reviewFailureAt(turn, NOW + REVIEW_CATCH_UP_WINDOW_MS)).toBeNull();
  });

  it("reports a claim its run never finished as review_error, and still never retakes it", async () => {
    const turn = await seedReply({});
    // What a run cut off after its claim leaves behind: the claim alone.
    const claimedAt = NOW - 60_000;
    expect(await tenantFor(TEST_ORG_ID).traces.claimReviewCatchUp(turn.replyId, claimedAt)).toBe(
      true,
    );
    expect(await reviewFailureAt(turn, claimedAt + REVIEW_CLAIM_EXPIRY_MS - 1)).toBeNull();
    expect(await reviewFailureAt(turn, claimedAt + REVIEW_CLAIM_EXPIRY_MS)).toBe("review_error");
    const { reviewCalls, runCatchUp } = setup({ replies: [ok("answered")] });
    expect((await runCatchUp()).taken).toBe(0);
    expect(reviewCalls()).toBe(0);
    // The note is untouched by the tick, so the admin keeps saying why.
    expect(await reviewFailureAt(turn, NOW + REVIEW_CLAIM_EXPIRY_MS)).toBe("review_error");
  });

  it("closes the claim of an answer it leaves unreviewed on purpose, so it is not called cut off", async () => {
    await tenantFor(TEST_ORG_ID).providerSettings.upsert({ reviewAnswers: false });
    const turn = await seedReply({});
    const { runCatchUp } = setup({ replies: [ok("answered")] });
    expect((await runCatchUp()).results).toEqual([{ status: "not_reviewed" }]);
    expect(JSON.parse((await rawTrace(TEST_ORG_ID, turn.replyId)) ?? "{}").review).toEqual({
      catchUp: true,
    });
    expect(await reviewFailureAt(turn, NOW + REVIEW_CATCH_UP_WINDOW_MS)).toBeNull();
  });

  it("still says review_error when the failure's own write fails after the claim", async () => {
    const turn = await seedReply({});
    const { app } = setup({ replies: [{ status: 500 }] });
    // Every review-note write fails except the claim (the conditional one).
    const db = env.DB;
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            const noteWrite =
              sql.includes("message_traces") &&
              sql.includes("'$.review'") &&
              !sql.includes("'$.review') IS NULL");
            if (!noteWrite) return stmt;
            return {
              bind: () => ({
                run: async () => {
                  throw new Error("D1_ERROR: network lost");
                },
              }),
            };
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const run = await app.runReviewCatchUp({ ...env, DB: failing }, { now: () => NOW });
    expect(run.results).toEqual([{ status: "failed", failure: "review_provider_error" }]);
    expect(JSON.parse((await rawTrace(TEST_ORG_ID, turn.replyId)) ?? "{}").review).toEqual({
      catchUp: true,
      claimedAt: NOW,
    });
    expect(await reviewFailureAt(turn, NOW + REVIEW_CLAIM_EXPIRY_MS)).toBe("review_error");
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
    const turn = await seedReply({ ageMs: 10 * 60 * 1000 + (NOW - Date.now()) });
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

  describe("on a trace stored before room was kept for the note", () => {
    const claim = { catchUp: true as const, claimedAt: NOW };

    /** A stored trace's JSON, read back. */
    async function storedTrace(messageId: string) {
      const detail = (await rawTrace(TEST_ORG_ID, messageId)) ?? "";
      return { bytes: byteSize(detail), trace: JSON.parse(detail || "{}") as StoredTrace };
    }

    /**
     * A db whose next read of a trace for `fitReviewNote` is followed, before
     * its write, by `meanwhile`: another write landing in between.
     */
    function writeBetween(meanwhile: () => Promise<void>): D1Database {
      return new Proxy(env.DB, {
        get(target, prop) {
          if (prop === "prepare") {
            return (sql: string) => {
              const stmt = target.prepare(sql);
              if (!sql.includes("AS unnoted")) return stmt;
              return {
                bind: (...values: unknown[]) => ({
                  first: async () => {
                    const row = await stmt.bind(...values).first();
                    await meanwhile();
                    return row;
                  },
                }),
              };
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }

    it("claims and reviews the answer, keeping its first answer and latest request", async () => {
      const turn = await seedReply({});
      // One byte too full for the claim in place: the table would refuse it.
      const before = preChangeTrace(MAX_TRACE_BYTES - inPlaceBytes(claim) + 1);
      expect(before.parts).toHaveLength(3);
      await seedStoredTrace(TEST_ORG_ID, turn.replyId, before);
      const { reviewCalls, runCatchUp } = setup({ replies: [ok("answered")] });

      expect(await runCatchUp()).toEqual({
        taken: 1,
        results: [{ status: "stored", outcome: "answered" }],
      });
      expect(reviewCalls()).toBe(1);
      expect(await outcomeOf(TEST_ORG_ID, turn.replyId)).toBe("answered");
      expect(await topicOf(TEST_ORG_ID, turn.questionId)).toBe("Refunds");
      // Cut down as `boundTrace` cuts any trace, with room for the next note:
      // the oldest resume goes, the first answer and the latest request stay
      // whole. The run finished, so its claim is closed.
      const after = await storedTrace(turn.replyId);
      expect(after.bytes).toBeLessThanOrEqual(MAX_TRACE_BYTES - TRACE_REVIEW_RESERVE_BYTES);
      expect(after.trace).toEqual({
        v: 1,
        parts: [before.parts[0], before.parts[2]],
        truncated: true,
        review: { catchUp: true },
      });
      expect(await reviewFailureAt(turn, NOW + REVIEW_CATCH_UP_WINDOW_MS)).toBeNull();
      // Taken once, like any other.
      expect((await runCatchUp()).taken).toBe(0);
      expect(reviewCalls()).toBe(1);
    });

    it("records why on a trace that took the claim in place but has no room for the failure", async () => {
      const turn = await seedReply({});
      const failure = { failed: "review_provider_error", catchUp: true } as const;
      // The claim just fits in place; the longer failure that replaces it does not.
      const before = preChangeTrace(MAX_TRACE_BYTES - inPlaceBytes(claim));
      expect(inPlaceBytes(failure)).toBeGreaterThan(inPlaceBytes(claim));
      await seedStoredTrace(TEST_ORG_ID, turn.replyId, before);
      let during: StoredTrace | undefined;
      const provider = reviewFetch([{ status: 500 }]);
      const { runCatchUp } = setup({
        replies: [{ status: 500 }],
        chat: {
          fetch: async (input, init) => {
            during ??= (await storedTrace(turn.replyId)).trace;
            return provider(input, init);
          },
        },
      });

      const run = await runCatchUp();
      expect(run.results).toEqual([{ status: "failed", failure: "review_provider_error" }]);
      // The claim went in as it was, leaving the answer's trace whole.
      expect(during).toEqual({ ...before, review: claim });
      const after = await storedTrace(turn.replyId);
      expect(after.bytes).toBeLessThanOrEqual(MAX_TRACE_BYTES);
      expect(after.trace).toEqual({
        v: 1,
        parts: [before.parts[0], before.parts[2]],
        truncated: true,
        review: failure,
      });
      expect(await reviewFailureAt(turn, NOW)).toBe("review_provider_error");
      expect((await runCatchUp()).taken).toBe(0);
    });

    it("records the live review's failure on a full trace, and the catch-up leaves it", async () => {
      const turn = await seedReply({});
      const before = preChangeTrace(MAX_TRACE_BYTES);
      await seedStoredTrace(TEST_ORG_ID, turn.replyId, before);
      await tenantFor(TEST_ORG_ID).traces.recordReview(
        turn.replyId,
        { failed: "review_timeout" },
        NOW,
      );
      expect((await storedTrace(turn.replyId)).trace).toEqual({
        v: 1,
        parts: [before.parts[0], before.parts[2]],
        truncated: true,
        review: { failed: "review_timeout" },
      });
      const { reviewCalls, runCatchUp } = setup({ replies: [ok("answered")] });
      expect((await runCatchUp()).taken).toBe(0);
      expect(reviewCalls()).toBe(0);
      expect(await reviewFailureAt(turn, NOW)).toBe("review_timeout");
    });

    it("claims a full trace once, even twice at a time, and never over a note", async () => {
      const open = await seedReply({});
      const noted = await seedReply({});
      await seedStoredTrace(TEST_ORG_ID, open.replyId, preChangeTrace(MAX_TRACE_BYTES));
      const note = { failed: "review_timeout" } as const;
      await seedStoredTrace(TEST_ORG_ID, noted.replyId, {
        ...preChangeTrace(MAX_TRACE_BYTES - inPlaceBytes(note)),
        review: note,
      });
      const traces = tenantFor(TEST_ORG_ID).traces;

      const claims = await Promise.all([
        traces.claimReviewCatchUp(open.replyId, NOW),
        traces.claimReviewCatchUp(open.replyId, NOW + 1),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect((await storedTrace(open.replyId)).trace.review).toEqual({
        catchUp: true,
        claimedAt: NOW + claims.indexOf(true),
      });
      expect(await traces.claimReviewCatchUp(open.replyId, NOW + 2)).toBe(false);

      // A note already there is never replaced by a claim, however full the trace.
      const notedDetail = await rawTrace(TEST_ORG_ID, noted.replyId);
      expect(await traces.claimReviewCatchUp(noted.replyId, NOW)).toBe(false);
      expect(await rawTrace(TEST_ORG_ID, noted.replyId)).toBe(notedDetail);
    });

    it("never writes over a full trace another write changed after it was read", async () => {
      const claimed = await seedReply({});
      const failed = await seedReply({});
      for (const turn of [claimed, failed]) {
        await seedStoredTrace(TEST_ORG_ID, turn.replyId, preChangeTrace(MAX_TRACE_BYTES));
      }
      const live = tenantFor(TEST_ORG_ID).traces;

      // The live review records a failure while the catch-up cuts the trace
      // down for its claim: the claim is refused, the failure stands.
      const claimTraces = tracesFor(
        writeBetween(() => live.recordReview(claimed.replyId, { failed: "review_timeout" }, NOW)),
        TEST_ORG_ID,
      );
      expect(await claimTraces.claimReviewCatchUp(claimed.replyId, NOW)).toBe(false);
      expect((await storedTrace(claimed.replyId)).trace.review).toEqual({
        failed: "review_timeout",
      });

      // A failure note whose trace was claimed meanwhile is not written over
      // it; the caller is told, and logs it.
      const failTraces = tracesFor(
        writeBetween(async () => {
          expect(await live.claimReviewCatchUp(failed.replyId, NOW)).toBe(true);
        }),
        TEST_ORG_ID,
      );
      await expect(
        failTraces.recordReview(failed.replyId, { failed: "review_unparseable" }, NOW),
      ).rejects.toThrow(/not written/);
      expect((await storedTrace(failed.replyId)).trace.review).toEqual(claim);
    });
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
    ["review_empty", ["thinking_only"]],
  ] as const)("records %s after one retry, and the admin shows it", async (code, replies) => {
    const { reply, seen, view } = await askAndReadTrace([...replies]);
    expect(seen).toHaveLength(2);
    // Both attempts ask the fast tier with thinking off.
    for (const raw of seen) {
      expect(JSON.parse(raw)).toMatchObject({ max_tokens: 64, thinking: { type: "disabled" } });
    }
    // A retrieval miss is still stored, as declined.
    expect(reply?.outcome).toBe("declined");
    expect(view.reviewFailure).toBe(code);
    const body = JSON.stringify(view);
    expect(body).not.toContain("PROVIDER_TEXT_MARKER");
    expect(body).not.toContain("VISITOR_TEXT_MARKER");
  });
});
