import { describe, expect, it } from "vitest";
import { ANTHROPIC_MODELS, OPENAI_MODELS } from "../../src/models.js";
import { llmProviderFor } from "../../src/providers/factory.js";
import type { KeyProvider } from "../../src/seams/types.js";

const mockKeys: KeyProvider = {
  async modelKey(_orgId, provider) {
    return provider === "anthropic" ? "test-ant-key" : "test-oai-key";
  },
  async embeddingKey() {
    return "test-oai-key";
  },
};

describe("llmProviderFor", () => {
  it("selects Anthropic and OpenAI models by configured tier", async () => {
    const antFast = await llmProviderFor(
      { orgId: "org_1", provider: "anthropic", tier: "fast" },
      mockKeys,
    );
    expect(antFast.name).toBe("anthropic");
    expect(antFast.model).toBe(ANTHROPIC_MODELS.fast.id);

    const antBalanced = await llmProviderFor(
      { orgId: "org_1", provider: "anthropic", tier: "balanced" },
      mockKeys,
    );
    expect(antBalanced.name).toBe("anthropic");
    expect(antBalanced.model).toBe(ANTHROPIC_MODELS.balanced.id);

    const oaiFast = await llmProviderFor(
      { orgId: "org_1", provider: "openai", tier: "fast" },
      mockKeys,
    );
    expect(oaiFast.name).toBe("openai");
    expect(oaiFast.model).toBe(OPENAI_MODELS.fast.id);

    const oaiBalanced = await llmProviderFor(
      { orgId: "org_1", provider: "openai", tier: "balanced" },
      mockKeys,
    );
    expect(oaiBalanced.name).toBe("openai");
    expect(oaiBalanced.model).toBe(OPENAI_MODELS.balanced.id);
  });
});
