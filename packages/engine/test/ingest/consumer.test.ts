import { env } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { describe, expect, it } from "vitest";
import { forIngestScope } from "../../src/db/tenant.js";
import { runIngestBatch } from "../../src/ingest/consumer.js";
import {
  contentHash,
  deleteDocuments,
  documentObjectKey,
  type IngestQueueMessage,
  pushDocuments,
} from "../../src/ingest/documents.js";
import { resolveChunks } from "../../src/ingest/resolve.js";
import type { Embedder, Retriever } from "../../src/providers/retrieval.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { TEST_ORG_ID } from "../helpers/app.js";

async function seedOrgAndAssistant(orgId = TEST_ORG_ID) {
  const assistantId = newId("ast");
  const sourceId = newId("src");
  await env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING")
    .bind(orgId, "Test Org")
    .run();
  await env.DB.prepare(
    `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at)
     VALUES (?1, ?2, ?3, ?4, '[]', ?5)`,
  )
    .bind(assistantId, orgId, "Bot", `pk_${newId("ast").slice(4)}`, Date.now())
    .run();
  await env.DB.prepare(
    `INSERT INTO sources (id, org_id, assistant_id, kind, label, settings, is_default, created_at)
     VALUES (?1, ?2, ?3, 'push', 'Push', '{}', 1, ?4)`,
  )
    .bind(sourceId, orgId, assistantId, Date.now())
    .run();
  return { orgId, assistantId, sourceId };
}

async function seedDocument(
  sourceId: string,
  title: string,
  markdown: string,
  orgId = TEST_ORG_ID,
  externalId = "doc-1",
  url = "https://example.com/doc",
) {
  const documentId = newId("doc");
  const hash = await contentHash(title, markdown);
  const bodyKey = documentObjectKey(orgId, documentId);
  const tenant = forIngestScope(env.DB, { orgId, assistantId: "" });
  await tenant.documents.upsert({
    id: documentId,
    sourceId,
    externalId,
    url,
    title,
    contentHash: hash,
    bodyKey,
    updatedAt: Date.now(),
  });
  await env.DOCS.put(bodyKey, markdown);
  return { documentId, hash, bodyKey, tenant };
}

function makeMessage(body: IngestQueueMessage) {
  let acked = false;
  let retried = false;
  return {
    id: newId("msg"),
    timestamp: new Date(),
    attempts: 1,
    body,
    ack() {
      acked = true;
    },
    retry() {
      retried = true;
    },
    get acked() {
      return acked;
    },
    get retried() {
      return retried;
    },
  };
}

