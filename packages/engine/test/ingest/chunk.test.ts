import { describe, expect, it } from "vitest";
import { chunkMarkdown, MAX_CHARS, OVERLAP_CHARS } from "../../src/ingest/chunk.js";

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

    const chunks = chunkMarkdown(md);
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
});
