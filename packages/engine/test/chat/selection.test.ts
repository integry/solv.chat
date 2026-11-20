import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCORE_FLOOR,
  MAX_CHUNKS_PER_DOCUMENT,
  SAME_DOCUMENT_MARGIN,
  type SelectableChunk,
  selectCandidates,
} from "../../src/chat/scoreFloor.js";
import { traceCandidates } from "../../src/chat/trace.js";
import {
  boundedHeadingPath,
  chunksToIndex,
  embeddingInput,
  MAX_HEADING_SHARE,
} from "../../src/ingest/consumer.js";
import { tokenEmbedder } from "../fakes/tokenEmbedder.js";

const FLOOR = DEFAULT_SCORE_FLOOR;

function cosine(a: number[], b: number[]): number {
  return a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
}

async function scores(question: string, inputs: string[]): Promise<number[]> {
  const { vectors } = await tokenEmbedder().embed([question, ...inputs], async () => {});
  const [q, ...rest] = vectors;
  return rest.map((v) => cosine(q as number[], v));
}

describe("embeddingInput", () => {
  const question = "How do I test a remote MCP server?";
  const tiny = {
    headingPath: "Test your MCP server online > Guides",
    text: "- What is MCP? - Remote vs Local - MCP Glossary",
  };
  const body = {
    headingPath: "How to test an MCP server before you deploy it > Steps",
    text: "To check a remote server, open the tester and paste its address. Pick Streamable HTTP as the transport, press Connect and wait for the list of tools. Call one of them and read the reply: an error there means the server is reachable but the tool failed.",
  };

  it("keeps a tiny chunk under a matching title from outranking a body chunk with the answer", async () => {
    const [tinyScore, bodyScore] = await scores(question, [
      embeddingInput(tiny),
      embeddingInput(body),
    ]);
    expect(bodyScore).toBeGreaterThan(tinyScore as number);
  });

  it("is what made the tiny chunk win before: the full title in front of a few words", async () => {
    const old = (c: typeof tiny) => `${c.headingPath}\n\n${c.text}`;
    const [tinyScore, bodyScore] = await scores(question, [old(tiny), old(body)]);
    expect(tinyScore).toBeGreaterThan(bodyScore as number);
  });

  it("bounds the heading context to a share of the body, dropping the broadest headings first", () => {
    expect(MAX_HEADING_SHARE).toBe(0.5);
    // 47 characters of body leave room for 23 of headings: "Guides", not the page title.
    expect(embeddingInput(tiny)).toBe(`Guides\n\n${tiny.text}`);
    // A full chunk keeps its whole path.
    expect(embeddingInput(body)).toBe(`${body.headingPath}\n\n${body.text}`);
    expect(boundedHeadingPath("A > B > C", 5)).toBe("B > C");
    expect(boundedHeadingPath("A long title", 3)).toBe("");
    expect(embeddingInput({ headingPath: "A long title", text: "Hi" })).toBe("Hi");
  });

  it("keeps a written answer's question whole: it is the owner's content", () => {
    const entry = { headingPath: "Are you open on Sunday?", text: "No." };
    expect(embeddingInput(entry, { headingIsContent: true })).toBe(
      "Are you open on Sunday?\n\nNo.",
    );
  });
});

