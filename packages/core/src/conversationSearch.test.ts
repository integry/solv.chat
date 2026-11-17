import { describe, expect, it } from "vitest";
import { MAX_CONVERSATION_SEARCH_LENGTH, toConversationSearch } from "./index.js";

describe("toConversationSearch", () => {
  it("keeps a short question as it is, trimmed", () => {
    expect(toConversationSearch("  how do refunds work?  ")).toBe("how do refunds work?");
  });

  it("keeps a question of exactly the limit whole", () => {
    const text = "a".repeat(MAX_CONVERSATION_SEARCH_LENGTH);
    expect(toConversationSearch(text)).toBe(text);
  });

  it("keeps the start of a longer question, within the limit", () => {
    const text = `${"word ".repeat(60)}end`;
    const search = toConversationSearch(text);
    expect(search.length).toBeLessThanOrEqual(MAX_CONVERSATION_SEARCH_LENGTH);
    expect(text.startsWith(search)).toBe(true);
    // The cut lands after a space, which is dropped rather than searched for.
    expect(search.endsWith(" ")).toBe(false);
  });

  it("never splits a character that takes two code units", () => {
    const text = `${"a".repeat(MAX_CONVERSATION_SEARCH_LENGTH - 1)}😀 and more`;
    const search = toConversationSearch(text);
    expect(search).toBe("a".repeat(MAX_CONVERSATION_SEARCH_LENGTH - 1));
    expect(() => encodeURIComponent(search)).not.toThrow();
  });
});
