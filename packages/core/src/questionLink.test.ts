import { describe, expect, it } from "vitest";
import { isQuestionLinkStart, QUESTION_LINK_LENGTH, toQuestionLink } from "./index.js";

describe("toQuestionLink", () => {
  it("sends a short question whole, and it is not read as a start", () => {
    expect(toQuestionLink("do you ship to spain?")).toBe("do you ship to spain?");
    expect(isQuestionLinkStart("do you ship to spain?")).toBe(false);
  });

  it("sends a question of exactly the length whole", () => {
    const text = "a".repeat(QUESTION_LINK_LENGTH);
    expect(toQuestionLink(text)).toBe(text);
  });

  it("sends the start of a longer one, read as a start", () => {
    const link = toQuestionLink(`${"a".repeat(QUESTION_LINK_LENGTH)} and more`);
    expect(link).toBe("a".repeat(QUESTION_LINK_LENGTH));
    expect(isQuestionLinkStart(link)).toBe(true);
  });

  it("counts characters, never cutting one that takes two code units", () => {
    const text = "😀".repeat(QUESTION_LINK_LENGTH + 5);
    const link = toQuestionLink(text);
    expect(link).toBe("😀".repeat(QUESTION_LINK_LENGTH));
    expect(() => encodeURIComponent(link)).not.toThrow();
    expect(isQuestionLinkStart(link)).toBe(true);
  });

  it("keeps one more character when the cut lands on a space", () => {
    const text = `${"a".repeat(QUESTION_LINK_LENGTH - 1)} b and more`;
    const link = toQuestionLink(text);
    expect(link).toBe(`${"a".repeat(QUESTION_LINK_LENGTH - 1)} b`);
    // Trimmed as the engine trims it, it is still long enough to be a start.
    expect(isQuestionLinkStart(link.trim())).toBe(true);
  });
});
