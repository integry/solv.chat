import { describe, expect, it } from "vitest";
import { ProviderError } from "../../src/providers/error.js";
import {
  embeddingCostMicros,
  OPENAI_EMBEDDING_BATCH_LIMIT,
  OPENAI_EMBEDDING_MAX_BYTES_PER_REQUEST,
  openAIEmbedder,
  VECTORIZE_UPSERT_BATCH_LIMIT,
  vectorizeRetriever,
} from "../../src/providers/retrieval.js";

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
          usage: { prompt_tokens: 4, total_tokens: 4 },
        });
      },
    });

    const billed: number[] = [];
    const { vectors } = await embedder.embed(["first", "second"], async (t) => {
      billed.push(t);
    });
    expect(billed).toEqual([4]);
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

    const { vectors } = await embedder.embed(texts, async () => {});
    expect(batchSizes).toEqual([OPENAI_EMBEDDING_BATCH_LIMIT, 3]);
    expect(vectors).toHaveLength(total);
    expect(vectors[0]).toEqual([0]);
    expect(vectors[total - 1]).toEqual([total - 1]);
  });

  it("splits requests before their total size could pass the per-request token cap, and reports each request's billed tokens", async () => {
    const text = "z".repeat(1200);
    const total = Math.ceil((OPENAI_EMBEDDING_MAX_BYTES_PER_REQUEST * 2.5) / text.length);
    const texts = Array.from({ length: total }, () => text);
    const requestChars: number[] = [];

    const embedder = openAIEmbedder({
      apiKey: "test-key",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        requestChars.push(body.input.reduce((sum, t) => sum + t.length, 0));
        return Response.json({
          data: body.input.map((_t, index) => ({ index, embedding: [index] })),
          usage: { prompt_tokens: body.input.length * 300, total_tokens: body.input.length * 300 },
        });
      },
    });

    const billed: number[] = [];
    const { vectors } = await embedder.embed(texts, async (t) => {
      billed.push(t);
    });
    expect(vectors).toHaveLength(total);
    expect(requestChars).toHaveLength(3);
    expect(requestChars.every((c) => c <= OPENAI_EMBEDDING_MAX_BYTES_PER_REQUEST)).toBe(true);
    expect(billed).toHaveLength(3);
    expect(billed.reduce((a, b) => a + b, 0)).toBe(total * 300);
    expect(embeddingCostMicros(total * 300)).toBeGreaterThan(0);
  });

  it("reports a billed request before a later request fails, and before validating a malformed body", async () => {
    const text = "z".repeat(1200);
    const total = Math.ceil((OPENAI_EMBEDDING_MAX_BYTES_PER_REQUEST * 1.5) / text.length);
    let call = 0;
    const embedder = openAIEmbedder({
      apiKey: "test-key",
      fetchImpl: async (_input, init) => {
        call += 1;
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        if (call === 1) {
          return Response.json({
            data: body.input.map((_t, index) => ({ index, embedding: [index] })),
            usage: { total_tokens: 700 },
          });
        }
        return new Response("upstream down", { status: 503 });
      },
    });
    const billed: number[] = [];
    await expect(
      embedder.embed(
        Array.from({ length: total }, () => text),
        async (t) => {
          billed.push(t);
        },
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(call).toBe(2);
    expect(billed).toEqual([700]);

    // A body that bills tokens but has the wrong shape is still spend.
    const malformed = openAIEmbedder({
      apiKey: "test-key",
      fetchImpl: async () => Response.json({ data: [], usage: { total_tokens: 9 } }),
    });
    const malformedBilled: number[] = [];
    await expect(
      malformed.embed(["a"], async (t) => {
        malformedBilled.push(t);
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(malformedBilled).toEqual([9]);
  });

  it("upserts to Vectorize in batches no larger than the Workers binding limit", async () => {
    const sizes: number[] = [];
    const index = {
      async upsert(vectors: unknown[]) {
        sizes.push(vectors.length);
        return { mutationId: "m" };
      },
    } as unknown as VectorizeIndex;
    const total = VECTORIZE_UPSERT_BATCH_LIMIT * 2 + 1;
    await vectorizeRetriever(index).upsert(
      Array.from({ length: total }, (_, i) => ({
        chunkId: `chk_${i}`,
        vector: [1],
        orgId: "org",
        assistantId: "ast",
      })),
    );
    expect(sizes).toEqual([VECTORIZE_UPSERT_BATCH_LIMIT, VECTORIZE_UPSERT_BATCH_LIMIT, 1]);
  });

  it("deletes from Vectorize in batches no larger than the upsert batch size", async () => {
    const sizes: number[] = [];
    const index = {
      async deleteByIds(ids: string[]) {
        sizes.push(ids.length);
        return { mutationId: "m" };
      },
    } as unknown as VectorizeIndex;
    const total = VECTORIZE_UPSERT_BATCH_LIMIT * 2 + 5;
    await vectorizeRetriever(index).remove(Array.from({ length: total }, (_, i) => `chk_${i}`));
    expect(sizes).toEqual([VECTORIZE_UPSERT_BATCH_LIMIT, VECTORIZE_UPSERT_BATCH_LIMIT, 5]);
    await vectorizeRetriever(index).remove([]);
    expect(sizes).toHaveLength(3);
  });

  it("maps 429 to retryable ProviderError and 400 to non-retryable without leaking the key", async () => {
    const secret = "sk-openai-secret-key-999";

    const retryable = openAIEmbedder({
      apiKey: secret,
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    });

    await expect(retryable.embed(["hello"], async () => {})).rejects.toSatisfy((err: unknown) => {
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

    await expect(nonRetryable.embed(["hello"], async () => {})).rejects.toSatisfy(
      (err: unknown) => {
        return (
          err instanceof ProviderError &&
          err.retryable === false &&
          err.status === 400 &&
          !err.message.includes(secret)
        );
      },
    );
  });

  it("sizes requests by UTF-8 bytes, so CJK text gets smaller batches than ASCII of the same length", async () => {
    // 1,200 CJK characters are 3,600 bytes in UTF-8.
    const text = "漢".repeat(1200);
    const bytes = new TextEncoder().encode(text).byteLength;
    const total = Math.ceil(OPENAI_EMBEDDING_MAX_BYTES_PER_REQUEST / text.length);
    const requestBytes: number[] = [];
    const embedder = openAIEmbedder({
      apiKey: "test-key",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        requestBytes.push(body.input.length * bytes);
        return Response.json({
          data: body.input.map((_t, index) => ({ index, embedding: [index] })),
        });
      },
    });

    const { vectors } = await embedder.embed(
      Array.from({ length: total }, () => text),
      async () => {},
    );
    expect(vectors).toHaveLength(total);
    // A character budget would have sent this as one request.
    expect(requestBytes.length).toBeGreaterThan(1);
    expect(requestBytes.every((b) => b <= OPENAI_EMBEDDING_MAX_BYTES_PER_REQUEST)).toBe(true);
  });

  it("halves a batch the provider refuses with 400 and keeps vectors in input order", async () => {
    // The provider refuses any request with more than two inputs, as it would
    // one whose token total passed the cap.
    const sizes: number[] = [];
    const embedder = openAIEmbedder({
      apiKey: "test-key",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        sizes.push(body.input.length);
        if (body.input.length > 2) return new Response("too many tokens", { status: 400 });
        return Response.json({
          data: body.input.map((text, index) => ({ index, embedding: [Number(text)] })),
          usage: { total_tokens: body.input.length },
        });
      },
    });
    const billed: number[] = [];
    const { vectors } = await embedder.embed(["0", "1", "2", "3", "4"], async (t) => {
      billed.push(t);
    });
    expect(vectors).toEqual([[0], [1], [2], [3], [4]]);
    expect(sizes).toEqual([5, 3, 2, 1, 2]);
    expect(billed.reduce((a, b) => a + b, 0)).toBe(5);

    // A single input still refused fails as a non-retryable error.
    const single = openAIEmbedder({
      apiKey: "test-key",
      fetchImpl: async () => new Response("bad request", { status: 400 }),
    });
    let calls = 0;
    const counted = openAIEmbedder({
      apiKey: "test-key",
      fetchImpl: async () => {
        calls++;
        return new Response("bad request", { status: 400 });
      },
    });
    await expect(single.embed(["only"], async () => {})).rejects.toMatchObject({
      retryable: false,
      status: 400,
    });
    await expect(counted.embed(["a", "b", "c", "d"], async () => {})).rejects.toMatchObject({
      status: 400,
    });
    // Bounded: the 4-input request, its first half, then that half's first
    // single, which fails for good.
    expect(calls).toBe(3);
  });
});
