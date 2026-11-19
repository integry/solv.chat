import { env } from "cloudflare:test";
import { type ChatEvent, defaultVersionConfig } from "@solvchat/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerMessage, SCORE_FLOOR } from "../../src/chat/answer.js";
import type { ReviewJob } from "../../src/chat/review.js";
import {
  DEFAULT_SCORE_FLOOR,
  SAME_DOCUMENT_MARGIN,
  scoreFloorFrom,
  selectChunks,
} from "../../src/chat/scoreFloor.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { Retriever } from "../../src/providers/retrieval.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { TEST_ORG_ID } from "../helpers/app.js";

/**
 * Scores measured on a deployed instance (`text-embedding-3-small`, cosine)
 * with two short owner-written answers, from the issue that set the floor.
 * `hours` is the opening-hours answer, `bread` the gluten-free bread one.
 */
const MEASURED: ReadonlyArray<{
  question: string;
  hours: number;
  bread: number;
  answerable: boolean;
}> = [
  { question: "What time do you open on Wednesday?", hours: 0.43, bread: 0.08, answerable: true },
  { question: "When do you close on Saturday?", hours: 0.36, bread: 0.06, answerable: true },
  { question: "When do you close on Tuesday?", hours: 0.297, bread: 0.05, answerable: true },
  // The Tuesday question with a few unrelated words in front.
  {
    question: "Anyway, so, when do you close Tuesday?",
    hours: 0.25,
    bread: 0.04,
    answerable: true,
  },
  { question: "Who painted the Mona Lisa?", hours: 0.0, bread: 0.0, answerable: false },
  { question: "Who won the world cup in 1998?", hours: 0.0, bread: 0.0, answerable: false },
];

describe("chat/scoreFloor: SOLV_SCORE_FLOOR", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the default when unset or empty", () => {
    expect(DEFAULT_SCORE_FLOOR).toBe(0.2);
    expect(SCORE_FLOOR).toBe(DEFAULT_SCORE_FLOOR);
    expect(scoreFloorFrom({})).toBe(0.2);
    expect(scoreFloorFrom({ SOLV_SCORE_FLOOR: "" })).toBe(0.2);
    expect(scoreFloorFrom({ SOLV_SCORE_FLOOR: "   " })).toBe(0.2);
  });

  it.each([
    ["0.25", 0.25],
    [" 0.35 ", 0.35],
    ["0", 0],
    [".15", 0.15],
    ["0.9", 0.9],
  ])("accepts %j", (raw, expected) => {
    expect(scoreFloorFrom({ SOLV_SCORE_FLOOR: raw })).toBe(expected);
  });

  it.each(["abc", "0.2.1", "0x1", "1e-1", "NaN", "Infinity", "-0.1", "0.91", "1", "30"])(
    "falls back to the default for %j and warns without the value",
    (raw) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(scoreFloorFrom({ SOLV_SCORE_FLOOR: raw })).toBe(DEFAULT_SCORE_FLOOR);
      for (const [line] of warn.mock.calls) {
        expect(String(line)).toContain("SOLV_SCORE_FLOOR");
        expect(String(line)).not.toContain(raw);
      }
    },
  );
});

describe("chat/scoreFloor: selectChunks", () => {
  const chunk = (chunkId: string, documentId: string, score: number) => ({
    chunkId,
    documentId,
    score,
  });

  it.each(MEASURED)("$question: content only when answerable", ({ hours, bread, answerable }) => {
    const kept = selectChunks(
      [chunk("chk_hours", "doc_hours", hours), chunk("chk_bread", "doc_bread", bread)],
      DEFAULT_SCORE_FLOOR,
    );
    expect(kept.map((c) => c.chunkId)).toEqual(answerable ? ["chk_hours"] : []);
  });

  it("keeps a chunk just under the floor only when its document already cleared it", () => {
    const floor = DEFAULT_SCORE_FLOOR;
    const nearMiss = floor - SAME_DOCUMENT_MARGIN / 2;
    const kept = selectChunks(
      [
        chunk("chk_hours_1", "doc_hours", 0.31),
        chunk("chk_hours_2", "doc_hours", nearMiss),
        // As close to the floor, but another document: unrelated, left out.
        chunk("chk_bread", "doc_bread", nearMiss),
        // The same document, but further under than the margin.
        chunk("chk_hours_3", "doc_hours", floor - SAME_DOCUMENT_MARGIN - 0.01),
      ],
      floor,
    );
    expect(kept.map((c) => c.chunkId)).toEqual(["chk_hours_1", "chk_hours_2"]);
  });

  it("keeps nothing under the floor when no chunk clears it", () => {
    const floor = DEFAULT_SCORE_FLOOR;
    const kept = selectChunks(
      [chunk("a", "doc_hours", floor - 0.01), chunk("b", "doc_hours", floor - 0.02)],
      floor,
    );
    expect(kept).toEqual([]);
  });
});

