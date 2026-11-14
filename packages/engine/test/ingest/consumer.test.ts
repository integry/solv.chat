import { env } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { describe, expect, it, vi } from "vitest";
import { forIngestScope } from "../../src/db/tenant.js";
import { runIngestBatch } from "../../src/ingest/consumer.js";
import { contentHash, documentObjectKey } from "../../src/ingest/documents.js";
import type { Embedder } from "../../src/providers/retrieval.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { TEST_ORG_ID } from "../helpers/app.js";

function makeMessage<T>(body: T) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    id: newId("msg"),
    timestamp: new Date(),
    attempts: 1,
    body,
    ack,
    retry,
  };
}

async function seedDocument(markdown: string) {
  const assistantId = newId("ast");
  const sourceId = newId("src");
  const documentId = newId("doc");
  const now = Date.now();

  await env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING")
    .bind(TEST_ORG_ID, "Test Org")
    .run();
  await env.DB.prepare(
    `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at)
     VALUES (?1, ?2, ?3, ?4, '[]', ?5)`,
  )
    .bind(assistantId, TEST_ORG_ID, "Test Assistant", `pk_${newId("ast").slice(4)}`, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO sources (id, org_id, assistant_id, kind, label, settings, created_at)
     VALUES (?1, ?2, ?3, 'push', 'Push', '{}', ?4)`,
  )
    .bind(sourceId, TEST_ORG_ID, assistantId, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      documentId,
      TEST_ORG_ID,
      sourceId,
      "guide",
      "https://example.com/guide",
      "Guide",
      await contentHash("Guide", markdown),
      now,
    )
    .run();
  await env.DOCS.put(documentObjectKey(TEST_ORG_ID, documentId), markdown);

  return { assistantId, sourceId, documentId };
}

describe("ingest consumer", () => {
  it("chunks, embeds, and upserts every chunk with orgId and assistantId metadata", async () => {
    const { assistantId, documentId } = await seedDocument(
      "# Intro\n\nWelcome.\n\n## Setup\n\nInstall it.",
    );
    const embedder = fakeEmbedder();
    const retriever = memoryRetriever();
    const message = makeMessage({ documentId, orgId: TEST_ORG_ID });

    await runIngestBatch(
      { messages: [message] },
      { db: env.DB, docs: env.DOCS, embedder, retriever },
    );

    expect(message.ack).toHaveBeenCalledTimes(1);

    const tenant = forIngestScope(env.DB, { orgId: TEST_ORG_ID, assistantId });
    const chunks = await tenant.documents.listChunks(documentId);
    expect(chunks.map((c) => ({ ordinal: c.ordinal, text: c.text, path: c.headingPath }))).toEqual([
      { ordinal: 0, text: "Welcome.", path: "Intro" },
      { ordinal: 1, text: "Install it.", path: "Intro > Setup" },
    ]);

    const vectors = retriever.all();
    expect(vectors).toHaveLength(2);
    for (const v of vectors) {
      expect(v.orgId).toBe(TEST_ORG_ID);
      expect(v.assistantId).toBe(assistantId);
      expect(chunks.some((c) => c.id === v.chunkId)).toBe(true);
    }
  });

  it("replaces chunk rows and removes stale vectors when a document is re-processed", async () => {
    const { assistantId, documentId } = await seedDocument("# One\n\nFirst.\n\n# Two\n\nSecond.");
    const embedder = fakeEmbedder();
    const retriever = memoryRetriever();

    await runIngestBatch(
      { messages: [makeMessage({ documentId, orgId: TEST_ORG_ID })] },
      { db: env.DB, docs: env.DOCS, embedder, retriever },
    );

    const tenant = forIngestScope(env.DB, { orgId: TEST_ORG_ID, assistantId });
    const oldChunks = await tenant.documents.listChunks(documentId);
    expect(oldChunks).toHaveLength(2);
    const oldIds = new Set(oldChunks.map((c) => c.id));

    await env.DOCS.put(documentObjectKey(TEST_ORG_ID, documentId), "# Updated\n\nOnly one chunk.");
    await runIngestBatch(
      { messages: [makeMessage({ documentId, orgId: TEST_ORG_ID })] },
      { db: env.DB, docs: env.DOCS, embedder, retriever },
    );

    const newChunks = await tenant.documents.listChunks(documentId);
    expect(newChunks).toHaveLength(1);
    expect(newChunks[0]?.text).toBe("Only one chunk.");

    const vectors = retriever.all();
    expect(vectors).toHaveLength(1);
    expect(vectors[0]?.chunkId).toBe(newChunks[0]?.id);
    expect(oldIds.has(vectors[0]?.chunkId ?? "")).toBe(false);
  });

  it("throws on embedder failure and leaves existing chunk rows intact", async () => {
    const { assistantId, documentId } = await seedDocument("# Initial\n\nKeep me.");
    const retriever = memoryRetriever();

    await runIngestBatch(
      { messages: [makeMessage({ documentId, orgId: TEST_ORG_ID })] },
      { db: env.DB, docs: env.DOCS, embedder: fakeEmbedder(), retriever },
    );

    const tenant = forIngestScope(env.DB, { orgId: TEST_ORG_ID, assistantId });
    const before = await tenant.documents.listChunks(documentId);
    expect(before).toHaveLength(1);

    await env.DOCS.put(documentObjectKey(TEST_ORG_ID, documentId), "# Edited\n\nShould not save.");
    const failingEmbedder: Embedder = {
      dimensions: 4,
      async embed() {
        throw new Error("embedder down");
      },
    };
    const retryMessage = makeMessage({ documentId, orgId: TEST_ORG_ID });

    await expect(
      runIngestBatch(
        { messages: [retryMessage] },
        { db: env.DB, docs: env.DOCS, embedder: failingEmbedder, retriever },
      ),
    ).rejects.toThrow("embedder down");

    expect(retryMessage.ack).not.toHaveBeenCalled();
    const after = await tenant.documents.listChunks(documentId);
    expect(after).toEqual(before);
    expect(retriever.all().map((v) => v.chunkId)).toEqual(before.map((c) => c.id));
  });
});
