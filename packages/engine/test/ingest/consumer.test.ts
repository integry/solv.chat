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

  it("retains and removes stale vectors on retry after retriever.remove fails (F2)", async () => {
    const { assistantId, documentId } = await seedDocument("# V1\n\nOld A.\n\n# V1b\n\nOld B.");
    const embedder = fakeEmbedder();
    const retriever = memoryRetriever();

    await runIngestBatch(
      { messages: [makeMessage({ documentId, orgId: TEST_ORG_ID, revision: 1 })] },
      { db: env.DB, docs: env.DOCS, embedder, retriever },
    );

    const tenant = forIngestScope(env.DB, { orgId: TEST_ORG_ID, assistantId });
    const oldIds = (await tenant.documents.listChunks(documentId)).map((c) => c.id);
    expect(oldIds).toHaveLength(2);

    // Advance document to revision 2.
    await env.DB.prepare("UPDATE documents SET revision = 2 WHERE org_id = ?1 AND id = ?2")
      .bind(TEST_ORG_ID, documentId)
      .run();
    await env.DOCS.put(documentObjectKey(TEST_ORG_ID, documentId), "# V2\n\nNew content.");

    let failRemove = true;
    const flakyRetriever = {
      upsert: retriever.upsert.bind(retriever),
      query: retriever.query.bind(retriever),
      async remove(chunkIds: string[]) {
        if (failRemove) {
          throw new Error("vectorize remove failed");
        }
        return retriever.remove(chunkIds);
      },
    };

    const firstAttempt = makeMessage({ documentId, orgId: TEST_ORG_ID, revision: 2 });
    await expect(
      runIngestBatch(
        { messages: [firstAttempt] },
        { db: env.DB, docs: env.DOCS, embedder, retriever: flakyRetriever },
      ),
    ).rejects.toThrow("vectorize remove failed");
    expect(firstAttempt.ack).not.toHaveBeenCalled();

    // Retry: stale vectors A are still durably recorded and removed without re-embedding.
    failRemove = false;
    const retryAttempt = makeMessage({ documentId, orgId: TEST_ORG_ID, revision: 2 });
    await runIngestBatch(
      { messages: [retryAttempt] },
      { db: env.DB, docs: env.DOCS, embedder, retriever: flakyRetriever },
    );
    expect(retryAttempt.ack).toHaveBeenCalledTimes(1);

    const currentChunks = await tenant.documents.listChunks(documentId);
    expect(currentChunks).toHaveLength(1);
    expect(retriever.all().map((v) => v.chunkId)).toEqual(currentChunks.map((c) => c.id));
    for (const oldId of oldIds) {
      expect(retriever.all().some((v) => v.chunkId === oldId)).toBe(false);
    }
    expect(await tenant.documents.listStaleVectors(documentId)).toEqual([]);
  });

  it("reuses pending vector IDs on retry after D1 replaceChunks fails post-upsert (F2)", async () => {
    const { assistantId, documentId } = await seedDocument("# V1\n\nInitial.");
    const embedder = fakeEmbedder();
    const retriever = memoryRetriever();

    await runIngestBatch(
      { messages: [makeMessage({ documentId, orgId: TEST_ORG_ID, revision: 1 })] },
      { db: env.DB, docs: env.DOCS, embedder, retriever },
    );

    const tenant = forIngestScope(env.DB, { orgId: TEST_ORG_ID, assistantId });
    const oldIds = (await tenant.documents.listChunks(documentId)).map((c) => c.id);

    await env.DB.prepare("UPDATE documents SET revision = 2 WHERE org_id = ?1 AND id = ?2")
      .bind(TEST_ORG_ID, documentId)
      .run();
    await env.DOCS.put(documentObjectKey(TEST_ORG_ID, documentId), "# V2\n\nSecond.");

    const upsertedBatches: string[][] = [];
    const trackingRetriever = {
      query: retriever.query.bind(retriever),
      remove: retriever.remove.bind(retriever),
      async upsert(records: Parameters<typeof retriever.upsert>[0]) {
        upsertedBatches.push(records.map((r) => r.chunkId));
        return retriever.upsert(records);
      },
    };

    // Simulate D1 batch failure on replaceChunks after retriever.upsert succeeds.
    let failChunkInsert = true;
    const flakyDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            // replaceChunks batch has 5+ statements (savePendingVectors has 2 for 1 chunk).
            if (failChunkInsert && stmts.length >= 5) {
              throw new Error("D1 batch failed");
            }
            return target.batch(stmts);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const firstAttempt = makeMessage({ documentId, orgId: TEST_ORG_ID, revision: 2 });
    await expect(
      runIngestBatch(
        { messages: [firstAttempt] },
        { db: flakyDb, docs: env.DOCS, embedder, retriever: trackingRetriever },
      ),
    ).rejects.toThrow("D1 batch failed");
    expect(firstAttempt.ack).not.toHaveBeenCalled();
    expect(upsertedBatches).toHaveLength(1);

    failChunkInsert = false;
    const retryAttempt = makeMessage({ documentId, orgId: TEST_ORG_ID, revision: 2 });
    await runIngestBatch(
      { messages: [retryAttempt] },
      { db: flakyDb, docs: env.DOCS, embedder, retriever: trackingRetriever },
    );
    expect(retryAttempt.ack).toHaveBeenCalledTimes(1);
    expect(upsertedBatches).toHaveLength(2);
    // Exact same chunk IDs reused on retry — no orphaned vectors left behind.
    expect(upsertedBatches[1]).toEqual(upsertedBatches[0]);

    const finalChunks = await tenant.documents.listChunks(documentId);
    expect(finalChunks.map((c) => c.id)).toEqual(upsertedBatches[0]);
    expect(retriever.all().map((v) => v.chunkId)).toEqual(finalChunks.map((c) => c.id));
    for (const oldId of oldIds) {
      expect(retriever.all().some((v) => v.chunkId === oldId)).toBe(false);
    }
  });

  it("discards superseded older consumer paused during embedding without overwriting newer revision (F3)", async () => {
    const { assistantId, documentId } = await seedDocument("# Rev 1\n\nOlder content.");
    const retriever = memoryRetriever();
    const tenant = forIngestScope(env.DB, { orgId: TEST_ORG_ID, assistantId });

    let releaseEmbedA!: () => void;
    const embedAStarted = new Promise<void>((resolve) => {
      const gate = new Promise<void>((res) => {
        releaseEmbedA = res;
      });
      const embedderA: Embedder = {
        dimensions: 4,
        async embed(texts) {
          resolve();
          await gate;
          return fakeEmbedder().embed(texts);
        },
      };

      const msgA = makeMessage({ documentId, orgId: TEST_ORG_ID, revision: 1 });
      void runIngestBatch(
        { messages: [msgA] },
        { db: env.DB, docs: env.DOCS, embedder: embedderA, retriever },
      ).then(() => {
        expect(msgA.ack).toHaveBeenCalledTimes(1);
      });
    });

    await embedAStarted;

    // Revision 2 arrives and is processed by Consumer B while Consumer A is paused.
    await env.DB.prepare("UPDATE documents SET revision = 2 WHERE org_id = ?1 AND id = ?2")
      .bind(TEST_ORG_ID, documentId)
      .run();
    await env.DOCS.put(documentObjectKey(TEST_ORG_ID, documentId), "# Rev 2\n\nNewer content.");
    const msgB = makeMessage({ documentId, orgId: TEST_ORG_ID, revision: 2 });
    await runIngestBatch(
      { messages: [msgB] },
      { db: env.DB, docs: env.DOCS, embedder: fakeEmbedder(), retriever },
    );
    expect(msgB.ack).toHaveBeenCalledTimes(1);

    const rev2Chunks = await tenant.documents.listChunks(documentId);
    expect(rev2Chunks.map((c) => c.text)).toEqual(["Newer content."]);

    // Resume Consumer A; it must discard its work and leave rev 2 intact.
    releaseEmbedA();
    await new Promise((r) => setTimeout(r, 50));

    const finalChunks = await tenant.documents.listChunks(documentId);
    expect(finalChunks).toEqual(rev2Chunks);
    expect(retriever.all().map((v) => v.chunkId)).toEqual(rev2Chunks.map((c) => c.id));
  });

  it("cleans up superseded vectors when revision advances between upsert and replaceChunks (F3)", async () => {
    const { assistantId, documentId } = await seedDocument("# Rev 1\n\nOlder content.");
    const retriever = memoryRetriever();
    const tenant = forIngestScope(env.DB, { orgId: TEST_ORG_ID, assistantId });

    let releaseUpsertA!: () => void;
    let upsertAEntered!: () => void;
    const upsertAStarted = new Promise<void>((resolve) => {
      upsertAEntered = resolve;
    });
    const upsertAGate = new Promise<void>((resolve) => {
      releaseUpsertA = resolve;
    });

    const blockingRetrieverA = {
      query: retriever.query.bind(retriever),
      remove: retriever.remove.bind(retriever),
      async upsert(records: Parameters<typeof retriever.upsert>[0]) {
        await retriever.upsert(records);
        upsertAEntered();
        await upsertAGate;
      },
    };

    const msgA = makeMessage({ documentId, orgId: TEST_ORG_ID, revision: 1 });
    const promiseA = runIngestBatch(
      { messages: [msgA] },
      { db: env.DB, docs: env.DOCS, embedder: fakeEmbedder(), retriever: blockingRetrieverA },
    );

    await upsertAStarted;

    // Document advances to revision 2 before Consumer A reaches replaceChunks.
    await env.DB.prepare("UPDATE documents SET revision = 2 WHERE org_id = ?1 AND id = ?2")
      .bind(TEST_ORG_ID, documentId)
      .run();
    await env.DOCS.put(documentObjectKey(TEST_ORG_ID, documentId), "# Rev 2\n\nNewer content.");
    const msgB = makeMessage({ documentId, orgId: TEST_ORG_ID, revision: 2 });
    await runIngestBatch(
      { messages: [msgB] },
      { db: env.DB, docs: env.DOCS, embedder: fakeEmbedder(), retriever },
    );

    releaseUpsertA();
    await promiseA;
    expect(msgA.ack).toHaveBeenCalledTimes(1);

    const finalChunks = await tenant.documents.listChunks(documentId);
    expect(finalChunks.map((c) => c.text)).toEqual(["Newer content."]);
    expect(retriever.all().map((v) => v.chunkId)).toEqual(finalChunks.map((c) => c.id));
  });
});
