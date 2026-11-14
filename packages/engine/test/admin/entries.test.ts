import { env } from "cloudflare:test";
import { MAX_DOCUMENT_MARKDOWN_BYTES, newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { saveEntry } from "../../src/admin/entries.js";
import { BadRequest, NotFound } from "../../src/admin/errors.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { runIngestBatch } from "../../src/ingest/consumer.js";
import type { IngestQueueMessage } from "../../src/ingest/documents.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

const ORG_A = TEST_ORG_ID;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";

function countingDocs(bucket: R2Bucket) {
  let puts = 0;
  return {
    get puts() {
      return puts;
    },
    async put(key: string, value: string) {
      puts++;
      return bucket.put(key, value);
    },
    async delete(key: string) {
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

async function seedAssistant(orgId: string): Promise<string> {
  const id = newId("ast");
  await env.DB.prepare(
    `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at)
     VALUES (?1, ?2, ?3, ?4, '[]', ?5)`,
  )
    .bind(id, orgId, "Docs Bot", `pk_${newId("ast").slice(4)}`, Date.now())
    .run();
  return id;
}

describe("admin entries", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  it("writes through ingest, hashes, enqueues, no-ops on identical save, re-enqueues on edit, keeps URL stable, and produces chunks", async () => {
    const assistantId = await seedAssistant(ORG_A);
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const docs = countingDocs(env.DOCS);
    const queue = countingQueue();
    const deps = { tenant, docs, queue, publicBaseUrl: "https://admin.example.com" };

    // 1. First save creates entry source lazily, writes R2, hashes, enqueues.
    const first = await saveEntry(
      deps,
      { orgId: ORG_A },
      {
        assistantId,
        question: "How do I get an API key?",
        answer: "Open Settings and click Generate Key.",
      },
    );
    expect(first.counts).toEqual({ written: 1, unchanged: 0, deleted: 0 });
    expect(docs.puts).toBe(1);
    expect(queue.sent).toHaveLength(1);
    expect(first.url).toMatch(/^https:\/\/admin\.example\.com\/admin\/sources#entry:/);

    const firstDoc = await tenant.documents.get(first.documentId);
    expect(firstDoc).not.toBeNull();
    const firstHash = firstDoc?.contentHash;

    // Run the Queue consumer to verify chunks and vectors are produced via the same ingest path.
    const retriever = memoryRetriever();
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

    const chunksAfterFirst = await tenant.documents.listChunks(first.documentId);
    expect(chunksAfterFirst.length).toBeGreaterThan(0);
    expect(chunksAfterFirst.map((c) => c.text).join("\n")).toContain("Generate Key");

    // 2. Saving the exact same words twice is a no-op (zero new R2 puts, zero new queue sends).
    const repeat = await saveEntry(
      deps,
      { orgId: ORG_A },
      {
        assistantId,
        question: "How do I get an API key?",
        answer: "Open Settings and click Generate Key.",
      },
    );
    expect(repeat.counts).toEqual({ written: 0, unchanged: 1, deleted: 0 });
    expect(docs.puts).toBe(1);
    expect(queue.sent).toHaveLength(1);
    expect(repeat.url).toBe(first.url);

    // 3. Editing changes the hash and enqueues again, while keeping the URL stable.
    const edited = await saveEntry(
      deps,
      { orgId: ORG_A },
      {
        assistantId,
        sourceId: first.sourceId,
        documentId: first.documentId,
        question: "How do I create an API key?",
        answer: "Open Settings > Keys and click Generate Key.",
      },
    );
    expect(edited.documentId).toBe(first.documentId);
    expect(edited.url).toBe(first.url);
    expect(edited.counts).toEqual({ written: 1, unchanged: 0, deleted: 0 });
    expect(docs.puts).toBe(2);
    expect(queue.sent).toHaveLength(2);

    const editedDoc = await tenant.documents.get(edited.documentId);
    expect(editedDoc?.contentHash).not.toBe(firstHash);

    // Run consumer again for the updated entry.
    const secondMsg = queue.sent[1];
    expect(secondMsg).toBeDefined();
    await runIngestBatch(
      {
        messages: secondMsg
          ? [secondMsg].map((body) => ({
              id: newId("msg"),
              timestamp: new Date(),
              attempts: 1,
              body,
              ack() {},
              retry() {},
            }))
          : [],
      },
      { db: env.DB, docs: env.DOCS, embedder: fakeEmbedder(), retriever },
    );

    const chunksAfterEdit = await tenant.documents.listChunks(edited.documentId);
    expect(chunksAfterEdit.map((c) => c.text).join("\n")).toContain("Settings > Keys");
  });

  it("allocates a fresh identity instead of overwriting a renamed entry when reusing its original question", async () => {
    const assistantId = await seedAssistant(ORG_A);
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const docs = countingDocs(env.DOCS);
    const queue = countingQueue();
    const deps = { tenant, docs, queue, publicBaseUrl: "https://admin.example.com" };

    // 1. Create "Original question".
    const original = await saveEntry(
      deps,
      { orgId: ORG_A },
      { assistantId, question: "Original question", answer: "Original answer." },
    );

    // 2. Rename that document to "Different question" (retaining its original externalId).
    const renamed = await saveEntry(
      deps,
      { orgId: ORG_A },
      {
        assistantId,
        sourceId: original.sourceId,
        documentId: original.documentId,
        question: "Different question",
        answer: "Different answer.",
      },
    );
    expect(renamed.documentId).toBe(original.documentId);
    expect(renamed.url).toBe(original.url);

    // 3. Create a brand new entry with "Original question" again.
    const recreated = await saveEntry(
      deps,
      { orgId: ORG_A },
      { assistantId, question: "Original question", answer: "New answer." },
    );

    expect(recreated.documentId).not.toBe(original.documentId);
    expect(recreated.url).not.toBe(original.url);
    expect(recreated.counts).toEqual({ written: 1, unchanged: 0, deleted: 0 });

    const allDocs = await tenant.documents.listBySource(original.sourceId);
    expect(allDocs).toHaveLength(2);
    expect(allDocs.find((d) => d.id === original.documentId)?.title).toBe("Different question");
    expect(allDocs.find((d) => d.id === recreated.documentId)?.title).toBe("Original question");
  });

  it("preserves entry identity without creating duplicates when retrying a failed queue send after a rename", async () => {
    const assistantId = await seedAssistant(ORG_A);
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const docs = countingDocs(env.DOCS);
    const queue = countingQueue();
    const deps = { tenant, docs, queue, publicBaseUrl: "https://admin.example.com" };

    // 1. Create question A and rename it to question B.
    const original = await saveEntry(
      deps,
      { orgId: ORG_A },
      { assistantId, question: "Question A", answer: "Answer A1" },
    );
    await saveEntry(
      deps,
      { orgId: ORG_A },
      {
        assistantId,
        sourceId: original.sourceId,
        documentId: original.documentId,
        question: "Question B",
        answer: "Answer B",
      },
    );

    // 2. Submit a new entry for Question A where queue.send fails after R2 + D1 write.
    const failingQueue = {
      async send() {
        throw new Error("queue unavailable");
      },
    };
    await expect(
      saveEntry(
        { tenant, docs, queue: failingQueue, publicBaseUrl: "https://admin.example.com" },
        { orgId: ORG_A },
        { assistantId, question: "Question A", answer: "Answer A2" },
      ),
    ).rejects.toThrow("queue unavailable");

    const docsAfterFailure = await tenant.documents.listBySource(original.sourceId);
    expect(docsAfterFailure).toHaveLength(2);
    const pendingDoc = docsAfterFailure.find((d) => d.id !== original.documentId);
    expect(pendingDoc?.title).toBe("Question A");

    // 3. Retry the exact same submission; it must recover the pending entry without duplicating it.
    const retried = await saveEntry(
      deps,
      { orgId: ORG_A },
      { assistantId, question: "Question A", answer: "Answer A2" },
    );

    expect(retried.documentId).toBe(pendingDoc?.id);
    expect(retried.url).toBe(pendingDoc?.url);
    expect(retried.counts).toEqual({ written: 1, unchanged: 0, deleted: 0 });
    expect(await tenant.documents.listBySource(original.sourceId)).toHaveLength(2);
    expect(queue.sent.at(-1)?.documentId).toBe(pendingDoc?.id);
  });

  it("rejects cross-org assistant or source access with NotFound", async () => {
    const assistantA = await seedAssistant(ORG_A);
    const tenantB = forPrincipal(env.DB, { orgId: ORG_B, userId: "owner", role: "owner" });

    await expect(
      saveEntry(
        {
          tenant: tenantB,
          docs: env.DOCS,
          queue: countingQueue(),
          publicBaseUrl: "https://admin.example.com",
        },
        { orgId: ORG_B },
        { assistantId: assistantA, question: "Q", answer: "A" },
      ),
    ).rejects.toBeInstanceOf(NotFound);

    const appB = createTestApp({
      auth: {
        async authenticate() {
          return { orgId: ORG_B, userId: "owner", role: "owner" };
        },
        async login() {
          return Response.json({ ok: true });
        },
        async logout() {
          return Response.json({ ok: true });
        },
      },
    });
    const res = await appB.fetch(
      new Request(`https://example.com/api/admin/assistants/${assistantA}/entries`, {
        method: "POST",
        headers: { Origin: "https://example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ question: "Q", answer: "A" }),
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });

  it("rejects answers whose generated heading plus answer exceeds MAX_DOCUMENT_MARKDOWN_BYTES with 400 before creating a source", async () => {
    const assistantId = await seedAssistant(ORG_A);
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const docs = countingDocs(env.DOCS);
    const queue = countingQueue();
    const deps = { tenant, docs, queue, publicBaseUrl: "https://admin.example.com" };

    const exactLimitAnswer = "a".repeat(MAX_DOCUMENT_MARKDOWN_BYTES);
    await expect(
      saveEntry(deps, { orgId: ORG_A }, { assistantId, question: "Q", answer: exactLimitAnswer }),
    ).rejects.toBeInstanceOf(BadRequest);

    // Must not lazily create an empty entry source on validation failure.
    expect(await tenant.sources.listWithStats(assistantId)).toEqual([]);
    expect(docs.puts).toBe(0);
    expect(queue.sent).toHaveLength(0);

    // HTTP route returns 400 with an answer field error (not 413).
    const app = createTestApp();
    const res = await app.fetch(
      new Request(`https://example.com/api/admin/assistants/${assistantId}/entries`, {
        method: "POST",
        headers: { Origin: "https://example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ question: "Q", answer: exactLimitAnswer }),
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fields?: string[] };
    expect(body.fields?.some((f) => f.startsWith("answer: "))).toBe(true);
    expect(await tenant.sources.listWithStats(assistantId)).toEqual([]);
  });
});
