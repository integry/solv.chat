import { describe, expect, it } from "vitest";
import { ANTHROPIC_MODELS, costMicros, EMBEDDING_MODEL, OPENAI_MODELS } from "../src/models.js";
import modelsSource from "../src/models.ts?raw";

describe("models", () => {
  it("defines valid model entries for all tiers and embeddings", () => {
    for (const table of [ANTHROPIC_MODELS, OPENAI_MODELS]) {
      for (const tier of ["fast", "balanced"] as const) {
        const entry = table[tier];
        expect(entry.id.trim().length).toBeGreaterThan(0);
        expect(entry.contextTokens).toBeGreaterThan(0);
        expect(entry.inputCostMicrosPerMillion).toBeGreaterThanOrEqual(0);
        expect(entry.outputCostMicrosPerMillion).toBeGreaterThanOrEqual(0);
        if (entry.longPrompt) {
          expect(entry.longPrompt.thresholdTokens).toBeGreaterThan(0);
          expect(entry.longPrompt.inputCostMicrosPerMillion).toBeGreaterThanOrEqual(0);
          expect(entry.longPrompt.outputCostMicrosPerMillion).toBeGreaterThanOrEqual(0);
        }
      }
    }

    expect(EMBEDDING_MODEL.id.trim().length).toBeGreaterThan(0);
    expect(EMBEDDING_MODEL.dimensions).toBeGreaterThan(0);
    expect(EMBEDDING_MODEL.costMicrosPerMillion).toBeGreaterThanOrEqual(0);
  });

  it("computes integer, monotonic costs in micro-dollars", () => {
    const model = ANTHROPIC_MODELS.balanced;
    const c0 = costMicros(model, 0, 0);
    const cIn1 = costMicros(model, 1_000, 0);
    const cIn2 = costMicros(model, 10_000, 0);
    const cOut1 = costMicros(model, 10_000, 1_000);
    const cOut2 = costMicros(model, 10_000, 10_000);

    for (const value of [c0, cIn1, cIn2, cOut1, cOut2]) {
      expect(Number.isInteger(value)).toBe(true);
    }

    expect(c0).toBe(0);
    expect(cIn1).toBeLessThanOrEqual(cIn2);
    expect(cIn2).toBeLessThanOrEqual(cOut1);
    expect(cOut1).toBeLessThanOrEqual(cOut2);
    expect(cOut2).toBeGreaterThan(c0);
  });

  it("applies Haiku 5.5 long-prompt pricing strictly above 100,000 input tokens", () => {
    const haiku = ANTHROPIC_MODELS.fast;
    expect(costMicros(haiku, 99_999, 1_000)).toBe(10_500);
    expect(costMicros(haiku, 100_000, 1_000)).toBe(10_500);
    expect(costMicros(haiku, 100_001, 1_000)).toBe(52_501);
  });

  it("applies OpenAI long-prompt pricing strictly above 272,000 input tokens", () => {
    const luna = OPENAI_MODELS.fast;
    expect(costMicros(luna, 271_999, 1_000)).toBe(27_700);
    expect(costMicros(luna, 272_000, 1_000)).toBe(27_700);
    expect(costMicros(luna, 272_001, 1_000)).toBe(55_150);

    const sol = OPENAI_MODELS.balanced;
    expect(costMicros(sol, 271_999, 1_000)).toBe(553_998);
    expect(costMicros(sol, 272_000, 1_000)).toBe(554_000);
    expect(costMicros(sol, 272_001, 1_000)).toBe(1_103_004);
  });

  it("carries a source URL and checked date beside each table", () => {
    for (const anchor of [
      "export const ANTHROPIC_MODELS",
      "export const OPENAI_MODELS",
      "export const EMBEDDING_MODEL",
    ]) {
      const idx = modelsSource.indexOf(anchor);
      expect(idx).toBeGreaterThan(-1);
      const preceding = modelsSource.slice(Math.max(0, idx - 300), idx);
      expect(preceding).toMatch(/https:\/\/\S+/);
      expect(preceding).toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
});
