import { describe, expect, it } from "vitest";
import { buildPrompt, fitsSourceBudget } from "../../src/chat/prompt.js";
import {
  chunkMarkdown,
  exceedsChunkBudget,
  joinHeadingPath,
  MAX_CHARS,
  MAX_CHUNKS,
  MAX_HEADING_CHARS,
  MIN_CHUNK_CHARS,
  OVERLAP_CHARS,
} from "../../src/ingest/chunk.js";
import { deepLeafDocument } from "../helpers/documents.js";

describe("chunkMarkdown", () => {
  it("tracks heading paths and truncates when a shallower heading follows a deeper one", () => {
    const md = [
      "# Guide",
      "Intro text.",
      "## Install",
      "Run npm install.",
      "### Details",
      "Deep detail.",
      "## Usage",
      "Call the CLI.",
    ].join("\n");

    // The minimum size is off here: this is about heading paths.
    const chunks = chunkMarkdown(md, { minChars: 0 });
    expect(chunks.map((c) => ({ path: c.headingPath, text: c.text }))).toEqual([
      { path: ["Guide"], text: "Intro text." },
      { path: ["Guide", "Install"], text: "Run npm install." },
      { path: ["Guide", "Install", "Details"], text: "Deep detail." },
      { path: ["Guide", "Usage"], text: "Call the CLI." },
    ]);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2, 3]);
  });

  it("yields paragraph groups with empty headingPath when there are no headings", () => {
    const md = "First paragraph.\n\nSecond paragraph.";
    const chunks = chunkMarkdown(md);
    expect(chunks).toEqual([
      {
        ordinal: 0,
        text: "First paragraph.\n\nSecond paragraph.",
        headingPath: [],
      },
    ]);
  });

  it("splits long sections at paragraph boundaries with overlap", () => {
    const p1 = `Paragraph one ${"a".repeat(650)}`;
    const p2 = `Paragraph two ${"b".repeat(650)}`;
    const p3 = `Paragraph three ${"c".repeat(650)}`;
    const md = `# Long\n\n${p1}\n\n${p2}\n\n${p3}`;

    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.headingPath).toEqual(["Long"]);
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS + OVERLAP_CHARS);
    }

    // Second chunk carries the tail of the first paragraph as overlap.
    expect(chunks[1]?.text.startsWith(p1.slice(-OVERLAP_CHARS))).toBe(true);
    expect(chunks[1]?.text).toContain(p2);
  });

  it("treats # inside a code fence as text and never splits mid-fence", () => {
    const fence = [
      "```bash",
      "# Not a heading",
      "echo hello",
      "",
      "# Still inside the same fence after a blank line",
      "echo world",
      "```",
    ].join("\n");

    const longProse = `Intro ${"x".repeat(1100)}`;
    const md = `# Code\n\n${longProse}\n\n${fence}\n\nAfter fence.`;

    const chunks = chunkMarkdown(md);
    // No chunk should have "# Not a heading" or "# Still inside..." as a headingPath.
    for (const chunk of chunks) {
      expect(chunk.headingPath).toEqual(["Code"]);
    }

    // Exactly one chunk should contain the entire intact fence.
    const fenceChunks = chunks.filter((c) => c.text.includes("```bash"));
    expect(fenceChunks).toHaveLength(1);
    expect(fenceChunks[0]?.text).toContain("# Not a heading");
    expect(fenceChunks[0]?.text).toContain("# Still inside the same fence after a blank line");
    expect(fenceChunks[0]?.text).toContain("```");
  });

  it("subdivides an oversized single prose paragraph into bounded chunks (F10)", () => {
    const md = "word ".repeat(100_000).trim();
    const chunks = chunkMarkdown(md);

    expect(chunks.length).toBeGreaterThan(100);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  });

  it("subdivides an oversized unspaced token without exceeding MAX_CHARS (F10)", () => {
    const md = "a".repeat(3000);
    const chunks = chunkMarkdown(md);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  });

  it("subdivides an oversized fenced code block while preserving fence structure and content (F10)", () => {
    const codeLines = Array.from(
      { length: 100 },
      (_, i) => `const line_${i} = "${"x".repeat(30)}";`,
    );
    const md = `\`\`\`typescript\n${codeLines.join("\n")}\n\`\`\``;
    const chunks = chunkMarkdown(md);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const recoveredLines: string[] = [];
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
      expect(chunk.text.startsWith("```typescript\n")).toBe(true);
      expect(chunk.text.endsWith("\n```")).toBe(true);
      const inner = chunk.text.slice("```typescript\n".length, -"\n```".length);
      recoveredLines.push(...inner.split("\n"));
    }
    expect(recoveredLines).toEqual(codeLines);
  });

  it("subdivides a fenced code block with a single oversized line while preserving fences (F10)", () => {
    const longLine = "z".repeat(2500);
    const md = `~~~\n${longLine}\n~~~`;
    // Off here: the short last piece would be merged (see "no chunk under the minimum").
    const chunks = chunkMarkdown(md, { minChars: 0 });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    let recovered = "";
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
      expect(chunk.text.startsWith("~~~\n")).toBe(true);
      expect(chunk.text.endsWith("\n~~~")).toBe(true);
      recovered += chunk.text.slice("~~~\n".length, -"\n~~~".length);
    }
    expect(recovered).toBe(longLine);
  });

  it("bounds long fence markers without amplifying chunk count or memory (F13)", () => {
    const longFence = "`".repeat(1300);
    const codeLine = "x".repeat(100_000);
    const md = `${longFence}\n${codeLine}\n${longFence}`;
    const chunks = chunkMarkdown(md);

    expect(chunks.length).toBeLessThan(200);
    let recovered = "";
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
      const lines = chunk.text.split("\n");
      expect(lines[0]).toMatch(/^`{3,}$/);
      expect(lines[lines.length - 1]).toBe(lines[0]);
      recovered += lines.slice(1, -1).join("\n");
    }
    expect(recovered).toBe(codeLine);
  });

  it("bounds oversized fence info strings while preserving valid fencing and content (F13)", () => {
    const longInfo = `typescript-${"a".repeat(2000)}`;
    const codeLine = "y".repeat(3000);
    const md = `\`\`\`${longInfo}\n${codeLine}\n\`\`\``;
    const chunks = chunkMarkdown(md);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.length).toBeLessThan(10);
    let recovered = "";
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
      const lines = chunk.text.split("\n");
      expect(lines[0]?.startsWith("```typescript-")).toBe(true);
      expect(lines[lines.length - 1]).toBe("```");
      recovered += lines.slice(1, -1).join("\n");
    }
    expect(recovered).toBe(codeLine);
  });

  it("cuts a very long heading so the path stays bounded", () => {
    const chunks = chunkMarkdown(`# ${"long ".repeat(5000)}\n\nBody`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath[0]?.length).toBeLessThanOrEqual(MAX_HEADING_CHARS);
    expect(chunks[0]?.text).toBe("Body");
  });

  it("packs a 1 MiB document of tiny sections under the chunk cap without losing words", () => {
    const sections: string[] = [];
    let i = 0;
    let markdown = "# Guide\n\n";
    while (markdown.length < 1024 * 1024 - 100) {
      const section = `## Topic ${i}\n\nword${i}\n\n`;
      markdown += section;
      sections.push(`word${i}`);
      i++;
    }
    expect(sections.length).toBeGreaterThan(MAX_CHUNKS);

    const chunks = chunkMarkdown(markdown);
    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, n) => n));
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
      // The shared heading stays the path; each section's own heading is kept
      // in the text so the subject is still embedded with its words.
      expect(chunk.headingPath).toEqual(["Guide"]);
    }
    const all = chunks.map((c) => c.text).join("\n\n");
    expect(all).toContain("## Topic 0\n\nword0");
    expect(all.match(/\bword\d+\b/g)).toEqual(sections);
    // Deterministic: the same document packs the same way.
    expect(chunkMarkdown(markdown)).toEqual(chunks);
  });

  it("returns every chunk, never a truncated prefix, when packing cannot get under the cap", () => {
    const markdown = deepLeafDocument();
    const chunks = chunkMarkdown(markdown);
    expect(chunks.length).toBeGreaterThan(MAX_CHUNKS);
    expect(exceedsChunkBudget(chunks)).toBe(true);
    // The last leaf is still there: nothing was dropped to fit the cap.
    const leaves = (markdown.match(/^###### Leaf \d+$/gm) ?? []).length;
    expect(chunks.map((c) => c.text).join("\n\n")).toContain(`w${leaves - 1}`);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, n) => n));
  });

  it("reports a normal document as within the chunk budget", () => {
    expect(exceedsChunkBudget(chunkMarkdown("# A\n\nBody."))).toBe(false);
  });
});