describe("ingest consumer", () => {
  it("chunks, embeds, and upserts every chunk with orgId and assistantId metadata", async () => {
    const { assistantId, sourceId } = await seedOrgAndAssistant();
    const { documentId, hash, tenant } = await seedDocument(
      sourceId,
      "Guide",
      "# Intro\n\nFirst paragraph.\n\n# Usage\n\nSecond paragraph.",
    );

    const embedder = fakeEmbedder();
    const retriever = memoryRetriever();
    const msg = makeMessage({ orgId: TEST_ORG_ID, documentId, contentHash: hash });

    await runIngestBatch({ messages: [msg] }, { db: env.DB, docs: env.DOCS, embedder, retriever });

    expect(msg.acked).toBe(true);
    const chunks = await tenant.documents.listChunks(documentId);
    expect(chunks.map((c) => c.headingPath)).toEqual(["Intro", "Usage"]);
    const savedDoc = await tenant.documents.get(documentId);
    expect(savedDoc?.indexedHash).toBe(hash);

    const vectors = retriever.all();
    expect(vectors).toHaveLength(2);
    expect(vectors.every((v) => v.orgId === TEST_ORG_ID && v.assistantId === assistantId)).toBe(
      true,
    );
  });

  it("replaces chunk rows with fresh chunk ids and removes stale vectors on re-index", async () => {
    const { sourceId } = await seedOrgAndAssistant();
    const {
      documentId,
      hash: hash1,
      tenant,
    } = await seedDocument(sourceId, "Doc", "# A\n\nOne.\n\n# B\n\nTwo.");

    const embedder = fakeEmbedder();
    const retriever = memoryRetriever();

    await runIngestBatch(
      { messages: [makeMessage({ orgId: TEST_ORG_ID, documentId, contentHash: hash1 })] },
      { db: env.DB, docs: env.DOCS, embedder, retriever },
    );
    const oldChunks = await tenant.documents.listChunks(documentId);
    expect(oldChunks).toHaveLength(2);

    const newMarkdown = "# Updated\n\nOnly one chunk.";
    const hash2 = await contentHash("Doc", newMarkdown);
    const bodyKey2 = documentObjectKey(TEST_ORG_ID, documentId);
    await tenant.documents.upsert({
      id: documentId,
      sourceId,
      externalId: "doc-1",
      url: "https://example.com/doc",
      title: "Doc",
      contentHash: hash2,
      bodyKey: bodyKey2,
      updatedAt: Date.now(),
    });
    await env.DOCS.put(bodyKey2, newMarkdown);

    await runIngestBatch(
      { messages: [makeMessage({ orgId: TEST_ORG_ID, documentId, contentHash: hash2 })] },
      { db: env.DB, docs: env.DOCS, embedder, retriever },
    );

    const newChunks = await tenant.documents.listChunks(documentId);
    expect(newChunks).toHaveLength(1);
    expect(newChunks[0]?.text).toBe("Only one chunk.");
    expect(oldChunks.map((c) => c.id)).not.toContain(newChunks[0]?.id);
    expect(retriever.all().map((v) => v.chunkId)).toEqual([newChunks[0]?.id]);
  });

  it("duplicate delivery of the same message indexes once (embedder called once)", async () => {
    const { sourceId } = await seedOrgAndAssistant();
    const { documentId, hash, tenant } = await seedDocument(sourceId, "Doc", "# Title\n\nBody.");

    let embedCalls = 0;
    const baseEmbedder = fakeEmbedder();
    const countingEmbedder: Embedder = {
      dimensions: baseEmbedder.dimensions,
      async embed(texts) {
        embedCalls++;
        return baseEmbedder.embed(texts);
      },
    };
    const retriever = memoryRetriever();

    const msg1 = makeMessage({ orgId: TEST_ORG_ID, documentId, contentHash: hash });
    const msg2 = makeMessage({ orgId: TEST_ORG_ID, documentId, contentHash: hash });

    await runIngestBatch(
      { messages: [msg1] },
      { db: env.DB, docs: env.DOCS, embedder: countingEmbedder, retriever },
    );
    const chunksAfterFirst = await tenant.documents.listChunks(documentId);

    await runIngestBatch(
      { messages: [msg2] },
      { db: env.DB, docs: env.DOCS, embedder: countingEmbedder, retriever },
    );

    expect(msg1.acked).toBe(true);
    expect(msg2.acked).toBe(true);
    expect(embedCalls).toBe(1);
    expect(await tenant.documents.listChunks(documentId)).toEqual(chunksAfterFirst);
  });

  it("an older message arriving after a newer push changes nothing", async () => {
    const { assistantId, sourceId } = await seedOrgAndAssistant();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const queue: IngestQueueMessage[] = [];
    const retriever = memoryRetriever();
    const embedder = fakeEmbedder();

    await pushDocuments(
      {
        tenant,
        docs: env.DOCS,
        queue: {
          async send(m) {
            queue.push(m);
          },
        },
      },
      scope,
      {
        documents: [
          {
            externalId: "page",
            url: "https://example.com/page",
            title: "Page",
            markdown: "# V1\n\nOld content.",
          },
        ],
      },
    );
    const oldMsg = makeMessage(queue[0] as IngestQueueMessage);

    await pushDocuments(
      {
        tenant,
        docs: env.DOCS,
        queue: {
          async send(m) {
            queue.push(m);
          },
        },
      },
      scope,
      {
        documents: [
          {
            externalId: "page",
            url: "https://example.com/page",
            title: "Page",
            markdown: "# V2\n\nNew content.",
          },
        ],
      },
    );
    const newMsg = makeMessage(queue[1] as IngestQueueMessage);

    // Process newer message first.
    await runIngestBatch(
      { messages: [newMsg] },
      { db: env.DB, docs: env.DOCS, embedder, retriever },
    );
    const chunksAfterNew = await tenant.documents.listChunks(newMsg.body.documentId);
    expect(chunksAfterNew.map((c) => c.text)).toEqual(["New content."]);

    // Older message arrives later: must ack and leave V2 chunks untouched.
    let embedCallsOnOld = 0;
    await runIngestBatch(
      { messages: [oldMsg] },
      {
        db: env.DB,
        docs: env.DOCS,
        embedder: {
          dimensions: embedder.dimensions,
          async embed(texts) {
            embedCallsOnOld++;
            return embedder.embed(texts);
          },
        },
        retriever,
      },
    );

    expect(oldMsg.acked).toBe(true);
    expect(embedCallsOnOld).toBe(0);
    expect(await tenant.documents.listChunks(newMsg.body.documentId)).toEqual(chunksAfterNew);
    const doc = await tenant.documents.get(newMsg.body.documentId);
    expect(doc?.indexedHash).toBe(newMsg.body.contentHash);
    void sourceId;
  });

  it("refuses old consumer commit when superseded mid-embedding and keeps only new content chunks", async () => {
    const { assistantId } = await seedOrgAndAssistant();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const queue: IngestQueueMessage[] = [];
    const retriever = memoryRetriever();
    const baseEmbedder = fakeEmbedder();

    await pushDocuments(
      {
        tenant,
        docs: env.DOCS,
        queue: {
          async send(m) {
            queue.push(m);
          },
        },
      },
      scope,
      {
        documents: [
          {
            externalId: "page",
            url: "https://example.com/page",
            title: "Page",
            markdown: "# V1\n\nOld content.",
          },
        ],
      },
    );
    const oldMsg = makeMessage(queue[0] as IngestQueueMessage);

    let embedEntered!: () => void;
    const embedStarted = new Promise<void>((resolve) => {
      embedEntered = resolve;
    });
    let releaseEmbed!: () => void;
    const embedGate = new Promise<void>((resolve) => {
      releaseEmbed = resolve;
    });

    const pausingEmbedder: Embedder = {
      dimensions: baseEmbedder.dimensions,
      async embed(texts) {
        embedEntered();
        await embedGate;
        return baseEmbedder.embed(texts);
      },
    };

    const oldRun = runIngestBatch(
      { messages: [oldMsg] },
      { db: env.DB, docs: env.DOCS, embedder: pausingEmbedder, retriever },
    );

    await embedStarted;

    // Supersede with a new push while old consumer is mid-embedding.
    await pushDocuments(
      {
        tenant,
        docs: env.DOCS,
        queue: {
          async send(m) {
            queue.push(m);
          },
        },
      },
      scope,
      {
        documents: [
          {
            externalId: "page",
            url: "https://example.com/page",
            title: "Page",
            markdown: "# V2\n\nNew content.",
          },
        ],
      },
    );
    const newMsg = makeMessage(queue[1] as IngestQueueMessage);

    // Let old consumer finish embedding, upsert, and attempt its guarded D1 commit.
    releaseEmbed();
    await oldRun;
    expect(oldMsg.acked).toBe(true);
    // Old consumer's commit was refused; D1 has no chunks and indexedHash is still null.
    expect(await tenant.documents.listChunks(oldMsg.body.documentId)).toEqual([]);
    expect((await tenant.documents.get(oldMsg.body.documentId))?.indexedHash).toBeNull();

    // Process the new message; D1 holds only the new content's chunks.
    await runIngestBatch(
      { messages: [newMsg] },
      { db: env.DB, docs: env.DOCS, embedder: baseEmbedder, retriever },
    );
    expect(newMsg.acked).toBe(true);
    const finalChunks = await tenant.documents.listChunks(newMsg.body.documentId);
    expect(finalChunks.map((c) => c.text)).toEqual(["New content."]);
    expect((await tenant.documents.get(newMsg.body.documentId))?.indexedHash).toBe(
      newMsg.body.contentHash,
    );
  });

  it("leaves chunks and indexed_hash unchanged on embedder, upsert, and D1 commit failures, and succeeds on retry", async () => {
    const { sourceId } = await seedOrgAndAssistant();
    const {
      documentId,
      hash: hash1,
      tenant,
    } = await seedDocument(sourceId, "Doc", "# V1\n\nInitial.");

    const baseEmbedder = fakeEmbedder();
    const baseRetriever = memoryRetriever();

    await runIngestBatch(
      { messages: [makeMessage({ orgId: TEST_ORG_ID, documentId, contentHash: hash1 })] },
      { db: env.DB, docs: env.DOCS, embedder: baseEmbedder, retriever: baseRetriever },
    );
    const v1Chunks = await tenant.documents.listChunks(documentId);
    expect(v1Chunks.map((c) => c.text)).toEqual(["Initial."]);

    // Update document to V2.
    const v2Markdown = "# V2\n\nUpdated.";
    const hash2 = await contentHash("Doc", v2Markdown);
    const bodyKey2 = documentObjectKey(TEST_ORG_ID, documentId);
    await tenant.documents.upsert({
      id: documentId,
      sourceId,
      externalId: "doc-1",
      url: "https://example.com/doc",
      title: "Doc",
      contentHash: hash2,
      bodyKey: bodyKey2,
      updatedAt: Date.now(),
    });
    await env.DOCS.put(bodyKey2, v2Markdown);

    // 1. Failure in embedder.
    const embedFailMsg = makeMessage({ orgId: TEST_ORG_ID, documentId, contentHash: hash2 });
    await runIngestBatch(
      { messages: [embedFailMsg] },
      {
        db: env.DB,
        docs: env.DOCS,
        embedder: {
          dimensions: baseEmbedder.dimensions,
          async embed() {
            throw new Error("embedder down");
          },
        },
        retriever: baseRetriever,
      },
    );
    expect(embedFailMsg.retried).toBe(true);
    expect(embedFailMsg.acked).toBe(false);
    expect(await tenant.documents.listChunks(documentId)).toEqual(v1Chunks);
    expect((await tenant.documents.get(documentId))?.indexedHash).toBe(hash1);

    // 2. Failure in vector upsert.
    const upsertFailMsg = makeMessage({ orgId: TEST_ORG_ID, documentId, contentHash: hash2 });
    await runIngestBatch(
      { messages: [upsertFailMsg] },
      {
        db: env.DB,
        docs: env.DOCS,
        embedder: baseEmbedder,
        retriever: {
          ...baseRetriever,
          async upsert() {
            throw new Error("vectorize down");
          },
        },
      },
    );
    expect(upsertFailMsg.retried).toBe(true);
    expect(upsertFailMsg.acked).toBe(false);
    expect(await tenant.documents.listChunks(documentId)).toEqual(v1Chunks);
    expect((await tenant.documents.get(documentId))?.indexedHash).toBe(hash1);

    // 3. Failure in D1 commit (db.batch).
    const failingDb = {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(stmts: D1PreparedStatement[]) {
        if (stmts.length >= 3) {
          throw new Error("D1 commit failed");
        }
        return env.DB.batch(stmts);
      },
    } as unknown as D1Database;

    const commitFailMsg = makeMessage({ orgId: TEST_ORG_ID, documentId, contentHash: hash2 });
    await runIngestBatch(
      { messages: [commitFailMsg] },
      { db: failingDb, docs: env.DOCS, embedder: baseEmbedder, retriever: baseRetriever },
    );
    expect(commitFailMsg.retried).toBe(true);
    expect(commitFailMsg.acked).toBe(false);
    expect(await tenant.documents.listChunks(documentId)).toEqual(v1Chunks);
    expect((await tenant.documents.get(documentId))?.indexedHash).toBe(hash1);

    // 4. Retry succeeds cleanly.
    const retryMsg = makeMessage({ orgId: TEST_ORG_ID, documentId, contentHash: hash2 });
    await runIngestBatch(
      { messages: [retryMsg] },
      { db: env.DB, docs: env.DOCS, embedder: baseEmbedder, retriever: baseRetriever },
    );
    expect(retryMsg.acked).toBe(true);
    const v2Chunks = await tenant.documents.listChunks(documentId);
    expect(v2Chunks.map((c) => c.text)).toEqual(["Updated."]);
    expect((await tenant.documents.get(documentId))?.indexedHash).toBe(hash2);
  });

  it("delete then late consumer: no chunk rows come back", async () => {
    const { assistantId } = await seedOrgAndAssistant();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const queue: IngestQueueMessage[] = [];
    const retriever = memoryRetriever();

    await pushDocuments(
      {
        tenant,
        docs: env.DOCS,
        queue: {
          async send(m) {
            queue.push(m);
          },
        },
      },
      scope,
      {
        documents: [
          {
            externalId: "ephemeral",
            url: "https://example.com/ephemeral",
            title: "Ephemeral",
            markdown: "# Ephemeral\n\nGone soon.",
          },
        ],
      },
    );
    const msg = makeMessage(queue[0] as IngestQueueMessage);

    await deleteDocuments({ tenant, docs: env.DOCS, retriever }, scope, {
      externalIds: ["ephemeral"],
    });

    await runIngestBatch(
      { messages: [msg] },
      { db: env.DB, docs: env.DOCS, embedder: fakeEmbedder(), retriever },
    );

    expect(msg.acked).toBe(true);
    expect(await tenant.documents.get(msg.body.documentId)).toBeNull();
    expect(await tenant.documents.listChunks(msg.body.documentId)).toEqual([]);
  });

  it("resolveChunks drops missing, other-assistant, and other-org ids and preserves score order", async () => {
    const orgA = await seedOrgAndAssistant("org_a");
    const orgB = await seedOrgAndAssistant("org_b");
    const astA2SourceId = newId("src");
    const astA2Id = newId("ast");
    await env.DB.prepare(
      `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at)
       VALUES (?1, ?2, ?3, ?4, '[]', ?5)`,
    )
      .bind(astA2Id, orgA.orgId, "Bot A2", `pk_${newId("ast").slice(4)}`, Date.now())
      .run();
    await env.DB.prepare(
      `INSERT INTO sources (id, org_id, assistant_id, kind, label, settings, is_default, created_at)
       VALUES (?1, ?2, ?3, 'push', 'Push', '{}', 1, ?4)`,
    )
      .bind(astA2SourceId, orgA.orgId, astA2Id, Date.now())
      .run();

    const docA1 = await seedDocument(
      orgA.sourceId,
      "Title A1",
      "# Section 1\n\nAlpha.\n\n# Section 2\n\nBeta.",
      orgA.orgId,
      "a1",
      "https://a.test/1",
    );
    const docA2 = await seedDocument(
      astA2SourceId,
      "Title A2",
      "# Other Assistant\n\nGamma.",
      orgA.orgId,
      "a2",
      "https://a.test/2",
    );
    const docB = await seedDocument(
      orgB.sourceId,
      "Title B",
      "# Other Org\n\nDelta.",
      orgB.orgId,
      "b1",
      "https://b.test/1",
    );

    const retriever = memoryRetriever();
    const embedder = fakeEmbedder();
    await runIngestBatch(
      {
        messages: [
          makeMessage({ orgId: orgA.orgId, documentId: docA1.documentId, contentHash: docA1.hash }),
          makeMessage({ orgId: orgA.orgId, documentId: docA2.documentId, contentHash: docA2.hash }),
          makeMessage({ orgId: orgB.orgId, documentId: docB.documentId, contentHash: docB.hash }),
        ],
      },
      { db: env.DB, docs: env.DOCS, embedder, retriever },
    );

    const a1Chunks = await docA1.tenant.documents.listChunks(docA1.documentId);
    const a2Chunks = await docA2.tenant.documents.listChunks(docA2.documentId);
    const bChunks = await docB.tenant.documents.listChunks(docB.documentId);

    const tenantA = forIngestScope(env.DB, { orgId: orgA.orgId, assistantId: orgA.assistantId });
    const resolved = await resolveChunks(tenantA, orgA.assistantId, [
      { chunkId: "chk_missing", score: 0.99 },
      { chunkId: bChunks[0]?.id ?? "", score: 0.95 },
      { chunkId: a1Chunks[1]?.id ?? "", score: 0.9 },
      { chunkId: a2Chunks[0]?.id ?? "", score: 0.85 },
      { chunkId: a1Chunks[0]?.id ?? "", score: 0.7 },
    ]);

    expect(resolved).toEqual([
      {
        chunkId: a1Chunks[1]?.id,
        documentId: docA1.documentId,
        score: 0.9,
        text: "Beta.",
        headingPath: "Section 2",
        url: "https://a.test/1",
        title: "Title A1",
      },
      {
        chunkId: a1Chunks[0]?.id,
        documentId: docA1.documentId,
        score: 0.7,
        text: "Alpha.",
        headingPath: "Section 1",
        url: "https://a.test/1",
        title: "Title A1",
      },
    ]);
  });

  it("cleanup failure after a successful commit does not fail or retry the message", async () => {
    const { sourceId } = await seedOrgAndAssistant();
    const {
      documentId,
      hash: hash1,
      tenant,
    } = await seedDocument(sourceId, "Doc", "# V1\n\nFirst.");

    const embedder = fakeEmbedder();
    const baseRetriever = memoryRetriever();

    await runIngestBatch(
      { messages: [makeMessage({ orgId: TEST_ORG_ID, documentId, contentHash: hash1 })] },
      { db: env.DB, docs: env.DOCS, embedder, retriever: baseRetriever },
    );

    const v2Markdown = "# V2\n\nSecond.";
    const hash2 = await contentHash("Doc", v2Markdown);
    const bodyKey2 = documentObjectKey(TEST_ORG_ID, documentId);
    await tenant.documents.upsert({
      id: documentId,
      sourceId,
      externalId: "doc-1",
      url: "https://example.com/doc",
      title: "Doc",
      contentHash: hash2,
      bodyKey: bodyKey2,
      updatedAt: Date.now(),
    });
    await env.DOCS.put(bodyKey2, v2Markdown);

    const failingCleanupRetriever: Retriever = {
      upsert: baseRetriever.upsert,
      query: baseRetriever.query,
      async remove() {
        throw new Error("Vectorize remove failed");
      },
    };

    const msg = makeMessage({ orgId: TEST_ORG_ID, documentId, contentHash: hash2 });
    await runIngestBatch(
      { messages: [msg] },
      { db: env.DB, docs: env.DOCS, embedder, retriever: failingCleanupRetriever },
    );

    expect(msg.acked).toBe(true);
    expect(msg.retried).toBe(false);
    const chunks = await tenant.documents.listChunks(documentId);
    expect(chunks.map((c) => c.text)).toEqual(["Second."]);
    expect((await tenant.documents.get(documentId))?.indexedHash).toBe(hash2);
  });

  it("A -> B -> A with old message for A delivered last ends indexed with A's chunks and body object", async () => {
    const { assistantId } = await seedOrgAndAssistant();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const queue: IngestQueueMessage[] = [];
    const retriever = memoryRetriever();
    const embedder = fakeEmbedder();
    const pushDeps = {
      tenant,
      docs: env.DOCS,
      queue: {
        async send(m: IngestQueueMessage) {
          queue.push(m);
        },
      },
    };

    const docA = {
      externalId: "page",
      url: "https://example.com/page",
      title: "Page",
      markdown: "# A\n\nContent A.",
    };
    const docB = {
      externalId: "page",
      url: "https://example.com/page",
      title: "Page",
      markdown: "# B\n\nContent B.",
    };

    await pushDocuments(pushDeps, scope, { documents: [docA] });
    const msgA1 = makeMessage(queue[0] as IngestQueueMessage);

    await pushDocuments(pushDeps, scope, { documents: [docB] });
    const msgB = makeMessage(queue[1] as IngestQueueMessage);

    await runIngestBatch({ messages: [msgB] }, { db: env.DB, docs: env.DOCS, embedder, retriever });

    await pushDocuments(pushDeps, scope, { documents: [docA] });
    const msgA2 = makeMessage(queue[2] as IngestQueueMessage);

    await runIngestBatch(
      { messages: [msgA2] },
      { db: env.DB, docs: env.DOCS, embedder, retriever },
    );

    // Deliver old message for A last: must ack without deleting the second A's body.
    await runIngestBatch(
      { messages: [msgA1] },
      { db: env.DB, docs: env.DOCS, embedder, retriever },
    );

    expect(msgB.acked).toBe(true);
    expect(msgA2.acked).toBe(true);
    expect(msgA1.acked).toBe(true);

    const saved = await tenant.documents.get(msgA2.body.documentId);
    expect(saved?.indexedHash).toBe(msgA2.body.contentHash);
    expect(saved?.bodyKey).not.toBeNull();
    if (!saved?.bodyKey) throw new Error("expected bodyKey on saved document");
    expect(await env.DOCS.head(saved.bodyKey)).not.toBeNull();

    const chunks = await tenant.documents.listChunks(msgA2.body.documentId);
    expect(chunks.map((c) => c.text)).toEqual(["Content A."]);
  });

  it("isolates failures in a batch: first and third acked and indexed, second retried", async () => {
    const { sourceId } = await seedOrgAndAssistant();
    const doc1 = await seedDocument(sourceId, "One", "# One\n\nFirst doc.", TEST_ORG_ID, "d1");
    const doc2 = await seedDocument(sourceId, "Two", "# Two\n\nSecond doc.", TEST_ORG_ID, "d2");
    const doc3 = await seedDocument(sourceId, "Three", "# Three\n\nThird doc.", TEST_ORG_ID, "d3");

    const baseEmbedder = fakeEmbedder();
    const flakyEmbedder: Embedder = {
      dimensions: baseEmbedder.dimensions,
      async embed(texts) {
        if (texts.some((t) => t.includes("Second doc."))) {
          throw new Error("embedder failed for doc2");
        }
        return baseEmbedder.embed(texts);
      },
    };
    const retriever = memoryRetriever();

    const msg1 = makeMessage({
      orgId: TEST_ORG_ID,
      documentId: doc1.documentId,
      contentHash: doc1.hash,
    });
    const msg2 = makeMessage({
      orgId: TEST_ORG_ID,
      documentId: doc2.documentId,
      contentHash: doc2.hash,
    });
    const msg3 = makeMessage({
      orgId: TEST_ORG_ID,
      documentId: doc3.documentId,
      contentHash: doc3.hash,
    });

    await runIngestBatch(
      { messages: [msg1, msg2, msg3] },
      { db: env.DB, docs: env.DOCS, embedder: flakyEmbedder, retriever },
    );

    expect(msg1.acked).toBe(true);
    expect(msg1.retried).toBe(false);
    expect(msg2.acked).toBe(false);
    expect(msg2.retried).toBe(true);
    expect(msg3.acked).toBe(true);
    expect(msg3.retried).toBe(false);

    expect((await doc1.tenant.documents.listChunks(doc1.documentId)).map((c) => c.text)).toEqual([
      "First doc.",
    ]);
    expect(await doc2.tenant.documents.listChunks(doc2.documentId)).toEqual([]);
    expect((await doc3.tenant.documents.listChunks(doc3.documentId)).map((c) => c.text)).toEqual([
      "Third doc.",
    ]);
  });
});
