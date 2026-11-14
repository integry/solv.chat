import { env } from "cloudflare:test";
import { MAX_DOCUMENT_MARKDOWN_BYTES, newId } from "@solvchat/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/admin/ingestKeys.js";
import { forIngestScope } from "../../src/db/tenant.js";
import { runIngestBatch } from "../../src/ingest/consumer.js";
import {
  deleteDocuments,
  type IngestQueueMessage,
  MAX_BATCH_DOCUMENTS,
  pushDocuments,
} from "../../src/ingest/documents.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function createAssistantWithKey() {
  const id = newId("ast");
  const key = `ik_${newId("src").slice(4)}`;
  await env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING")
    .bind(TEST_ORG_ID, "Test Org")
    .run();
  await env.DB.prepare(
    `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, ingest_key_hash, created_at)
     VALUES (?1, ?2, ?3, ?4, '[]', ?5, ?6)`,
  )
    .bind(
      id,
      TEST_ORG_ID,
      "Docs Bot",
      `pk_${newId("ast").slice(4)}`,
      await sha256Hex(key),
      Date.now(),
    )
    .run();
  return { id, key };
}

function countingDocs(bucket: R2Bucket) {
  let puts = 0;
  let deletes = 0;
  return {
    get puts() {
      return puts;
    },
    get deletes() {
      return deletes;
    },
    async put(key: string, value: string) {
      puts++;
      return bucket.put(key, value);
    },
    async delete(key: string) {
      deletes++;
      return bucket.delete(key);
    },
  };
}

function countingQueue() {
  const sent: IngestQueueMessage[] = [];
  return {
    sent,
    async send(message: IngestQueueMessage) {
      sent.push(message);
    },
  };
}