describe("chunkMarkdown: minimum chunk size", () => {
  const words = (n: number, word = "word") => Array.from({ length: n }, () => word).join(" ");

  it("states the minimum", () => {
    expect(MIN_CHUNK_CHARS).toBe(200);
    expect(MIN_CHUNK_CHARS).toBeLessThan(MAX_CHARS / 4);
  });

  it("stores no chunk under the minimum when a document has more than one", () => {
    const md = [
      "# Test your MCP server online",
      words(60, "intro"),
      "## Guides",
      "- What is MCP? - Remote vs Local - MCP Glossary",
      "## Steps",
      words(60, "step"),
      "## Compare",
      "- mcptest.io vs Glama",
    ].join("\n\n");
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeGreaterThanOrEqual(MIN_CHUNK_CHARS);
    const all = chunks.map((c) => c.text).join("\n\n");
    // Nothing is lost: the short sections are written into a neighbour, headings and all.
    expect(all).toContain("## Guides\n\n- What is MCP? - Remote vs Local - MCP Glossary");
    expect(all).toContain("## Compare\n\n- mcptest.io vs Glama");
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, n) => n));
  });

  it("merges into a neighbour under the same heading first", () => {
    // One long section splits into a full piece and a short tail; the tail
    // goes back to its own section, not forward into the next one.
    const long = `${words(230, "alpha")}\n\n${words(20, "tail")}`;
    const md = `# Page\n\n## A\n\n${long}\n\n## B\n\n${words(60, "beta")}`;
    const chunks = chunkMarkdown(md);
    const tail = chunks.find((c) => c.text.includes("tail"));
    expect(tail?.headingPath).toEqual(["Page", "A"]);
    expect(chunks.find((c) => c.text.includes("beta"))?.headingPath).toEqual(["Page", "B"]);
  });

  it("merges into the previous chunk, keeping the shared headings as the path", () => {
    const md = `# Page\n\n## A\n\n${words(60, "alpha")}\n\n## B\n\nShort.`;
    expect(chunkMarkdown(md)).toEqual([
      {
        ordinal: 0,
        headingPath: ["Page"],
        text: `## A\n\n${words(60, "alpha")}\n\n## B\n\nShort.`,
      },
    ]);
  });

  it("merges a short first chunk into the next one", () => {
    const md = `# Page\n\nShort intro.\n\n## A\n\n${words(60, "alpha")}`;
    expect(chunkMarkdown(md)).toEqual([
      { ordinal: 0, headingPath: ["Page"], text: `Short intro.\n\n## A\n\n${words(60, "alpha")}` },
    ]);
  });

  it("does not repeat a heading line when merging into a section that ends under it", () => {
    const md = [
      "# Guide",
      "Intro text.",
      "## Install",
      "Run npm install.",
      "### Details",
      "Deep detail.",
    ].join("\n\n");
    const [chunk] = chunkMarkdown(md);
    expect(chunk?.text).toBe(
      "Intro text.\n\n## Install\n\nRun npm install.\n\n### Details\n\nDeep detail.",
    );
  });

  it("keeps the only chunk of a short document, however short", () => {
    expect(chunkMarkdown("# Are you open on Sunday?\n\nNo.")).toEqual([
      { ordinal: 0, headingPath: ["Are you open on Sunday?"], text: "No." },
    ]);
  });

  it("merges even when no neighbour has room, bounded by a full chunk and the minimum", () => {
    const full = (word: string) => words(Math.floor(MAX_CHARS / (word.length + 1)), word);
    const md = `## A\n\n${full("aaaa")}\n\n## B\n\nShort.\n\n## C\n\n${full("cccc")}`;
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThanOrEqual(MIN_CHUNK_CHARS);
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS + MIN_CHUNK_CHARS + 20);
    }
    // No heading is shared, so the path is empty and B is written at the top level.
    expect(chunks[0]?.headingPath).toEqual([]);
    expect(chunks[0]?.text.endsWith("# B\n\nShort.")).toBe(true);
  });

  // F3: the prompt gives each source 2,000 characters for its `section:` line
  // and text, and cuts the rest. Two sections under six ~100-character
  // headings that share none fit it apart (about 1,625 and 725), but merged
  // the two paths move into the text (about 2,380): the cut would drop the
  // short section's answer, which then exists in no other chunk.
  const heading = (label: string) => `${label} ${"h".repeat(96)}`;
  const deepSection = (label: string, body: string) =>
    [1, 2, 3, 4, 5, 6]
      .map((depth) => `${"#".repeat(depth)} ${heading(`${label}${depth}`)}`)
      .concat(body)
      .join("\n\n");
  /** What the model reads of each chunk, through the real prompt builder. */
  const promptOf = (chunks: readonly { text: string; headingPath: string[] }[]) => {
    const last = buildPrompt({
      behaviour: { persona: "" },
      chunks: chunks.map((c) => ({
        title: "Doc",
        url: "https://example.com/doc",
        text: c.text,
        headingPath: joinHeadingPath(c.headingPath),
      })),
      history: [],
      question: "q",
    }).messages.at(-1);
    return last !== undefined && "content" in last ? last.content : "";
  };

  it("keeps a short section whole when merging it would be cut in the prompt (F3)", () => {
    const answer = `The answer is ANSWER-${"z".repeat(88)}`;
    const md = `${deepSection("A", words(200, "body"))}\n\n${deepSection("B", answer)}`;
    const unmerged = chunkMarkdown(md, { minChars: 0 });
    expect(unmerged).toHaveLength(2);
    // Each section reaches the model whole on its own.
    for (const chunk of unmerged) {
      expect(fitsSourceBudget(joinHeadingPath(chunk.headingPath), chunk.text)).toBe(true);
    }

    const chunks = chunkMarkdown(md);
    expect(chunks).toEqual(unmerged);
    for (const chunk of chunks) {
      expect(fitsSourceBudget(joinHeadingPath(chunk.headingPath), chunk.text)).toBe(true);
      expect(promptOf([chunk])).toContain(chunk.text);
    }
    expect(promptOf(chunks)).toContain(answer);
  });

  it("still merges a short section across divergent deep headings when the result fits", () => {
    const md = `${deepSection("A", words(40, "body"))}\n\n${deepSection("B", "Short answer.")}`;
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    const [chunk] = chunks;
    expect(chunk?.headingPath).toEqual([]);
    expect(chunk?.text).toContain(`###### ${heading("B6")}\n\nShort answer.`);
    expect(promptOf(chunks)).toContain("Short answer.");
  });

  it("merges a short section into the neighbour the prompt can carry whole", () => {
    // The previous section has room in neither budget; the next one does.
    const md = [
      deepSection("A", words(200, "body")),
      deepSection("B", "Short answer."),
      `# ${heading("C1")}\n\n${words(40, "tail")}`,
    ].join("\n\n");
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThanOrEqual(MIN_CHUNK_CHARS);
      expect(fitsSourceBudget(joinHeadingPath(chunk.headingPath), chunk.text)).toBe(true);
    }
    expect(chunks[1]?.text).toContain("Short answer.");
    expect(chunks[1]?.text).toContain("tail");
  });

  it("can be turned off", () => {
    expect(chunkMarkdown("# A\n\nOne.\n\n# B\n\nTwo.", { minChars: 0 })).toHaveLength(2);
  });
});
