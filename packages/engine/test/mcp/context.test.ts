import { describe, expect, it } from "vitest";
import {
  ASSISTANT_ID_HEADER,
  CONVERSATION_ID_HEADER,
  contextHeaderValue,
  conversationContextHeaders,
  isConversationContextHeaderName,
  VISITOR_ID_HEADER,
} from "../../src/mcp/context.js";

/** The hashed form: `h_` and the first 32 hex characters of the SHA-256. */
async function sha256Prefix(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `h_${[...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32)}`;
}

describe("mcp/context", () => {
  it("sends an id of 1 to 128 [A-Za-z0-9_-] characters as it is", async () => {
    expect(await contextHeaderValue("cnv_01HXYZ")).toBe("cnv_01HXYZ");
    expect(await contextHeaderValue("a-B_9")).toBe("a-B_9");
    const longest = "a".repeat(128);
    expect(await contextHeaderValue(longest)).toBe(longest);
  });

  it("sends h_ and the first 32 hex characters of the SHA-256 for any other id", async () => {
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
      expect(value).toMatch(/^h_[0-9a-f]{32}$/);
      expect(value).toBe(await sha256Prefix(raw));
      expect(value).not.toContain(raw);
      // Stable: the same id always maps to the same value.
      expect(await contextHeaderValue(raw)).toBe(value);
    }
    expect(await contextHeaderValue("vis.1")).not.toBe(await contextHeaderValue("vis.2"));
  });

  it("keeps hashed values apart from raw ids", async () => {
    // Another visitor's id does not fit, so it is sent hashed.
    const victim = await contextHeaderValue("visitor.one");
    expect(victim).toMatch(/^h_[0-9a-f]{32}$/);
    // Its bare hex is a valid raw id, but can no longer equal the hashed value.
    const bareHex = victim.slice(2);
    expect(await contextHeaderValue(bareHex)).toBe(bareHex);
    expect(await contextHeaderValue(bareHex)).not.toBe(victim);
    // Sending the hashed value itself as a raw id hashes it again.
    const replayed = await contextHeaderValue(victim);
    expect(replayed).not.toBe(victim);
    expect(replayed).toBe(await sha256Prefix(victim));
    // Any raw id starting with the prefix, in any case, is hashed.
    for (const raw of ["h_", "h_abc", "H_abc", "h_0123456789abcdef0123456789abcdef"]) {
      const value = await contextHeaderValue(raw);
      expect(value).toBe(await sha256Prefix(raw));
      expect(value).not.toBe(raw);
    }
    // Ids with an h but not the prefix are still sent as they are.
    expect(await contextHeaderValue("h-1")).toBe("h-1");
    expect(await contextHeaderValue("hx_1")).toBe("hx_1");
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
