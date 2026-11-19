import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  answerRecorder,
  boundTrace,
  MAX_TRACE_BYTES,
  MAX_TRACE_CANDIDATES,
  MAX_TRACE_PARTS,
  parseStoredTrace,
  TRACE_REVIEW_RESERVE_BYTES,
  type TracePart,
  traceCandidates,
} from "../../src/chat/trace.js";

const encoder = new TextEncoder();

function part(kind: TracePart["kind"], candidates: number, idLength = 20): TracePart {
  return {
    kind,
    version: { id: "ver_1", state: "published" },
    model: { provider: "openrouter", id: "vendor/model", keySource: "environment" },
    retrieval: {
      floor: 0.2,
      ms: 12,
      candidates: Array.from({ length: candidates }, () => ({
        // Engine ids are a prefix and 20 characters.
        chunkId: `chk_${"x".repeat(idLength)}`,
        documentId: `doc_${"y".repeat(idLength)}`,
        score: 0.1234,
        used: false,
        dropped: "below_floor" as const,
      })),
    },
    timing: { firstTokenMs: 300, totalMs: 900 },
    tools: { rounds: 0, ms: 0 },
    stop: "complete",
  };
}

const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

describe("chat/trace bounds", () => {
  it("keeps the review's note, leaves room for it, and reads back only known codes", () => {
    const parts = [
      part("answer", 500, 5000),
      ...Array.from({ length: 30 }, () => part("resume", 500, 5000)),
    ];
    const bounded = boundTrace({ v: 1, parts, review: { failed: "review_timeout" } });
    expect(bounded.review).toEqual({ failed: "review_timeout" });
    const unbounded = boundTrace({ v: 1, parts });
    // The note written later, at its largest, still fits under the table's cap.
    const noted = { ...unbounded, review: { failed: "review_skipped_spend_cap", catchUp: true } };
    expect(bytes({ review: noted.review })).toBeLessThan(TRACE_REVIEW_RESERVE_BYTES);
    expect(bytes(noted)).toBeLessThanOrEqual(MAX_TRACE_BYTES);
    // Anything but the engine's own codes is dropped on read.
    expect(
      parseStoredTrace(JSON.stringify({ v: 1, parts: [], review: { failed: "provider said no" } }))
        ?.review,
    ).toBeUndefined();
    expect(
      parseStoredTrace(JSON.stringify({ v: 1, parts: [], review: { catchUp: true } }))?.review,
    ).toEqual({ catchUp: true });
    // A catch-up claim keeps its time (and fits the reserve); a bad one is dropped.
    const claim = { catchUp: true, claimedAt: Date.UTC(2026, 10, 19) };
    expect(bytes({ review: claim })).toBeLessThan(TRACE_REVIEW_RESERVE_BYTES);
    expect(parseStoredTrace(JSON.stringify({ v: 1, parts: [], review: claim }))?.review).toEqual(
      claim,
    );
    expect(
      parseStoredTrace(
        JSON.stringify({ v: 1, parts: [], review: { catchUp: true, claimedAt: "soon" } }),
      )?.review,
    ).toEqual({ catchUp: true });
  });

  it("keeps a full trace from the engine whole and under the cap", () => {
    const parts = [part("answer", 20), ...Array.from({ length: 7 }, () => part("resume", 20))];
    const bounded = boundTrace({ v: 1, parts });
    expect(bounded.parts).toHaveLength(MAX_TRACE_PARTS);
    expect(bounded.truncated).toBeUndefined();
    expect(bytes(bounded)).toBeLessThanOrEqual(MAX_TRACE_BYTES);
  });

  it("cuts a pathological trace to the cap and says so", () => {
    const parts = [
      part("answer", 500, 5000),
      ...Array.from({ length: 30 }, () => part("resume", 500, 5000)),
    ];
    const bounded = boundTrace({ v: 1, parts });
    expect(bytes(bounded)).toBeLessThanOrEqual(MAX_TRACE_BYTES);
    expect(bounded.truncated).toBe(true);
    // The first answer is the one kept longest.
    expect(bounded.parts[0]?.kind).toBe("answer");
    for (const p of bounded.parts) {
      expect(p.retrieval.candidates.length).toBeLessThanOrEqual(MAX_TRACE_CANDIDATES);
    }
  });

  it("keeps the first answer and the newest resumes when there are too many", () => {
    const parts = Array.from({ length: 12 }, (_, i) => ({
      ...part(i === 0 ? "answer" : "resume", 1),
      timing: { firstTokenMs: i, totalMs: i },
    }));
    const bounded = boundTrace({ v: 1, parts });
    expect(bounded.parts.map((p) => p.timing.totalMs)).toEqual([0, 5, 6, 7, 8, 9, 10, 11]);
    expect(bounded.truncated).toBe(true);
  });

  it("is refused by the database above the cap, as a backstop", async () => {
    const big = "x".repeat(MAX_TRACE_BYTES + 1);
    await expect(
      env.DB.prepare(
        "INSERT INTO message_traces (org_id, message_id, detail, created_at, updated_at) VALUES ('org_x', 'msg_x', ?1, 0, 0)",
      )
        .bind(big)
        .run(),
    ).rejects.toThrow(/CHECK|constraint/i);
  });

  it("marks candidates used, under the floor or gone, best first", () => {
    const candidates = traceCandidates(
      [
        { chunkId: "low", score: 0.1 },
        { chunkId: "gone", score: 0.8 },
        { chunkId: "hit", score: 0.9 },
      ],
      0.2,
      [
        { chunkId: "hit", documentId: "doc_hit" },
        { chunkId: "low", documentId: "doc_low" },
      ],
    );
    expect(candidates).toEqual([
      { chunkId: "hit", documentId: "doc_hit", score: 0.9, used: true },
      { chunkId: "gone", documentId: null, score: 0.8, used: false, dropped: "not_found" },
      { chunkId: "low", documentId: "doc_low", score: 0.1, used: false, dropped: "below_floor" },
    ]);
  });

  it("marks a chunk under the floor used when it was kept in the same-document margin", () => {
    const candidates = traceCandidates(
      [
        { chunkId: "hit", score: 0.31 },
        { chunkId: "near", score: 0.17 },
      ],
      0.2,
      [
        { chunkId: "hit", documentId: "doc_hit" },
        { chunkId: "near", documentId: "doc_hit" },
      ],
      new Set(["hit", "near"]),
    );
    expect(candidates).toEqual([
      { chunkId: "hit", documentId: "doc_hit", score: 0.31, used: true },
      { chunkId: "near", documentId: "doc_hit", score: 0.17, used: true },
    ]);
  });

  it("times retrieval, the first token once, and tool rounds from one clock", async () => {
    let now = 1000;
    const recorder = answerRecorder(() => now);
    await recorder.retrieval(async () => {
      now += 40;
    });
    now += 5;
    recorder.toolRound(200);
    now += 200;
    recorder.firstToken();
    now += 100;
    recorder.firstToken();
    now += 50;
    expect(recorder.snapshot()).toEqual({
      retrievalMs: 40,
      firstTokenMs: 245,
      totalMs: 395,
      toolRounds: 1,
      toolMs: 200,
    });
  });
});
