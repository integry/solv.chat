import { env } from "cloudflare:test";
import { MAX_DOCUMENT_MARKDOWN_BYTES, newId } from "@solvchat/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/admin/ingestKeys.js";
import { forIngestScope } from "../../src/db/tenant.js";
import { runIngestBatch } from "../../src/ingest/consumer.js";
import {
  deleteDocuments,
  documentObjectKey,
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
  const sent: Array<{ documentId: string; orgId: string }> = [];
  return {
    sent,
    async send(message: { documentId: string; orgId: string }) {
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

    // Re-pushing identical content must perform zero R2 puts and zero queue sends.
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
    if (!keepDoc) throw new Error("expected keepDoc to exist");
    expect(
      await env.DOCS.head(documentObjectKey(TEST_ORG_ID, keepDoc.id, keepDoc.revision)),
    ).not.toBeNull();

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

  it("resumes unfinished R2 put and queue send on identical retry after push failure (F1)", async () => {
    const { id: assistantId } = await createAssistantWithKey();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const docs = countingDocs(env.DOCS);
    const queue = countingQueue();

    const payload = {
      documents: [
        {
          externalId: "resumable",
          url: "https://example.com/resumable",
          title: "Resumable",
          markdown: "# Resumable\n\nBody.",
        },
      ],
    };

    // 1. Fail on R2 put after documents.upsert persisted the content hash.
    let failPut = true;
    const flakyDocs = {
      async put(key: string, value: string) {
        if (failPut) {
          throw new Error("R2 unavailable");
        }
        return docs.put(key, value);
      },
      async delete(key: string) {
        return docs.delete(key);
      },
    };

    await expect(pushDocuments({ tenant, docs: flakyDocs, queue }, scope, payload)).rejects.toThrow(
      "R2 unavailable",
    );
    expect(docs.puts).toBe(0);
    expect(queue.sent).toHaveLength(0);

    // 2. Allow R2 put to succeed, but fail on Queue send.
    failPut = false;
    let failQueue = true;
    const flakyQueue = {
      async send(message: { documentId: string; orgId: string; revision?: number }) {
        if (failQueue) {
          throw new Error("Queue unavailable");
        }
        return queue.send(message);
      },
    };

    await expect(
      pushDocuments({ tenant, docs: flakyDocs, queue: flakyQueue }, scope, payload),
    ).rejects.toThrow("Queue unavailable");
    expect(docs.puts).toBe(1);
    expect(queue.sent).toHaveLength(0);

    // 3. Retry identical payload: must resume queue send without re-putting R2.
    failQueue = false;
    const resumed = await pushDocuments(
      { tenant, docs: flakyDocs, queue: flakyQueue },
      scope,
      payload,
    );
    expect(resumed).toEqual({ written: 1, unchanged: 0, deleted: 0 });
    expect(docs.puts).toBe(1);
    expect(queue.sent).toHaveLength(1);

    // 4. Subsequent identical push is now a true no-op.
    const noop = await pushDocuments(
      { tenant, docs: flakyDocs, queue: flakyQueue },
      scope,
      payload,
    );
    expect(noop).toEqual({ written: 0, unchanged: 1, deleted: 0 });
    expect(docs.puts).toBe(1);
    expect(queue.sent).toHaveLength(1);
  });

  it("converges concurrent first default-source pushes onto one source while allowing explicit sources (F4)", async () => {
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

  it("prevents concurrent pushes for the same externalId from overwriting a newer revision's R2 body (F5)", async () => {
    const { id: assistantId } = await createAssistantWithKey();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const queue = countingQueue();
    const retriever = memoryRetriever();

    let putAEntered!: () => void;
    const putAStarted = new Promise<void>((resolve) => {
      putAEntered = resolve;
    });
    let releasePutA!: () => void;
    const putAGate = new Promise<void>((resolve) => {
      releasePutA = resolve;
    });

    const blockingDocsA = {
      async put(key: string, value: string) {
        putAEntered();
        await putAGate;
        return env.DOCS.put(key, value);
      },
      async delete(key: string) {
        return env.DOCS.delete(key);
      },
    };

    const pushA = pushDocuments({ tenant, docs: blockingDocsA, queue }, scope, {
      documents: [
        {
          externalId: "race",
          url: "https://example.com/race",
          title: "Race",
          markdown: "# Rev 1\n\nBody A.",
        },
      ],
    });

    await putAStarted;

    // Push B updates the same externalId to revision 2 while Push A is paused at docs.put.
    const pushBRes = await pushDocuments({ tenant, docs: env.DOCS, queue }, scope, {
      documents: [
        {
          externalId: "race",
          url: "https://example.com/race",
          title: "Race",
          markdown: "# Rev 2\n\nBody B.",
        },
      ],
    });
    expect(pushBRes).toEqual({ written: 1, unchanged: 0, deleted: 0 });

    // Release Push A's delayed put; it must write to v1.md without clobbering v2.md.
    releasePutA();
    await pushA;

    expect(queue.sent).toHaveLength(1);
    const queuedMsg = queue.sent[0] as { documentId: string; orgId: string; revision?: number };
    expect(queuedMsg.revision).toBe(2);

    await runIngestBatch(
      {
        messages: [
          {
            id: newId("msg"),
            timestamp: new Date(),
            attempts: 1,
            body: queuedMsg,
            ack() {},
            retry() {},
          },
        ],
      },
      { db: env.DB, docs: env.DOCS, embedder: fakeEmbedder(), retriever },
    );

    const chunks = await tenant.documents.listChunks(queuedMsg.documentId);
    expect(chunks.map((c) => c.text)).toEqual(["Body B."]);

    // Re-pushing Body B is a true no-op.
    const repeatB = await pushDocuments({ tenant, docs: env.DOCS, queue }, scope, {
      documents: [
        {
          externalId: "race",
          url: "https://example.com/race",
          title: "Race",
          markdown: "# Rev 2\n\nBody B.",
        },
      ],
    });
    expect(repeatB).toEqual({ written: 0, unchanged: 1, deleted: 0 });
  });

  it("removes uploaded R2 body when concurrent deleteDocuments completes during docs.put (F9)", async () => {
    const { id: assistantId } = await createAssistantWithKey();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const queue = countingQueue();
    const retriever = memoryRetriever();

    let putEntered!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      putEntered = resolve;
    });
    let releasePut!: () => void;
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });

    let uploadedKey = "";
    const blockingDocs = {
      async put(key: string, value: string) {
        uploadedKey = key;
        putEntered();
        await putGate;
        return env.DOCS.put(key, value);
      },
      async delete(key: string) {
        return env.DOCS.delete(key);
      },
    };

    const pushPromise = pushDocuments({ tenant, docs: blockingDocs, queue }, scope, {
      documents: [
        {
          externalId: "doomed",
          url: "https://example.com/doomed",
          title: "Doomed",
          markdown: "# Doomed\n\nWill be deleted mid-upload.",
        },
      ],
    });

    await putStarted;

    // Concurrent DELETE marks deleting, deletes rev 1 key (no-op), and removes the D1 row.
    const deleted = await deleteDocuments({ tenant, docs: env.DOCS, retriever }, scope, {
      externalIds: ["doomed"],
    });
    expect(deleted).toEqual({ written: 0, unchanged: 0, deleted: 1 });

    // Release the paused put; pushDocuments must detect deletion won and delete the R2 object.
    releasePut();
    const pushResult = await pushPromise;
    expect(pushResult).toEqual({ written: 0, unchanged: 0, deleted: 0 });
    expect(queue.sent).toHaveLength(0);
    expect(await env.DOCS.head(uploadedKey)).toBeNull();
  });

  it("preserves retryable stale object obligation when post-delete R2 cleanup fails (F9)", async () => {
    const { id: assistantId } = await createAssistantWithKey();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const queue = countingQueue();
    const retriever = memoryRetriever();

    let putEntered!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      putEntered = resolve;
    });
    let releasePut!: () => void;
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });

    let uploadedKey = "";
    const flakyDocs = {
      async put(key: string, value: string) {
        uploadedKey = key;
        putEntered();
        await putGate;
        return env.DOCS.put(key, value);
      },
      async delete() {
        throw new Error("R2 delete failed");
      },
    };

    const pushPromise = pushDocuments({ tenant, docs: flakyDocs, queue }, scope, {
      documents: [
        {
          externalId: "doomed-retry",
          url: "https://example.com/doomed-retry",
          title: "Doomed Retry",
          markdown: "# Doomed\n\nCleanup will retry.",
        },
      ],
    });

    await putStarted;

    const deleted = await deleteDocuments({ tenant, docs: env.DOCS, retriever }, scope, {
      externalIds: ["doomed-retry"],
    });
    expect(deleted).toEqual({ written: 0, unchanged: 0, deleted: 1 });

    releasePut();
    await expect(pushPromise).rejects.toThrow("R2 delete failed");

    // Object still exists in R2, but a durable stale_objects record and queue message were created.
    expect(await env.DOCS.head(uploadedKey)).not.toBeNull();
    expect(queue.sent).toHaveLength(1);
    const cleanupMsg = queue.sent[0] as { documentId: string; orgId: string; revision?: number };
    expect(await tenant.documents.listStaleObjects(cleanupMsg.documentId)).toEqual([uploadedKey]);

    // Queue consumer reconciles the stale object and clears the obligation.
    let acked = false;
    await runIngestBatch(
      {
        messages: [
          {
            id: newId("msg"),
            timestamp: new Date(),
            attempts: 1,
            body: cleanupMsg,
            ack() {
              acked = true;
            },
            retry() {},
          },
        ],
      },
      { db: env.DB, docs: env.DOCS, embedder: fakeEmbedder(), retriever },
    );
    expect(acked).toBe(true);
    expect(await env.DOCS.head(uploadedKey)).toBeNull();
    expect(await tenant.documents.listStaleObjects(cleanupMsg.documentId)).toEqual([]);
  });
});
