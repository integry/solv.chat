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
    const chunks = chunkMarkdown(md);

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
});
