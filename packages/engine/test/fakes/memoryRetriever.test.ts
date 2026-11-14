import { describe, expect, it } from "vitest";
import { memoryRetriever } from "./memoryRetriever.js";

describe("memoryRetriever", () => {
  it("filters by both orgId and assistantId and orders by cosine score", async () => {
    const retriever = memoryRetriever();
    await retriever.upsert([
      { chunkId: "chk_match_low", vector: [0.6, 0.8], orgId: "org_a", assistantId: "ast_1" },
      { chunkId: "chk_match_high", vector: [1, 0], orgId: "org_a", assistantId: "ast_1" },
      { chunkId: "chk_other_ast", vector: [1, 0], orgId: "org_a", assistantId: "ast_2" },
      { chunkId: "chk_other_org", vector: [1, 0], orgId: "org_b", assistantId: "ast_1" },
    ]);

    const hits = await retriever.query({
      vector: [1, 0],
      orgId: "org_a",
      assistantId: "ast_1",
      topK: 5,
    });

    expect(hits.map((h) => h.chunkId)).toEqual(["chk_match_high", "chk_match_low"]);
    expect(hits[0]?.score).toBeCloseTo(1, 5);
    expect(hits[1]?.score).toBeCloseTo(0.6, 5);

    const limited = await retriever.query({
      vector: [1, 0],
      orgId: "org_a",
      assistantId: "ast_1",
      topK: 1,
    });
    expect(limited.map((h) => h.chunkId)).toEqual(["chk_match_high"]);

    await retriever.remove(["chk_match_high"]);
    const afterRemove = await retriever.query({
      vector: [1, 0],
      orgId: "org_a",
      assistantId: "ast_1",
      topK: 5,
    });
    expect(afterRemove.map((h) => h.chunkId)).toEqual(["chk_match_low"]);
  });
});
