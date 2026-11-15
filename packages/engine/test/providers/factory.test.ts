import { describe, expect, it } from "vitest";
import { ANTHROPIC_MODELS, OPENAI_MODELS } from "../../src/models.js";
import { llmProviderFor } from "../../src/providers/factory.js";
import { secretKeys } from "../../src/seams/open/secretKeys.js";
import type { KeyProvider } from "../../src/seams/types.js";

const mockKeys: KeyProvider = {
  async modelKey(_orgId, provider) {
    return `test-${provider}-key`;
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

  it("selects OpenRouter with configured model unchanged and ignores tier", async () => {
    const fast = await llmProviderFor(
      { orgId: "org_1", provider: "openrouter", tier: "fast", model: "qwen/qwen3-32b:free" },
      mockKeys,
    );
    const balanced = await llmProviderFor(
      { orgId: "org_1", provider: "openrouter", tier: "balanced", model: "qwen/qwen3-32b:free" },
      mockKeys,
    );
    expect(fast.name).toBe("openrouter");
    expect(fast.model).toBe("qwen/qwen3-32b:free");
    expect(balanced.model).toBe("qwen/qwen3-32b:free");
  });

  it("throws on missing, empty, or oversized SOLV_LLM_MODEL and missing SOLV_OPENROUTER_KEY", async () => {
    await expect(
      llmProviderFor({ orgId: "org_1", provider: "openrouter", tier: "fast" }, mockKeys),
    ).rejects.toThrow("SOLV_LLM_MODEL");

    await expect(
      llmProviderFor(
        { orgId: "org_1", provider: "openrouter", tier: "fast", model: "   " },
        mockKeys,
      ),
    ).rejects.toThrow("SOLV_LLM_MODEL");

    await expect(
      llmProviderFor(
        { orgId: "org_1", provider: "openrouter", tier: "fast", model: "a".repeat(257) },
        mockKeys,
      ),
    ).rejects.toThrow("SOLV_LLM_MODEL");

    await expect(
      llmProviderFor(
        { orgId: "org_1", provider: "openrouter", tier: "fast", model: "vendor/model" },
        secretKeys({}),
      ),
    ).rejects.toThrow("SOLV_OPENROUTER_KEY");
  });
});