describe("selectCandidates", () => {
  const chunk = (
    chunkId: string,
    documentId: string,
    score: number,
    text: string = `text of ${chunkId} with enough distinct words to compare`,
    sourceKind: SelectableChunk["sourceKind"] = "sitemap",
    subject: { title?: string; headingPath?: string } = {
      title: "A page",
      headingPath: "A page > A section",
    },
  ): SelectableChunk => ({ chunkId, documentId, score, text, sourceKind, ...subject });

  const ids = (chunks: readonly SelectableChunk[]) => chunks.map((c) => c.chunkId);

  it("collapses the same text under the same subject, keeping the best-scored", () => {
    const text = "We are open Tuesday to Saturday from seven until half past three.";
    const { chunks, dropped } = selectCandidates(
      [
        // The same page reached under two addresses.
        chunk("a", "doc_1", 0.79, text),
        chunk("b", "doc_2", 0.796, text),
        // Only the line breaks differ.
        chunk("c", "doc_3", 0.78, text.replace(" from ", "\n  from ")),
        chunk("d", "doc_4", 0.5),
      ],
      FLOOR,
      { topK: 6 },
    );
    expect(ids(chunks)).toEqual(["b", "d"]);
    expect(dropped.get("a")).toBe("duplicate");
    expect(dropped.get("c")).toBe("duplicate");
  });

  it("keeps the same answer to two different questions", () => {
    const refund = {
      title: "What is the refund window?",
      headingPath: "What is the refund window?",
    };
    const warranty = {
      title: "How long does the warranty last?",
      headingPath: "How long does the warranty last?",
    };
    const { chunks, dropped } = selectCandidates(
      [
        chunk("refund", "doc_refund", 0.6, "30 days.", "entry", refund),
        chunk("warranty", "doc_warranty", 0.55, "30 days.", "entry", warranty),
        chunk("other", "doc_other", 0.4),
      ],
      FLOOR,
      { topK: 6 },
    );
    expect(ids(chunks)).toEqual(["refund", "warranty", "other"]);
    expect(dropped.size).toBe(0);
  });

  it("keeps the same text on two pages with different titles", () => {
    const text =
      "Prices include tax and delivery within the country, with returns free for a month.";
    const { chunks } = selectCandidates(
      [
        chunk("a", "doc_a", 0.7, text, "sitemap", {
          title: "Desk lamp",
          headingPath: "Desk lamp > Price",
        }),
        chunk("b", "doc_b", 0.69, text, "sitemap", {
          title: "Floor lamp",
          headingPath: "Floor lamp > Price",
        }),
      ],
      FLOOR,
      { topK: 6 },
    );
    expect(ids(chunks)).toEqual(["a", "b"]);
  });

  it("keeps nearly identical text that says the opposite", () => {
    const yes =
      "You can reset the server after saving your configuration and stopping all active connections from the management console.";
    const no = yes.replace("You can ", "You can not ");
    const reordered =
      "After saving your configuration and stopping all active connections from the management console, you can reset the server.";
    const { chunks, dropped } = selectCandidates(
      [
        chunk("yes", "doc_1", 0.7, yes),
        chunk("no", "doc_1", 0.69, no),
        chunk("re", "doc_2", 0.68, reordered),
      ],
      FLOOR,
      { topK: 6 },
    );
    expect(ids(chunks)).toEqual(["yes", "no", "re"]);
    expect(dropped.size).toBe(0);
  });

  it("does not call short texts that merely share words duplicates", () => {
    const { chunks } = selectCandidates(
      [chunk("a", "doc_1", 0.6, "Open Monday"), chunk("b", "doc_2", 0.5, "Monday open?")],
      FLOOR,
      { topK: 6 },
    );
    expect(ids(chunks)).toEqual(["a", "b"]);
  });

  it("caps one document's chunks while others clear the floor", () => {
    expect(MAX_CHUNKS_PER_DOCUMENT).toBe(2);
    const { chunks, dropped } = selectCandidates(
      [
        chunk("p1", "doc_page", 0.9),
        chunk("p2", "doc_page", 0.89),
        chunk("p3", "doc_page", 0.88),
        chunk("o1", "doc_other", 0.5),
        chunk("o2", "doc_third", 0.4),
      ],
      FLOOR,
      { topK: 4 },
    );
    expect(ids(chunks)).toEqual(["p1", "p2", "o1", "o2"]);
    expect(dropped.get("p3")).toBe("document_cap");
  });

  it("lifts the cap when there are not enough other chunks above the floor", () => {
    const { chunks, dropped } = selectCandidates(
      [
        chunk("p1", "doc_page", 0.9),
        chunk("p2", "doc_page", 0.89),
        chunk("p3", "doc_page", 0.88),
        chunk("p4", "doc_page", 0.87),
        chunk("o1", "doc_other", 0.5),
        // Under the floor: not "another chunk above the floor".
        chunk("u1", "doc_under", FLOOR - 0.1),
      ],
      FLOOR,
      { topK: 4 },
    );
    expect(ids(chunks)).toEqual(["p1", "p2", "p3", "o1"]);
    expect(dropped.get("p4")).toBe("document_cap");
    expect(dropped.has("u1")).toBe(false);
  });

  it("always includes the best written answer above the floor, in place of the lowest chunk", () => {
    const pages = Array.from({ length: 6 }, (_, i) => chunk(`p${i}`, `doc_${i}`, 0.79 - i * 0.001));
    const { chunks, dropped } = selectCandidates(
      [
        ...pages,
        chunk(
          "e1",
          "doc_entry",
          0.6,
          "Paste its address into the tester and press Connect.",
          "entry",
        ),
        chunk(
          "e2",
          "doc_entry2",
          0.55,
          "Another written answer about something else here.",
          "entry",
        ),
      ],
      FLOOR,
      { topK: 6 },
    );
    expect(chunks).toHaveLength(6);
    expect(ids(chunks)).toContain("e1");
    // The best one only; the other competes on its score like any chunk.
    expect(ids(chunks)).not.toContain("e2");
    expect(ids(chunks)).not.toContain("p5");
    expect(dropped.get("p5")).toBe("rank");
    expect(dropped.get("e2")).toBe("rank");
  });

  it("keeps the written answer over a page chunk with the same text", () => {
    const text = "We are open Tuesday to Saturday from seven in the morning until half past three.";
    const { chunks, dropped } = selectCandidates(
      [chunk("page", "doc_page", 0.7, text), chunk("entry", "doc_entry", 0.6, text, "entry")],
      FLOOR,
      { topK: 6 },
    );
    expect(ids(chunks)).toEqual(["entry"]);
    expect(dropped.get("page")).toBe("duplicate");
  });

  it("keeps one of a written answer's two vectors (question and answer)", () => {
    const title = "How do I test a remote server?";
    const indexed = chunksToIndex(
      `# ${title}\n\nPaste the address into the tester, choose the transport and press Connect.`,
      { title },
      "entry",
    );
    expect(indexed).toHaveLength(2);
    const [answer, question] = indexed;
    // As `resolveChunks` gives them: the stored text and heading path, the document's title.
    const resolved = (id: string, score: number, c: typeof answer): SelectableChunk => ({
      chunkId: id,
      documentId: "doc_entry",
      score,
      text: c?.text,
      headingPath: c?.headingPath,
      title,
      sourceKind: "entry",
    });
    const { chunks, dropped } = selectCandidates(
      [resolved("q", 0.95, question), resolved("a", 0.6, answer)],
      FLOOR,
      { topK: 6 },
    );
    expect(ids(chunks)).toEqual(["q"]);
    expect(dropped.get("a")).toBe("duplicate");
  });

  it("still respects the floor: no reservation, no fill from under it", () => {
    const { chunks } = selectCandidates(
      [
        chunk("p", "doc_page", 0.5),
        chunk(
          "e",
          "doc_entry",
          FLOOR - 0.01,
          "A written answer under the floor, not about this.",
          "entry",
        ),
        chunk("x", "doc_x", FLOOR - 0.02),
      ],
      FLOOR,
      { topK: 6 },
    );
    expect(ids(chunks)).toEqual(["p"]);
  });

  it("keeps the same-document margin", () => {
    const { chunks } = selectCandidates(
      [chunk("a1", "doc_a", 0.31), chunk("a2", "doc_a", FLOOR - SAME_DOCUMENT_MARGIN / 2)],
      FLOOR,
      { topK: 6 },
    );
    expect(ids(chunks)).toEqual(["a1", "a2"]);
  });

  it("finds nothing for an off-topic question, written answers included", () => {
    const { chunks, dropped } = selectCandidates(
      [
        chunk("p", "doc_page", 0.01),
        chunk("e", "doc_entry", 0.02, "Opening hours answer text for the shop.", "entry"),
      ],
      FLOOR,
      { topK: 6 },
    );
    expect(chunks).toEqual([]);
    expect(dropped.size).toBe(0);
  });
});

describe("traceCandidates with a selection", () => {
  it("marks each candidate used or with the reason it was not", () => {
    const hits = [
      { chunkId: "used", score: 0.8 },
      { chunkId: "dup", score: 0.79 },
      { chunkId: "capped", score: 0.7 },
      { chunkId: "late", score: 0.6 },
      { chunkId: "gone", score: 0.5 },
      { chunkId: "weak", score: 0.1 },
    ];
    const resolved = ["used", "dup", "capped", "late", "weak"].map((chunkId) => ({
      chunkId,
      documentId: `doc_${chunkId}`,
    }));
    const candidates = traceCandidates(
      hits,
      FLOOR,
      resolved,
      new Set(["used"]),
      new Map([
        ["dup", "duplicate"],
        ["capped", "document_cap"],
        ["late", "rank"],
      ] as const),
    );
    expect(candidates.map((c) => [c.chunkId, c.used, c.dropped ?? null])).toEqual([
      ["used", true, null],
      ["dup", false, "duplicate"],
      ["capped", false, "document_cap"],
      ["late", false, "rank"],
      ["gone", false, "not_found"],
      ["weak", false, "below_floor"],
    ]);
  });
});
