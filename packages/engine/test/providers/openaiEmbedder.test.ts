import { describe, expect, it } from "vitest";
import { ProviderError } from "../../src/providers/error.js";
import { OPENAI_EMBEDDING_BATCH_LIMIT, openAIEmbedder } from "../../src/providers/retrieval.js";

describe("openAIEmbedder", () => {
  it("returns vectors in input order even when API data is out of order, and sends key only in header", async () => {
    const fakeKey = "sk-openai-embed-secret-do-not-leak";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const embedder = openAIEmbedder({
      apiKey: fakeKey,
      fetchImpl: async (input, init) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedInit = init;
        return Response.json({
          data: [
            { index: 1, embedding: [0.4, 0.5] },
            { index: 0, embedding: [0.1, 0.2] },
          ],
        });
      },
    });

    const vectors = await embedder.embed(["first", "second"]);
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.4, 0.5],
    ]);
    expect(capturedUrl).toBe("https://api.openai.com/v1/embeddings");
    expect(capturedUrl).not.toContain(fakeKey);
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${fakeKey}`);
  });

  it("splits batches at the documented OpenAI limit", async () => {
    const total = OPENAI_EMBEDDING_BATCH_LIMIT + 3;
    const texts = Array.from({ length: total }, (_, i) => `text-${i}`);
    const batchSizes: number[] = [];

    const embedder = openAIEmbedder({
      apiKey: "test-key",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        batchSizes.push(body.input.length);
        return Response.json({
          data: body.input.map((text, index) => ({
            index,
            embedding: [Number(text.replace("text-", ""))],
          })),
        });
      },
    });

    const vectors = await embedder.embed(texts);
    expect(batchSizes).toEqual([OPENAI_EMBEDDING_BATCH_LIMIT, 3]);
    expect(vectors).toHaveLength(total);
    expect(vectors[0]).toEqual([0]);
    expect(vectors[total - 1]).toEqual([total - 1]);
  });

  it("maps 429 to retryable ProviderError and 400 to non-retryable without leaking the key", async () => {
    const secret = "sk-openai-secret-key-999";

    const retryable = openAIEmbedder({
      apiKey: secret,
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    });

    await expect(retryable.embed(["hello"])).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ProviderError &&
        err.retryable === true &&
        err.status === 429 &&
        !err.message.includes(secret)
      );
    });

    const nonRetryable = openAIEmbedder({
      apiKey: secret,
      fetchImpl: async () => new Response("bad request", { status: 400 }),
    });

    await expect(nonRetryable.embed(["hello"])).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ProviderError &&
        err.retryable === false &&
        err.status === 400 &&
        !err.message.includes(secret)
      );
    });
  });
});
