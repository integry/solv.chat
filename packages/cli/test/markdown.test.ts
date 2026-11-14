import { describe, expect, it } from "vitest";
import { externalIdFor, firstHeading, splitFrontMatter } from "../src/markdown.js";

describe("markdown helpers", () => {
  it("prefers front matter title over first heading", () => {
    const raw = `---
title: Front Matter Title
---

# Heading Title

Body text.
`;
    const { frontMatter, body } = splitFrontMatter(raw);
    expect(frontMatter.title).toBe("Front Matter Title");
    expect(firstHeading(body)).toBe("Heading Title");
  });

  it("extracts first heading outside fenced code blocks", () => {
    const raw = `Intro paragraph.

\`\`\`bash
# Not a heading
\`\`\`

## Real Heading

More text.
`;
    const { frontMatter, body } = splitFrontMatter(raw);
    expect(frontMatter.title).toBeUndefined();
    expect(firstHeading(body)).toBe("Real Heading");
  });

  it("produces slash-joined external ids independent of OS separators", () => {
    expect(externalIdFor("/repo/docs", "/repo/docs/guides/getting-started.md")).toBe(
      "guides/getting-started",
    );
    expect(externalIdFor("C:\\repo\\docs", "C:\\repo\\docs\\api\\auth.markdown")).toBe("api/auth");
  });
});
