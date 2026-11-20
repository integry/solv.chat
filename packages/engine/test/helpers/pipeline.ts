import { env } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { forPrincipal, type Tenant } from "../../src/db/tenant.js";
import { runIngestBatch } from "../../src/ingest/consumer.js";
import type { IngestQueueMessage } from "../../src/ingest/documents.js";
import type { RepeatedSourceMessage } from "../../src/ingest/repeatedSource.js";
import type { Embedder, Retriever } from "../../src/providers/retrieval.js";
import type { UsageSink } from "../../src/seams/types.js";
import { acceptQueuedOrg, TEST_ORG_ID } from "./app.js";

/** An empty database with one assistant and its sitemap and entry sources. */
export async function seedSite(): Promise<{
  tenant: Tenant;
  assistantId: string;
  sitemapSourceId: string;
  entrySourceId: string;
}> {
  await env.DB.batch(
    [
      "message_documents",
      "message_traces",
      "preview_traces",
      "usage_daily",
      "messages",
      "conversations",
      "chunks",
      "documents",
      "sources",
      "assistant_versions",
      "assistants",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  await env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING")
    .bind(TEST_ORG_ID, "Test Org")
    .run();
  const tenant = forPrincipal(env.DB, { orgId: TEST_ORG_ID, userId: "usr_1", role: "owner" });
  const assistantId = newId("ast");
  await tenant.assistants.create({
    id: assistantId,
    name: "mcptest",
    publicKey: `pk_${newId("ast").slice(4)}`,
    allowedOrigins: ["https://docs.example.com"],
    createdAt: 1000,
  });
  const sitemapSourceId = newId("src");
  await tenant.sources.create({
    id: sitemapSourceId,
    assistantId,
    kind: "sitemap",
    label: "Docs",
    settings: { url: "https://docs.example.com/sitemap.xml" },
    createdAt: 1000,
  });
  const entrySourceId = newId("src");
  await tenant.sources.create({
    id: entrySourceId,
    assistantId,
    kind: "entry",
    label: "Answers",
    settings: {},
    createdAt: 1000,
  });
  return { tenant, assistantId, sitemapSourceId, entrySourceId };
}

/** A queue that keeps what is sent, for `pushDocuments` and the re-index. */
export function capturingQueue() {
  const messages: IngestQueueMessage[] = [];
  return {
    messages,
    async send(message: IngestQueueMessage) {
      messages.push(message);
    },
    async sendBatch(batch: Array<{ body: IngestQueueMessage }>) {
      messages.push(...batch.map((m) => m.body));
    },
  };
}

/** Delivers queued messages to the ingest consumer, as the Queue would; returns how many were acknowledged. */
export async function runConsumer(
  messages: IngestQueueMessage[],
  deps: { embedder: Embedder; retriever: Retriever; usage?: UsageSink | undefined },
): Promise<{ acked: number; retried: number }> {
  let acked = 0;
  let retried = 0;
  const batch = messages.splice(0).map((body) => ({
    id: newId("msg"),
    timestamp: new Date(),
    attempts: 1,
    body,
    ack() {
      acked++;
    },
    retry() {
      retried++;
    },
  }));
  await runIngestBatch(
    { messages: batch },
    { db: env.DB, resolveOrg: acceptQueuedOrg, docs: env.DOCS, ...deps },
  );
  return { acked, retried };
}

/**
 * Delivers queued messages to the consumer with the queue wired back in, as
 * production does, until nothing more is queued: pages the consumer queues
 * again when their source's repeated blocks change (see "Repeated blocks")
 * are delivered too. `batchSize` messages go to the consumer at a time.
 */
export async function drainConsumer(
  messages: Array<IngestQueueMessage | RepeatedSourceMessage>,
  deps: { embedder: Embedder; retriever: Retriever; usage?: UsageSink | undefined },
  batchSize = 4,
): Promise<{ acked: number; retried: number; rounds: number }> {
  let acked = 0;
  let retried = 0;
  let rounds = 0;
  const queue = {
    async sendBatch(batch: Array<{ body: IngestQueueMessage | RepeatedSourceMessage }>) {
      messages.push(...batch.map((m) => m.body));
    },
  };
  while (messages.length > 0) {
    if (++rounds > 200) throw new Error("the consumer never settled");
    const batch = messages.splice(0, batchSize).map((body) => ({
      id: newId("msg"),
      timestamp: new Date(),
      attempts: 1,
      body,
      ack() {
        acked++;
      },
      retry() {
        retried++;
      },
    }));
    await runIngestBatch(
      { messages: batch },
      { db: env.DB, resolveOrg: acceptQueuedOrg, docs: env.DOCS, queue, ...deps },
    );
  }
  return { acked, retried, rounds };
}
