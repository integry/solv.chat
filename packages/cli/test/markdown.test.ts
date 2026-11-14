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

  it("parses YAML front matter block scalars, quoted values, and comments", () => {
    const folded = `---
title: >-
  Getting started
---

# Ignored Heading
`;
    expect(splitFrontMatter(folded).frontMatter.title).toBe("Getting started");

    const quoted = `---
title: "Guide: \\"API\\" & 'SDK'"
---
`;
    expect(splitFrontMatter(quoted).frontMatter.title).toBe("Guide: \"API\" & 'SDK'");

    const singleQuoted = `---
title: 'What''s new'
---
`;
    expect(splitFrontMatter(singleQuoted).frontMatter.title).toBe("What's new");

    const commented = `---
title: Guide # inline comment
---
`;
    expect(splitFrontMatter(commented).frontMatter.title).toBe("Guide");

    const nestedOnly = `---
meta:
  title: Nested Title
---
`;
    expect(splitFrontMatter(nestedOnly).frontMatter.title).toBeUndefined();
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

  it("respects fence lengths and closing fence trailing text", () => {
    const raw = `\`\`\`\`markdown
\`\`\`
# Example heading
\`\`\`
\`\`\`\`json
# Still inside outer fence
\`\`\`\`

# Actual Heading
`;
    expect(firstHeading(raw)).toBe("Actual Heading");
  });

  it("produces slash-joined external ids independent of OS separators", () => {
    expect(externalIdFor("/repo/docs", "/repo/docs/guides/getting-started.md")).toBe(
      "guides/getting-started",
    );
    expect(externalIdFor("C:\\repo\\docs", "C:\\repo\\docs\\api\\auth.markdown")).toBe("api/auth");
  });
});
