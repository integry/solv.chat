import { describe, expect, it } from "vitest";
import {
  ASSISTANT_ID_HEADER,
  CONVERSATION_ID_HEADER,
  contextHeaderValue,
  conversationContextHeaders,
  isConversationContextHeaderName,
  VISITOR_ID_HEADER,
} from "../../src/mcp/context.js";

async function sha256Prefix(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

describe("mcp/context", () => {
  it("sends an id of 1 to 128 [A-Za-z0-9_-] characters as it is", async () => {
    expect(await contextHeaderValue("cnv_01HXYZ")).toBe("cnv_01HXYZ");
    expect(await contextHeaderValue("a-B_9")).toBe("a-B_9");
    const longest = "a".repeat(128);
    expect(await contextHeaderValue(longest)).toBe(longest);
  });

  it("sends the first 32 hex characters of the SHA-256 for any other id", async () => {
    const cases = [
      "a".repeat(129),
      "visitor id with spaces",
      "vis.1",
      "vïsitor",
      "x\r\nInjected: yes",
      "192.168.0.1",
    ];
    for (const raw of cases) {
      const value = await contextHeaderValue(raw);
      expect(value).toMatch(/^[0-9a-f]{32}$/);
      expect(value).toBe(await sha256Prefix(raw));
      expect(value).not.toContain(raw);
      // Stable: the same id always maps to the same value.
      expect(await contextHeaderValue(raw)).toBe(value);
    }
    expect(await contextHeaderValue("vis.1")).not.toBe(await contextHeaderValue("vis.2"));
  });

  it("builds only the headers it has ids for, under the fixed names", async () => {
    expect(await conversationContextHeaders({ assistantId: "ast_1" })).toEqual({
      [ASSISTANT_ID_HEADER]: "ast_1",
    });
    expect(
      await conversationContextHeaders({
        assistantId: "ast_1",
        conversationId: "cnv_1",
        visitorId: "has space",
      }),
    ).toEqual({
      "Solv-Assistant-Id": "ast_1",
      "Solv-Conversation-Id": "cnv_1",
      "Solv-Visitor-Id": await sha256Prefix("has space"),
    });
    expect(
      await conversationContextHeaders({ assistantId: "ast_1", conversationId: "", visitorId: "" }),
    ).toEqual({ "Solv-Assistant-Id": "ast_1" });
  });

  it("recognises the reserved names in any case", () => {
    for (const name of [CONVERSATION_ID_HEADER, VISITOR_ID_HEADER, ASSISTANT_ID_HEADER]) {
      expect(isConversationContextHeaderName(name)).toBe(true);
      expect(isConversationContextHeaderName(name.toLowerCase())).toBe(true);
      expect(isConversationContextHeaderName(name.toUpperCase())).toBe(true);
    }
    expect(isConversationContextHeaderName("Authorization")).toBe(false);
    expect(isConversationContextHeaderName("Solv-Other")).toBe(false);
  });
});
