import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { saveEntry } from "../../src/admin/entries.js";
import { ReindexRefused, reindexAssistant, reindexStatus } from "../../src/admin/reindex.js";
import type { Tenant } from "../../src/db/tenant.js";
import { pushDocuments } from "../../src/ingest/documents.js";
import { INGEST_VERSION } from "../../src/ingest/version.js";
import type { Embedder } from "../../src/providers/retrieval.js";
import type { LimitAction, UsageEvent } from "../../src/seams/types.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { tokenEmbedder } from "../fakes/tokenEmbedder.js";
import { TEST_ORG_ID } from "../helpers/app.js";
import { capturingQueue, runConsumer, seedSite } from "../helpers/pipeline.js";

const OLD_PAGE = [
  "# Opening hours",
  "We are open Tuesday to Saturday, from seven in the morning until half past three in the afternoon. On public holidays we open at nine and close at one. The kitchen stops taking orders half an hour before we close.",
  "## Elsewhere",
  "- Menu - Bookings - Contact",
].join("\n\n");

describe("re-index from stored text", () => {
  let site: Awaited<ReturnType<typeof seedSite>>;
  let tenant: Tenant;
  const retriever = memoryRetriever();
  let embedCalls: number;
  let embedder: Embedder;
  let usage: UsageEvent[];
  let limitCalls: Array<{ assistantId: string; action: LimitAction }>;

  beforeEach(async () => {
    site = await seedSite();
    tenant = site.tenant;
    embedCalls = 0;
    const inner = tokenEmbedder();
    embedder = {
      dimensions: inner.dimensions,
      async embed(texts, onBilled) {
        embedCalls++;
        return inner.embed(texts, onBilled);
      },
    };
    usage = [];
    limitCalls = [];
  });

  const deps = (refuse = false) => ({
    tenant,
    orgId: TEST_ORG_ID,
    queue: capturingQueue(),
    limits: {
      async check(_orgId: string, assistantId: string, action: LimitAction) {
        limitCalls.push({ assistantId, action });
        return refuse
          ? { ok: false as const, reason: "rate_limit" as const }
          : { ok: true as const };
      },
    },
  });
  const consumerDeps = () => ({
    embedder,
    retriever,
    usage: { record: async (event: UsageEvent) => void usage.push(event) },
  });

  /** A page and a written answer, indexed, then marked as built by version 1. */
  async function seedOldContent() {
    const queue = capturingQueue();
    await pushDocuments(
      { tenant, docs: env.DOCS, queue },
      { orgId: TEST_ORG_ID, assistantId: site.assistantId },
      {
        sourceId: site.sitemapSourceId,
        documents: [
          {
            externalId: "hours",
            url: "https://docs.example.com/hours",
            title: "Hours",
            markdown: OLD_PAGE,
          },
        ],
      },
    );
    await saveEntry(
      { tenant, docs: env.DOCS, queue, publicBaseUrl: "https://solv.example" },
      { orgId: TEST_ORG_ID },
      { assistantId: site.assistantId, question: "Do you open on Sunday?", answer: "No, never." },
    );
    await runConsumer(queue.messages, consumerDeps());
    // As every document stored before issue #123: version 1, with the tiny
    // chunk the old chunker made (here, the "Elsewhere" list on its own).
    await env.DB.prepare("UPDATE documents SET ingest_version = 1").run();
    const hours = await tenant.documents.getByExternalId(site.sitemapSourceId, "hours");
    if (hours === null) throw new Error("no page");
    await tenant.documents.replaceChunks(hours.id, [
      {
        id: "chk_old_1",
        ordinal: 0,
        text: OLD_PAGE.split("\n\n")[1] as string,
        headingPath: "Opening hours",
      },
      {
        id: "chk_old_2",
        ordinal: 1,
        text: "- Menu - Bookings - Contact",
        headingPath: "Opening hours > Elsewhere",
      },
    ]);
    embedCalls = 0;
    usage.length = 0;
    return hours;
  }

  it("rebuilds an unchanged document once, through the limits and usage seams, and is idempotent", async () => {
    const hours = await seedOldContent();
    expect(await reindexStatus(tenant, site.assistantId)).toEqual({ outdated: 2 });

    const first = deps();
    expect(await reindexAssistant(first, site.assistantId)).toEqual({ queued: 2, remaining: 0 });
    expect(limitCalls).toEqual([{ assistantId: site.assistantId, action: { kind: "ingest" } }]);
    expect(first.queue.messages).toHaveLength(2);
    // Press it twice before the queue runs: the same documents again.
    const second = deps();
    await reindexAssistant(second, site.assistantId);
    const messages = [...first.queue.messages, ...second.queue.messages];

    const result = await runConsumer(messages, consumerDeps());
    expect(result).toEqual({ acked: 4, retried: 0 });
    // Embedded once per document, not once per message: the second message
    // for each finds it already at the current version.
    expect(embedCalls).toBe(2);
    // The spend is recorded like any indexing.
    expect(usage.length).toBe(2);
    expect(usage.every((e) => e.costMicros > 0 && e.messages === 0)).toBe(true);

    const rebuilt = await tenant.documents.get(hours.id);
    expect(rebuilt?.ingestVersion).toBe(INGEST_VERSION);
    expect(rebuilt?.indexedHash).toBe(rebuilt?.contentHash);
    const chunks = await tenant.documents.listChunks(hours.id);
    // Re-chunked with the minimum size: the short list joined its neighbour.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("## Elsewhere\n\n- Menu - Bookings - Contact");
    // The old vectors are gone; only the new chunks' remain.
    const vectorIds = new Set(retriever.all().map((v) => v.chunkId));
    expect(vectorIds.has("chk_old_1")).toBe(false);
    expect(vectorIds.has("chk_old_2")).toBe(false);
    expect(vectorIds.has(chunks[0]?.id as string)).toBe(true);

    // Nothing is left to rebuild, and asking again queues nothing.
    expect(await reindexStatus(tenant, site.assistantId)).toEqual({ outdated: 0 });
    const third = deps();
    expect(await reindexAssistant(third, site.assistantId)).toEqual({ queued: 0, remaining: 0 });
    expect(third.queue.messages).toEqual([]);
  });

  it("gives a written answer a vector for its question alone", async () => {
    await seedOldContent();
    await runConsumer((await queued()).messages, consumerDeps());
    const entry = (await tenant.documents.listBySource(site.entrySourceId))[0];
    const chunks = await tenant.documents.listChunks(entry?.id as string);
    expect(chunks.map((c) => c.text)).toEqual(["No, never.", "No, never."]);
    expect(chunks.every((c) => retriever.all().some((v) => v.chunkId === c.id))).toBe(true);
  });

  it("queues nothing when the limits seam refuses", async () => {
    await seedOldContent();
    const refused = deps(true);
    await expect(reindexAssistant(refused, site.assistantId)).rejects.toBeInstanceOf(
      ReindexRefused,
    );
    expect(refused.queue.messages).toEqual([]);
    expect(await reindexStatus(tenant, site.assistantId)).toEqual({ outdated: 2 });
  });

  it("rebuilds an outdated document when the same text is pushed again", async () => {
    await seedOldContent();
    const queue = capturingQueue();
    const counts = await pushDocuments(
      { tenant, docs: env.DOCS, queue },
      { orgId: TEST_ORG_ID, assistantId: site.assistantId },
      {
        sourceId: site.sitemapSourceId,
        documents: [
          {
            externalId: "hours",
            url: "https://docs.example.com/hours",
            title: "Hours",
            markdown: OLD_PAGE,
          },
        ],
      },
    );
    // Unchanged text, but queued once to be rebuilt.
    expect(counts).toMatchObject({ written: 0, unchanged: 1 });
    expect(queue.messages).toHaveLength(1);
  });

  async function queued() {
    const q = deps();
    await reindexAssistant(q, site.assistantId);
    return q.queue;
  }
});
