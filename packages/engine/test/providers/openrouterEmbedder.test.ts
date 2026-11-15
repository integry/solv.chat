import { describe, expect, it } from "vitest";
import { EMBEDDING_MODEL } from "../../src/models.js";
import { openRouterEmbedder } from "../../src/providers/retrieval.js";

describe("openRouterEmbedder", () => {
  it("targets OpenRouter embeddings with openai/text-embedding-3-small at 1536 dimensions", async () => {
    const fakeKey = "sk-or-v1-embed-secret";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const embedder = openRouterEmbedder({
      apiKey: fakeKey,
      fetchImpl: async (input, init) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedInit = init;
        return Response.json({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
          usage: { prompt_tokens: 4, total_tokens: 4 },
        });
      },
    });

    expect(embedder.dimensions).toBe(EMBEDDING_MODEL.dimensions);
    expect(embedder.dimensions).toBe(1536);

    const billed: number[] = [];
    const res = await embedder.embed(["hello world"], async (tokens) => {
      billed.push(tokens);
    });

    expect(res.vectors).toEqual([[0.1, 0.2, 0.3]]);
    expect(billed).toEqual([4]);
    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/embeddings");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${fakeKey}`);
    expect(headers.get("http-referer")).toBe("https://solv.chat");
    expect(headers.get("x-title")).toBe("solv.chat");

    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body.model).toBe("openai/text-embedding-3-small");
    expect(body.dimensions).toBe(1536);
    expect(body.input).toEqual(["hello world"]);
  });
});
