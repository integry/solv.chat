import { describe, expect, it } from "vitest";
import { secretKeys } from "../../src/seams/open/secretKeys.js";

describe("secretKeys", () => {
  it("returns present keys", async () => {
    const keys = secretKeys({
      SOLV_ANTHROPIC_KEY: "test-anthropic-placeholder",
      SOLV_OPENAI_KEY: "test-openai-placeholder",
    });

    expect(await keys.modelKey("org_1", "anthropic")).toBe("test-anthropic-placeholder");
    expect(await keys.modelKey("org_1", "openai")).toBe("test-openai-placeholder");
    expect(await keys.embeddingKey("org_1")).toBe("test-openai-placeholder");
  });

  it("throws naming the missing secret with no value in the message", async () => {
    const keys = secretKeys({ SOLV_ANTHROPIC_KEY: "test-anthropic-placeholder" });

    await expect(keys.modelKey("org_1", "openai")).rejects.toThrow("SOLV_OPENAI_KEY");
    await expect(keys.embeddingKey("org_1")).rejects.toThrow("SOLV_OPENAI_KEY");

    const empty = secretKeys({});
    await expect(empty.modelKey("org_1", "anthropic")).rejects.toThrow("SOLV_ANTHROPIC_KEY");
  });
});