describe("ingest documents", () => {
  it("writes and enqueues on first push, is a no-op on identical re-push, and re-enqueues on body or title change", async () => {
    const { id: assistantId } = await createAssistantWithKey();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const docs = countingDocs(env.DOCS);
    const queue = countingQueue();

    const first = await pushDocuments({ tenant, docs, queue }, scope, {
      documents: [
        {
          externalId: "intro",
          url: "https://example.com/intro",
          title: "Intro",
          markdown: "# Intro\n\nHello.",
        },
      ],
    });
    expect(first).toEqual({ written: 1, unchanged: 0, deleted: 0 });
    expect(docs.puts).toBe(1);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toMatchObject({
      orgId: TEST_ORG_ID,
      documentId: expect.any(String),
      contentHash: expect.any(String),
    });

    await runIngestBatch(
      {
        messages: queue.sent.map((body) => ({
          id: newId("msg"),
          timestamp: new Date(),
          attempts: 1,
          body,
          ack() {},
          retry() {},
        })),
      },
      { db: env.DB, docs: env.DOCS, embedder: fakeEmbedder(), retriever: memoryRetriever() },
    );

    // Re-pushing identical content after indexing must perform zero R2 puts and zero queue sends.
    const repeat = await pushDocuments({ tenant, docs, queue }, scope, {
      documents: [
        {
          externalId: "intro",
          url: "https://example.com/intro",
          title: "Intro",
          markdown: "# Intro\n\nHello.",
        },
      ],
    });
    expect(repeat).toEqual({ written: 0, unchanged: 1, deleted: 0 });
    expect(docs.puts).toBe(1);
    expect(queue.sent).toHaveLength(1);

    // Changing only the title counts as changed.
    const retitle = await pushDocuments({ tenant, docs, queue }, scope, {
      documents: [
        {
          externalId: "intro",
          url: "https://example.com/intro",
          title: "Introduction",
          markdown: "# Intro\n\nHello.",
        },
      ],
    });
    expect(retitle).toEqual({ written: 1, unchanged: 0, deleted: 0 });
    expect(docs.puts).toBe(2);
    expect(queue.sent).toHaveLength(2);

    // Changing the markdown body counts as changed.
    const editBody = await pushDocuments({ tenant, docs, queue }, scope, {
      documents: [
        {
          externalId: "intro",
          url: "https://example.com/intro",
          title: "Introduction",
          markdown: "# Intro\n\nUpdated body.",
        },
      ],
    });
    expect(editBody).toEqual({ written: 1, unchanged: 0, deleted: 0 });
    expect(docs.puts).toBe(3);
    expect(queue.sent).toHaveLength(3);
  });

  it("prunes unpushed documents along with their chunks, R2 bodies, and vectors", async () => {
    const { id: assistantId } = await createAssistantWithKey();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const docs = countingDocs(env.DOCS);
    const queue = countingQueue();
    const retriever = memoryRetriever();

    await pushDocuments({ tenant, docs, queue }, scope, {
      documents: [
        {
          externalId: "keep-me",
          url: "https://example.com/keep",
          title: "Keep",
          markdown: "# Keep\n\nStay here.",
        },
        {
          externalId: "drop-me",
          url: "https://example.com/drop",
          title: "Drop",
          markdown: "# Drop\n\nRemove me.",
        },
      ],
    });

    await runIngestBatch(
      {
        messages: queue.sent.map((body) => ({
          id: newId("msg"),
          timestamp: new Date(),
          attempts: 1,
          body,
          ack() {},
          retry() {},
        })),
      },
      { db: env.DB, docs: env.DOCS, embedder: fakeEmbedder(), retriever },
    );

    expect(retriever.all()).toHaveLength(2);

    const deleted = await deleteDocuments({ tenant, docs, retriever }, scope, {
      prune: true,
      keep: ["keep-me"],
    });
    expect(deleted).toEqual({ written: 0, unchanged: 0, deleted: 1 });

    const sources = await tenant.sources.list(assistantId);
    const pushSourceId = sources[0]?.id ?? "";
    const keepDoc = await tenant.documents.getByExternalId(pushSourceId, "keep-me");
    const dropDoc = await tenant.documents.getByExternalId(pushSourceId, "drop-me");
    expect(keepDoc).not.toBeNull();
    expect(dropDoc).toBeNull();
    if (!keepDoc?.bodyKey) throw new Error("expected keepDoc and bodyKey to exist");
    expect(await env.DOCS.head(keepDoc.bodyKey)).not.toBeNull();

    const remainingVectors = retriever.all();
    expect(remainingVectors).toHaveLength(1);
    const keepChunks = await tenant.documents.listChunks(keepDoc.id);
    expect(remainingVectors[0]?.chunkId).toBe(keepChunks[0]?.id);
  });

  it("rejects oversized documents (413) and batches over 100 documents without writing anything", async () => {
    const app = createTestApp();
    const { id: assistantId, key } = await createAssistantWithKey();

    const oversizedRes = await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/documents`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          documents: [
            {
              externalId: "small",
              url: "https://example.com/small",
              title: "Small",
              markdown: "ok",
            },
            {
              externalId: "huge",
              url: "https://example.com/huge",
              title: "Huge",
              markdown: "a".repeat(MAX_DOCUMENT_MARKDOWN_BYTES + 1),
            },
          ],
        }),
      }),
      env,
      ctx,
    );
    expect(oversizedRes.status).toBe(413);
    expect(await oversizedRes.text()).not.toContain(key);

    const tooManyDocs = Array.from({ length: MAX_BATCH_DOCUMENTS + 1 }, (_, i) => ({
      externalId: `doc-${i}`,
      url: `https://example.com/${i}`,
      title: `Doc ${i}`,
      markdown: "hello",
    }));
    const tooManyRes = await app.fetch(
      new Request(`https://example.com/v1/ingest/${assistantId}/documents`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ documents: tooManyDocs }),
      }),
      env,
      ctx,
    );
    expect(tooManyRes.status).toBe(413);

    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM documents WHERE org_id = ?1")
      .bind(TEST_ORG_ID)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("converges concurrent first default-source pushes onto one source while allowing explicit sources", async () => {
    const { id: assistantId } = await createAssistantWithKey();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const docs = countingDocs(env.DOCS);
    const queue = countingQueue();
    const retriever = memoryRetriever();

    const [resA, resB] = await Promise.all([
      pushDocuments({ tenant, docs, queue }, scope, {
        documents: [
          {
            externalId: "doc-a",
            url: "https://example.com/a",
            title: "Doc A",
            markdown: "# A",
          },
        ],
      }),
      pushDocuments({ tenant, docs, queue }, scope, {
        documents: [
          {
            externalId: "doc-b",
            url: "https://example.com/b",
            title: "Doc B",
            markdown: "# B",
          },
        ],
      }),
    ]);

    expect(resA).toEqual({ written: 1, unchanged: 0, deleted: 0 });
    expect(resB).toEqual({ written: 1, unchanged: 0, deleted: 0 });

    const sources = await tenant.sources.list(assistantId);
    expect(sources).toHaveLength(1);
    const defaultSourceId = sources[0]?.id ?? "";
    expect(await tenant.documents.getByExternalId(defaultSourceId, "doc-a")).not.toBeNull();
    expect(await tenant.documents.getByExternalId(defaultSourceId, "doc-b")).not.toBeNull();

    // Explicit push source can still be created and targeted via sourceId.
    const explicit = await tenant.sources.create({
      id: newId("src"),
      assistantId,
      kind: "push",
      label: "Explicit Push",
      settings: {},
      createdAt: Date.now(),
    });
    const explicitPush = await pushDocuments({ tenant, docs, queue }, scope, {
      sourceId: explicit.id,
      documents: [
        {
          externalId: "doc-c",
          url: "https://example.com/c",
          title: "Doc C",
          markdown: "# C",
        },
      ],
    });
    expect(explicitPush).toEqual({ written: 1, unchanged: 0, deleted: 0 });
    expect(await tenant.documents.getByExternalId(explicit.id, "doc-c")).not.toBeNull();

    // Default-source prune reaches both doc-a and doc-b without touching explicit source.
    const pruned = await deleteDocuments({ tenant, docs, retriever }, scope, {
      prune: true,
      keep: ["doc-a"],
    });
    expect(pruned).toEqual({ written: 0, unchanged: 0, deleted: 1 });
    expect(await tenant.documents.getByExternalId(defaultSourceId, "doc-a")).not.toBeNull();
    expect(await tenant.documents.getByExternalId(defaultSourceId, "doc-b")).toBeNull();
    expect(await tenant.documents.getByExternalId(explicit.id, "doc-c")).not.toBeNull();
  });

  it("persists URL-only updates without R2 puts or queue sends", async () => {
    const { id: assistantId } = await createAssistantWithKey();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const docs = countingDocs(env.DOCS);
    const queue = countingQueue();

    const first = await pushDocuments({ tenant, docs, queue }, scope, {
      documents: [
        {
          externalId: "guide",
          url: "https://example.com/old",
          title: "Guide",
          markdown: "# Guide\n\nUnchanged body.",
        },
      ],
    });
    expect(first).toEqual({ written: 1, unchanged: 0, deleted: 0 });
    expect(docs.puts).toBe(1);
    expect(queue.sent).toHaveLength(1);

    await runIngestBatch(
      {
        messages: queue.sent.map((body) => ({
          id: newId("msg"),
          timestamp: new Date(),
          attempts: 1,
          body,
          ack() {},
          retry() {},
        })),
      },
      { db: env.DB, docs: env.DOCS, embedder: fakeEmbedder(), retriever: memoryRetriever() },
    );

    const urlUpdate = await pushDocuments({ tenant, docs, queue }, scope, {
      documents: [
        {
          externalId: "guide",
          url: "https://example.com/new",
          title: "Guide",
          markdown: "# Guide\n\nUnchanged body.",
        },
      ],
    });
    expect(urlUpdate).toEqual({ written: 1, unchanged: 0, deleted: 0 });
    expect(docs.puts).toBe(1);
    expect(queue.sent).toHaveLength(1);

    const sources = await tenant.sources.list(assistantId);
    const pushSourceId = sources[0]?.id ?? "";
    const saved = await tenant.documents.getByExternalId(pushSourceId, "guide");
    expect(saved?.url).toBe("https://example.com/new");

    const repeat = await pushDocuments({ tenant, docs, queue }, scope, {
      documents: [
        {
          externalId: "guide",
          url: "https://example.com/new",
          title: "Guide",
          markdown: "# Guide\n\nUnchanged body.",
        },
      ],
    });
    expect(repeat).toEqual({ written: 0, unchanged: 1, deleted: 0 });
    expect(docs.puts).toBe(1);
    expect(queue.sent).toHaveLength(1);
  });

  it("deletes D1 row first and succeeds when best-effort vector or R2 cleanup fails", async () => {
    const { id: assistantId } = await createAssistantWithKey();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const docs = countingDocs(env.DOCS);
    const queue = countingQueue();
    const retriever = memoryRetriever();

    await pushDocuments({ tenant, docs, queue }, scope, {
      documents: [
        {
          externalId: "best-effort",
          url: "https://example.com/be",
          title: "Best Effort",
          markdown: "# Best Effort\n\nContent.",
        },
      ],
    });
    await runIngestBatch(
      {
        messages: queue.sent.map((body) => ({
          id: newId("msg"),
          timestamp: new Date(),
          attempts: 1,
          body,
          ack() {},
          retry() {},
        })),
      },
      { db: env.DB, docs: env.DOCS, embedder: fakeEmbedder(), retriever },
    );

    const failingDocs = {
      async delete() {
        throw new Error("R2 delete failed");
      },
    };
    const failingRetriever = {
      async remove() {
        throw new Error("Vectorize remove failed");
      },
    };

    const res = await deleteDocuments(
      { tenant, docs: failingDocs, retriever: failingRetriever },
      scope,
      { externalIds: ["best-effort"] },
    );
    expect(res).toEqual({ written: 0, unchanged: 0, deleted: 1 });

    const sources = await tenant.sources.list(assistantId);
    const pushSourceId = sources[0]?.id ?? "";
    expect(await tenant.documents.getByExternalId(pushSourceId, "best-effort")).toBeNull();
  });

  it("self-heals a lost enqueue on identical retry without rewriting R2, then treats a third push as unchanged", async () => {
    const { id: assistantId } = await createAssistantWithKey();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const docs = countingDocs(env.DOCS);
    const retriever = memoryRetriever();
    const sent: IngestQueueMessage[] = [];
    let failNextSend = true;
    const queue = {
      sent,
      async send(message: IngestQueueMessage) {
        if (failNextSend) {
          failNextSend = false;
          throw new Error("queue unavailable");
        }
        sent.push(message);
      },
    };

    const payload = {
      documents: [
        {
          externalId: "heal-me",
          url: "https://example.com/heal",
          title: "Heal Me",
          markdown: "# Heal Me\n\nRetry body.",
        },
      ],
    };

    await expect(pushDocuments({ tenant, docs, queue }, scope, payload)).rejects.toThrow(
      "queue unavailable",
    );
    expect(docs.puts).toBe(1);
    expect(queue.sent).toHaveLength(0);

    const retry = await pushDocuments({ tenant, docs, queue }, scope, payload);
    expect(retry).toEqual({ written: 1, unchanged: 0, deleted: 0 });
    expect(docs.puts).toBe(1);
    expect(queue.sent).toHaveLength(1);

    await runIngestBatch(
      {
        messages: queue.sent.map((body) => ({
          id: newId("msg"),
          timestamp: new Date(),
          attempts: 1,
          body,
          ack() {},
          retry() {},
        })),
      },
      { db: env.DB, docs: env.DOCS, embedder: fakeEmbedder(), retriever },
    );

    expect(retriever.all()).toHaveLength(1);
    const sources = await tenant.sources.list(assistantId);
    const saved = await tenant.documents.getByExternalId(sources[0]?.id ?? "", "heal-me");
    expect(saved?.indexedHash).toBe(saved?.contentHash);

    const third = await pushDocuments({ tenant, docs, queue }, scope, payload);
    expect(third).toEqual({ written: 0, unchanged: 1, deleted: 0 });
    expect(docs.puts).toBe(1);
    expect(queue.sent).toHaveLength(1);
  });

  it("guards updateMetadata by content_hash and falls back to changed-content path when another push races it", async () => {
    const { id: assistantId } = await createAssistantWithKey();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const docs = countingDocs(env.DOCS);
    const queue = countingQueue();

    await pushDocuments({ tenant, docs, queue }, scope, {
      documents: [
        {
          externalId: "race",
          url: "https://example.com/v1",
          title: "Title A",
          markdown: "# A\n\nBody A.",
        },
      ],
    });

    const sources = await tenant.sources.list(assistantId);
    const sourceId = sources[0]?.id ?? "";

    let concurrentPushTitle: string | undefined;
    let concurrentPushHash: string | undefined;
    let guardResult: boolean | undefined;
    let rowRightAfterGuard: { title: string; contentHash: string } | null = null;
    let racedOnce = false;

    const racingTenant: typeof tenant = {
      ...tenant,
      documents: {
        ...tenant.documents,
        async updateMetadata(id, title, url, expectedContentHash, updatedAt) {
          if (!racedOnce) {
            racedOnce = true;
            await pushDocuments({ tenant, docs, queue }, scope, {
              documents: [
                {
                  externalId: "race",
                  url: "https://example.com/v1",
                  title: "Title B",
                  markdown: "# B\n\nBody B.",
                },
              ],
            });
            const concurrentRow = await tenant.documents.get(id);
            concurrentPushTitle = concurrentRow?.title;
            concurrentPushHash = concurrentRow?.contentHash;
          }
          const updated = await tenant.documents.updateMetadata(
            id,
            title,
            url,
            expectedContentHash,
            updatedAt,
          );
          guardResult = updated;
          const afterGuard = await tenant.documents.get(id);
          rowRightAfterGuard = afterGuard
            ? { title: afterGuard.title, contentHash: afterGuard.contentHash }
            : null;
          return updated;
        },
      },
    };

    const res = await pushDocuments({ tenant: racingTenant, docs, queue }, scope, {
      documents: [
        {
          externalId: "race",
          url: "https://example.com/v2",
          title: "Title A",
          markdown: "# A\n\nBody A.",
        },
      ],
    });

    expect(res).toEqual({ written: 1, unchanged: 0, deleted: 0 });
    expect(guardResult).toBe(false);
    expect(rowRightAfterGuard).toEqual({
      title: concurrentPushTitle,
      contentHash: concurrentPushHash,
    });

    const finalDoc = await tenant.documents.getByExternalId(sourceId, "race");
    expect(finalDoc?.title).toBe("Title A");
    expect(finalDoc?.url).toBe("https://example.com/v2");
    expect(finalDoc?.contentHash).toBe(queue.sent[0]?.contentHash);
    expect(queue.sent).toHaveLength(3);
  });
});