describe("chat/scoreFloor: the answer path", () => {
  const tenant = forPrincipal(env.DB, { orgId: TEST_ORG_ID, userId: "usr_1", role: "owner" });
  const behaviour = defaultVersionConfig().behaviour;

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM message_traces"),
      env.DB.prepare("DELETE FROM usage_daily"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
    ]);
    await tenant.assistants.create({
      id: "ast_1",
      name: "Bakery",
      publicKey: "pk_floor_1",
      allowedOrigins: ["https://site.example"],
      createdAt: 1000,
    });
    await tenant.sources.create({
      id: "src_1",
      assistantId: "ast_1",
      kind: "push",
      label: "CLI",
      settings: {},
      createdAt: 1000,
    });
    for (const [docId, text] of [
      ["doc_hours", "We are open Tuesday to Saturday, 07:00 to 15:30."],
      ["doc_bread", "We bake a gluten-free loaf on Fridays."],
    ] as const) {
      await tenant.documents.upsert({
        id: docId,
        sourceId: "src_1",
        externalId: docId,
        url: `https://site.example/${docId}`,
        title: docId,
        contentHash: `hash_${docId}`,
        updatedAt: 1000,
      });
      await tenant.documents.replaceChunks(docId, [
        { id: `chk_${docId.slice(4)}`, ordinal: 0, text, headingPath: "" },
      ]);
    }
  });

  /** A retriever returning fixed scores: no live embedding call. */
  function fixedRetriever(hits: { chunkId: string; score: number }[]): Retriever {
    return {
      async upsert() {},
      async remove() {},
      async query() {
        return hits;
      },
    };
  }

  async function ask(hours: number, bread: number, scoreFloor?: number) {
    let modelCalls = 0;
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.fast.id,
      async *stream() {
        modelCalls += 1;
        yield { kind: "text", text: "We close at 15:30." };
        yield { kind: "usage", tokensIn: 10, tokensOut: 5 };
      },
    };
    const jobs: ReviewJob[] = [];
    const events: ChatEvent[] = [];
    for await (const event of answerMessage(
      {
        tenant,
        embedder: fakeEmbedder(),
        retriever: fixedRetriever([
          { chunkId: "chk_hours", score: hours },
          { chunkId: "chk_bread", score: bread },
        ]),
        provider,
        model: ANTHROPIC_MODELS.fast,
        usage: { record: async () => {} },
        scoreFloor,
        trace: { version: { id: "ver_1", state: "published" }, keySource: "environment" },
        review: { schedule: (job) => jobs.push(job) },
      },
      { orgId: TEST_ORG_ID, assistantId: "ast_1", visitorId: "vis_1", message: "q", behaviour },
    )) {
      events.push(event);
    }
    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("no done event");
    const message = await tenant.messages.get(done.messageId);
    const trace = await tenant.traces.get(done.messageId);
    return { modelCalls, jobs, message, trace };
  }

  it.each(MEASURED)("$question", async ({ hours, bread, answerable }) => {
    const { modelCalls, jobs, message, trace } = await ask(hours, bread);
    expect(trace?.parts[0]?.retrieval.floor).toBe(DEFAULT_SCORE_FLOOR);
    if (answerable) {
      expect(modelCalls).toBe(1);
      expect(message?.answered).toBe(true);
      expect(jobs).toEqual([expect.objectContaining({ retrievalMiss: false })]);
    } else {
      // Off-topic stays on the nothing-found path: no model, a retrieval miss,
      // so Gaps counts it as "No content found", never "Had content, could not answer".
      expect(modelCalls).toBe(0);
      expect(message?.answered).toBe(false);
      expect(jobs).toEqual([expect.objectContaining({ retrievalMiss: true })]);
    }
  });

  it("uses and records the instance's floor", async () => {
    const { modelCalls, message, trace } = await ask(0.297, 0.05, 0.3);
    expect(modelCalls).toBe(0);
    expect(message?.answered).toBe(false);
    expect(trace?.parts[0]?.retrieval).toMatchObject({
      floor: 0.3,
      candidates: [
        { chunkId: "chk_hours", used: false, dropped: "below_floor" },
        { chunkId: "chk_bread", used: false, dropped: "below_floor" },
      ],
    });
  });
});
