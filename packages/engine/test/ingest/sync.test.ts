import { createExecutionContext, createScheduledController, env } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { extractSitemapEntries } from "../../src/admin/sitemap.js";
import { createApp } from "../../src/app.js";
import { forScheduledSync } from "../../src/db/tenant.js";
import type { IngestQueueMessage } from "../../src/ingest/documents.js";
import {
  processSyncPage,
  runDueSyncs,
  runSyncPageBatch,
  SYNC_INTERVAL_MS,
  SYNC_LEASE_MS,
  type SyncPageMessage,
  type SyncSchedulerDeps,
  startSourceSync,
} from "../../src/ingest/sync.js";
import type {
  Limits,
  PageFetcher,
  PageFetchResult,
  PageValidators,
} from "../../src/seams/types.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

const ORG = TEST_ORG_ID;
const OTHER_ORG = "org_ssssssssssssssssssss";
const SITEMAP = "https://docs.example.com/sitemap.xml";
const page = (path: string) => `https://docs.example.com/${path}`;

interface Site {
  /** Sitemap entries: path → lastmod (null for none). */
  sitemap: Record<string, string | null>;
  /** Page bodies by path; `etag` is derived from the body. */
  pages: Record<string, string>;
  sitemapStatus?: number;
}

function sitemapXml(entries: Record<string, string | null>): string {
  const urls = Object.entries(entries)
    .map(
      ([path, lastmod]) =>
        `<url><loc>${page(path)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`,
    )
    .join("");
  return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

function harness(site: Site) {
  const sitemapFetches: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sitemapFetches.push(url);
    if (site.sitemapStatus !== undefined && site.sitemapStatus !== 200) {
      return new Response("nope", { status: site.sitemapStatus });
    }
    return new Response(sitemapXml(site.sitemap), {
      headers: { "content-type": "application/xml" },
    });
  };

  const pageFetches: Array<{ url: string; validators: PageValidators | undefined }> = [];
  const pages: PageFetcher = {
    async fetchPage(url, validators): Promise<PageFetchResult> {
      pageFetches.push({ url, validators });
      const path = new URL(url).pathname.slice(1);
      const body = site.pages[path];
      if (body === undefined) throw new Error("unreachable");
      const etag = `"${body.length}-${body.charCodeAt(body.length - 1)}"`;
      const fields = { finalUrl: url, etag, lastModified: null };
      if (validators?.etag === etag) {
        return {
          ...fields,
          status: 304,
          kind: "not_modified",
          notModified: true,
          title: null,
          markdown: null,
        };
      }
      return {
        ...fields,
        status: 200,
        kind: "page",
        notModified: false,
        title: path,
        markdown: body,
      };
    },
  };

  const pageMessages: SyncPageMessage[] = [];
  const ingestMessages: IngestQueueMessage[] = [];
  const queue = {
    async send(message: IngestQueueMessage) {
      ingestMessages.push(message);
    },
    async sendBatch(messages: Array<{ body: SyncPageMessage }>) {
      for (const m of messages) pageMessages.push(m.body);
    },
  };
  const retriever = memoryRetriever();
  let limits: Limits = {
    async check() {
      return { ok: true };
    },
  };
  let now = Date.now();

  const deps = (): SyncSchedulerDeps => ({
    db: env.DB,
    docs: env.DOCS,
    queue,
    retriever,
    limits,
    resolveOrg: async (orgId) => orgId,
    fetchImpl,
    now: () => now,
  });

  /** Delivers every queued page message, as the consumer would. */
  async function drain(orgId = ORG) {
    const tenant = forScheduledSync(env.DB, orgId);
    while (pageMessages.length > 0) {
      const batch = pageMessages.splice(0, 4).map((body) => fakeMessage(body));
      await runSyncPageBatch(batch, {
        tenant,
        orgId,
        docs: env.DOCS,
        queue,
        pages,
        now: () => now,
      });
    }
  }

  return {
    site,
    deps,
    drain,
    queue,
    pages,
    pageMessages,
    ingestMessages,
    pageFetches,
    sitemapFetches,
    setLimits(next: Limits) {
      limits = next;
    },
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

function fakeMessage(body: unknown, attempts = 1) {
  const message = {
    id: newId("msg"),
    timestamp: new Date(),
    body,
    attempts,
    acked: false,
    retried: false,
    ack() {
      message.acked = true;
    },
    retry() {
      message.retried = true;
    },
  };
  return message as typeof message & Message<unknown>;
}

async function seedAssistant(orgId = ORG): Promise<string> {
  const id = newId("ast");
  await env.DB.prepare(
    `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at)
     VALUES (?1, ?2, 'Docs', ?3, '[]', ?4)`,
  )
    .bind(id, orgId, `pk_${newId("ast").slice(4)}`, Date.now())
    .run();
  return id;
}

async function seedSource(
  assistantId: string,
  settings: Record<string, unknown> = { url: SITEMAP, sync: "daily" },
  orgId = ORG,
): Promise<string> {
  const source = await forScheduledSync(env.DB, orgId).sources.create({
    id: newId("src"),
    assistantId,
    kind: "sitemap",
    label: "Docs",
    settings,
    createdAt: Date.now(),
  });
  return source.id;
}

const state = (sourceId: string, orgId = ORG) => forScheduledSync(env.DB, orgId).sync.get(sourceId);
const docUrls = async (sourceId: string, orgId = ORG) =>
  (await forScheduledSync(env.DB, orgId).documents.listBySource(sourceId)).map((d) => d.url).sort();

/**
 * One full run: start, then deliver every page message. The chunk-and-embed
 * consumer is not run here, so its result is written directly afterwards:
 * every document's content counts as indexed, as it would be in production.
 */
async function syncOnce(h: ReturnType<typeof harness>, sourceId: string) {
  const started = await startSourceSync(h.deps(), ORG, sourceId);
  await h.drain();
  await env.DB.prepare("UPDATE documents SET indexed_hash = content_hash WHERE source_id = ?1")
    .bind(sourceId)
    .run();
  return started;
}

describe("scheduled sitemap sync", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM source_sync_pages"),
      env.DB.prepare("DELETE FROM source_syncs"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, 'Other')").bind(OTHER_ORG),
    ]);
  });

  it("adds every page on the first run and records the counts", async () => {
    const h = harness({
      sitemap: { a: null, b: "2026-11-01" },
      pages: { a: "Page A.", b: "Page B." },
    });
    const sourceId = await seedSource(await seedAssistant());

    const started = await syncOnce(h, sourceId);
    expect(started).toMatchObject({ status: "queued", queued: 2 });
    expect(await docUrls(sourceId)).toEqual([page("a"), page("b")]);
    expect(h.ingestMessages).toHaveLength(2);
    const after = await state(sourceId);
    expect(after).toMatchObject({
      outcome: "succeeded",
      error: null,
      counts: { added: 2, updated: 0, unchanged: 0, removed: 0, failed: 0, deferred: 0 },
    });
    expect(after?.finishedAt).not.toBeNull();
  });

  it("skips unchanged pages: by sitemap lastmod without fetching, then by a 304, then by content hash", async () => {
    const h = harness({
      sitemap: { dated: "2026-11-01", etagged: null, rehashed: null },
      pages: { dated: "Dated.", etagged: "Etagged.", rehashed: "Rehashed." },
    });
    const sourceId = await seedSource(await seedAssistant());
    await syncOnce(h, sourceId);
    h.ingestMessages.length = 0;
    h.pageFetches.length = 0;

    // The page's server forgets its validators: a full fetch, same content.
    const tenant = forScheduledSync(env.DB, ORG);
    const rehashed = (await tenant.documents.listForSync(sourceId)).find(
      (d) => d.url === page("rehashed"),
    );
    await env.DB.prepare("UPDATE documents SET etag = NULL WHERE org_id = ?1 AND id = ?2")
      .bind(ORG, rehashed?.id)
      .run();

    h.advance(SYNC_INTERVAL_MS.daily);
    await syncOnce(h, sourceId);

    // `dated` was never fetched; `etagged` was asked with its stored ETag.
    expect(h.pageFetches.map((f) => f.url).sort()).toEqual([page("etagged"), page("rehashed")]);
    expect(h.pageFetches.find((f) => f.url === page("etagged"))?.validators?.etag).toBeTruthy();
    // Nothing is re-embedded.
    expect(h.ingestMessages).toEqual([]);
    expect((await state(sourceId))?.counts).toMatchObject({
      added: 0,
      updated: 0,
      unchanged: 3,
      failed: 0,
    });
  });

  it("updates a changed page and re-queues it for indexing", async () => {
    const h = harness({ sitemap: { a: "2026-11-01" }, pages: { a: "Old text." } });
    const sourceId = await seedSource(await seedAssistant());
    await syncOnce(h, sourceId);
    h.ingestMessages.length = 0;

    h.site.sitemap.a = "2026-11-10";
    h.site.pages.a = "New text!";
    h.advance(SYNC_INTERVAL_MS.daily);
    await syncOnce(h, sourceId);

    expect((await state(sourceId))?.counts).toMatchObject({ updated: 1, unchanged: 0 });
    expect(h.ingestMessages).toHaveLength(1);
    const [doc] = await forScheduledSync(env.DB, ORG).documents.listBySource(sourceId);
    const body = await env.DOCS.get(doc?.bodyKey ?? "");
    expect(await body?.text()).toBe("New text!");
  });

  it("removes documents that left the sitemap, from this source only", async () => {
    const h = harness({
      sitemap: { a: null, b: null, c: null },
      pages: { a: "A.", b: "B.", c: "C." },
    });
    const assistantId = await seedAssistant();
    const sourceId = await seedSource(assistantId);
    await syncOnce(h, sourceId);

    // Another sitemap source of the same assistant lists `c` too.
    const otherSource = await seedSource(assistantId, { url: SITEMAP });
    await syncOnce(h, otherSource);
    expect(await docUrls(otherSource)).toContain(page("c"));

    delete h.site.sitemap.c;
    h.advance(SYNC_INTERVAL_MS.daily);
    await syncOnce(h, sourceId);

    expect(await docUrls(sourceId)).toEqual([page("a"), page("b")]);
    expect(await docUrls(otherSource)).toEqual([page("a"), page("b"), page("c")]);
    expect((await state(sourceId))?.counts.removed).toBe(1);
  });

  describe("the wipe guard", () => {
    async function seeded(site: Site, settings?: Record<string, unknown>) {
      const h = harness(site);
      const sourceId = await seedSource(
        await seedAssistant(),
        settings ?? { url: SITEMAP, sync: "daily" },
      );
      await syncOnce(h, sourceId);
      h.advance(SYNC_INTERVAL_MS.daily);
      h.pageFetches.length = 0;
      return { h, sourceId };
    }
    const fourPages = (): Site => ({
      sitemap: { a: null, b: null, c: null, d: null },
      pages: { a: "A.", b: "B.", c: "C.", d: "D." },
    });

    it("removes nothing when the sitemap fails to load", async () => {
      const { h, sourceId } = await seeded(fourPages());
      h.site.sitemapStatus = 500;
      await syncOnce(h, sourceId);
      expect(await docUrls(sourceId)).toHaveLength(4);
      expect(await state(sourceId)).toMatchObject({
        outcome: "failed",
        error: "sitemap_unavailable",
      });
      expect(h.pageFetches).toEqual([]);
    });

    it("removes nothing when the sitemap lists no page", async () => {
      const { h, sourceId } = await seeded(fourPages());
      h.site.sitemap = {};
      await syncOnce(h, sourceId);
      expect(await docUrls(sourceId)).toHaveLength(4);
      expect(await state(sourceId)).toMatchObject({ outcome: "failed", error: "sitemap_empty" });
    });

    it("removes nothing when more than half the documents would go, and allows exactly half", async () => {
      const { h, sourceId } = await seeded(fourPages());
      h.site.sitemap = { a: null };
      await syncOnce(h, sourceId);
      expect(await docUrls(sourceId)).toHaveLength(4);
      expect(await state(sourceId)).toMatchObject({
        outcome: "failed",
        error: "too_many_removals",
        counts: { removed: 0, added: 0 },
      });
      expect(h.pageFetches).toEqual([]);

      h.site.sitemap = { a: null, b: null };
      h.advance(SYNC_INTERVAL_MS.daily);
      await syncOnce(h, sourceId);
      expect(await docUrls(sourceId)).toEqual([page("a"), page("b")]);
      expect(await state(sourceId)).toMatchObject({ outcome: "succeeded", counts: { removed: 2 } });
    });

    it("uses the source's own maxRemovePercent", async () => {
      const { h, sourceId } = await seeded(fourPages(), {
        url: SITEMAP,
        sync: "daily",
        maxRemovePercent: 20,
      });
      h.site.sitemap = { a: null, b: null, c: null };
      await syncOnce(h, sourceId);
      expect(await docUrls(sourceId)).toHaveLength(4);
      expect(await state(sourceId)).toMatchObject({ error: "too_many_removals" });
    });
  });

  it("caps pages per run and documents per source, deferring the rest", async () => {
    const h = harness({
      sitemap: { a: null, b: null, c: null, d: null, e: null },
      pages: { a: "A.", b: "B.", c: "C.", d: "D.", e: "E." },
    });
    const sourceId = await seedSource(await seedAssistant());

    const run = (caps: SyncSchedulerDeps["caps"]) =>
      startSourceSync({ ...h.deps(), caps }, ORG, sourceId).then(() => h.drain());

    await run({ maxPages: 2 });
    expect(await docUrls(sourceId)).toEqual([page("a"), page("b")]);
    expect((await state(sourceId))?.counts).toMatchObject({ added: 2, deferred: 3 });

    h.advance(SYNC_INTERVAL_MS.daily);
    await run({ maxDocuments: 3 });
    expect(await docUrls(sourceId)).toHaveLength(3);
    expect((await state(sourceId))?.counts).toMatchObject({ added: 1, deferred: 2 });
  });

  it("lets the Limits seam lower the caps but not raise them", async () => {
    const h = harness({
      sitemap: { a: null, b: null, c: null },
      pages: { a: "A", b: "B", c: "C" },
    });
    const sourceId = await seedSource(await seedAssistant());
    h.setLimits({
      async check() {
        return { ok: true };
      },
      async checkSync() {
        return { ok: true, maxPages: 1, maxDocuments: 1_000_000 };
      },
    });
    await startSourceSync({ ...h.deps(), caps: { maxDocuments: 2 } }, ORG, sourceId);
    await h.drain();
    expect((await state(sourceId))?.counts).toMatchObject({ added: 1, deferred: 2 });
  });

  it("refuses a run the Limits seam refuses, without fetching anything", async () => {
    const h = harness({ sitemap: { a: null }, pages: { a: "A." } });
    const assistantId = await seedAssistant();
    const sourceId = await seedSource(assistantId);
    const asked: unknown[] = [];
    h.setLimits({
      async check() {
        return { ok: true };
      },
      async checkSync(orgId, askedAssistant, request) {
        asked.push({ orgId, askedAssistant, request });
        return { ok: false, reason: "suspended" };
      },
    });

    await runDueSyncs(h.deps());
    await h.drain();
    expect(asked).toEqual([{ orgId: ORG, askedAssistant: assistantId, request: { sourceId } }]);
    expect(h.sitemapFetches).toEqual([]);
    expect(await docUrls(sourceId)).toEqual([]);
    expect(await state(sourceId)).toMatchObject({ outcome: "failed", error: "limit_refused" });
  });

  it("never syncs an org the auth seam refuses", async () => {
    const h = harness({ sitemap: { a: null }, pages: { a: "A." } });
    const sourceId = await seedSource(await seedAssistant(OTHER_ORG), undefined, OTHER_ORG);
    const result = await runDueSyncs({
      ...h.deps(),
      resolveOrg: async (orgId) => (orgId === OTHER_ORG ? null : orgId),
    });
    expect(result).toEqual({ started: [], refusedOrgs: 1 });
    expect(h.sitemapFetches).toEqual([]);
    expect(await state(sourceId, OTHER_ORG)).toBeNull();
  });

  it("does not start a second run while one holds the source", async () => {
    const h = harness({ sitemap: { a: null, b: null }, pages: { a: "A.", b: "B." } });
    const sourceId = await seedSource(await seedAssistant());

    const [first, second] = await Promise.all([
      startSourceSync(h.deps(), ORG, sourceId),
      startSourceSync(h.deps(), ORG, sourceId),
    ]);
    expect([first.status, second.status].sort()).toEqual(["busy", "queued"]);
    // A cron firing again before the pages are handled starts nothing.
    expect(await runDueSyncs(h.deps())).toEqual({ started: [], refusedOrgs: 0 });
    expect(await startSourceSync(h.deps(), ORG, sourceId)).toEqual({ status: "busy" });
    expect(h.pageMessages).toHaveLength(2);
    await h.drain();
    expect(await docUrls(sourceId)).toHaveLength(2);

    // Finished: the next run may start once it is due.
    h.advance(SYNC_INTERVAL_MS.daily);
    expect(await startSourceSync(h.deps(), ORG, sourceId)).toMatchObject({ status: "queued" });
  });

  it("reports a run whose lease ran out as interrupted and ignores its late messages", async () => {
    const h = harness({ sitemap: { a: null }, pages: { a: "A." } });
    const sourceId = await seedSource(await seedAssistant());
    await startSourceSync(h.deps(), ORG, sourceId);
    h.advance(SYNC_LEASE_MS + 1);
    expect(await state(sourceId, ORG)).toBeTruthy();
    expect(await forScheduledSync(env.DB, ORG).sync.get(sourceId, h.now)).toMatchObject({
      outcome: "failed",
      error: "interrupted",
    });
    await h.drain();
    expect(h.pageFetches).toEqual([]);
    expect(await docUrls(sourceId)).toEqual([]);
  });

  it("counts a retried page message once and writes no duplicate document", async () => {
    const h = harness({ sitemap: { a: null, b: null }, pages: { a: "A.", b: "B." } });
    const sourceId = await seedSource(await seedAssistant());
    await startSourceSync(h.deps(), ORG, sourceId);
    const [first] = h.pageMessages;
    if (!first) throw new Error("no page message");
    const deps = {
      tenant: forScheduledSync(env.DB, ORG),
      orgId: ORG,
      docs: env.DOCS,
      queue: h.queue,
      pages: h.pages,
      now: () => h.now,
    };
    expect(await processSyncPage(first, deps)).toBe("added");
    expect(await processSyncPage(first, deps)).toBeNull();
    await h.drain();
    expect(await docUrls(sourceId)).toEqual([page("a"), page("b")]);
    expect((await state(sourceId))?.counts).toMatchObject({ added: 2, unchanged: 0 });
  });

  it("records an unreachable page as failed and finishes the run as partial", async () => {
    const h = harness({ sitemap: { a: null, gone: null }, pages: { a: "A." } });
    const sourceId = await seedSource(await seedAssistant());
    await syncOnce(h, sourceId);
    expect(await state(sourceId)).toMatchObject({
      outcome: "partial",
      error: "pages_failed",
      counts: { added: 1, failed: 1 },
    });
  });

  it("picks only sources that are due: never off, and not again until the interval has passed", async () => {
    const h = harness({ sitemap: { a: null }, pages: { a: "A." } });
    const assistantId = await seedAssistant();
    const daily = await seedSource(assistantId, { url: SITEMAP, sync: "daily" });
    const weekly = await seedSource(assistantId, { url: SITEMAP, sync: "weekly" });
    await seedSource(assistantId, { url: SITEMAP, sync: "off" });
    await seedSource(assistantId, { url: SITEMAP });

    expect((await runDueSyncs(h.deps())).started.sort()).toEqual([daily, weekly].sort());
    await h.drain();
    expect((await runDueSyncs(h.deps())).started).toEqual([]);

    h.advance(SYNC_INTERVAL_MS.daily - 60_000);
    expect((await runDueSyncs(h.deps())).started).toEqual([daily]);
    await h.drain();
    h.advance(SYNC_INTERVAL_MS.weekly);
    expect((await runDueSyncs(h.deps())).started.sort()).toEqual([daily, weekly].sort());
  });

  it("runs from the Workers scheduled handler and from runDueSyncs on createApp", async () => {
    const assistantId = await seedAssistant();
    const sourceId = await seedSource(assistantId);
    const sent: unknown[] = [];
    const queue = {
      async send(body: unknown) {
        sent.push(body);
      },
      async sendBatch(messages: Array<{ body: unknown }>) {
        for (const m of messages) sent.push(m.body);
      },
    };
    const app = createApp(fakeSeams(), {
      fetch: async () =>
        new Response(sitemapXml({ a: null }), { headers: { "content-type": "application/xml" } }),
    });
    const testEnv = { ...env, INGEST_QUEUE: queue as unknown as Queue };
    await app.scheduled(createScheduledController(), testEnv, createExecutionContext());
    expect(sent).toEqual([
      expect.objectContaining({ kind: "sync_page", orgId: ORG, sourceId, url: page("a") }),
    ]);
    // Held by the run just started: a host's own cron finds nothing due.
    expect(await app.runDueSyncs(testEnv)).toEqual({ started: [], refusedOrgs: 0 });
  });

  it("routes sync page messages through the app's queue handler without an embedding key", async () => {
    const assistantId = await seedAssistant();
    const sourceId = await seedSource(assistantId);
    const sent: unknown[] = [];
    const queue = {
      async send(body: unknown) {
        sent.push(body);
      },
      async sendBatch(messages: Array<{ body: unknown }>) {
        for (const m of messages) sent.push(m.body);
      },
    };
    const pages: PageFetcher = {
      async fetchPage(url) {
        return {
          kind: "page",
          finalUrl: url,
          status: 200,
          title: "A",
          markdown: "Body.",
          etag: null,
          lastModified: null,
          notModified: false,
        };
      },
    };
    const app = createApp(
      fakeSeams({
        pages,
        keys: {
          async modelKey() {
            throw new Error("no key");
          },
          async embeddingKey() {
            throw new Error("no embedding key needed for a sync page");
          },
        },
      }),
      {
        fetch: async () =>
          new Response(sitemapXml({ a: null }), { headers: { "content-type": "application/xml" } }),
      },
    );
    const testEnv = { ...env, INGEST_QUEUE: queue as unknown as Queue };
    await app.runDueSyncs(testEnv);
    const message = fakeMessage(sent.shift());
    await app.queue(
      { messages: [message], queue: "q", retryAll() {}, ackAll() {} } as unknown as MessageBatch,
      testEnv,
      createExecutionContext(),
    );
    expect(message.acked).toBe(true);
    expect(await docUrls(sourceId)).toEqual([page("a")]);
    expect(sent).toEqual([
      expect.objectContaining({ orgId: ORG, contentHash: expect.any(String) }),
    ]);
    expect(await state(sourceId)).toMatchObject({ outcome: "succeeded", counts: { added: 1 } });
  });
});

describe("extractSitemapEntries", () => {
  it("reads lastmod per url, drops unsafe and duplicate URLs, and flags truncation and indexes", () => {
    const xml = `<urlset>
      <url><loc>https://a.example.com/x</loc><lastmod>2026-11-01</lastmod></url>
      <url><loc>https://a.example.com/x</loc></url>
      <url><loc>http://a.example.com/insecure</loc></url>
      <url><loc>https://10.0.0.1/private</loc></url>
      <url><loc><![CDATA[https://a.example.com/y?a=1&b=2]]></loc></url>
      <url><loc>https://a.example.com/z</loc></url>
    </urlset>`;
    expect(extractSitemapEntries(xml, 10)).toEqual({
      entries: [
        { url: "https://a.example.com/x", lastmod: "2026-11-01" },
        { url: "https://a.example.com/y?a=1&b=2", lastmod: null },
        { url: "https://a.example.com/z", lastmod: null },
      ],
      truncated: false,
      isIndex: false,
    });
    expect(extractSitemapEntries(xml, 2)).toMatchObject({ truncated: true });
    expect(
      extractSitemapEntries(
        "<sitemapindex><sitemap><loc>https://a.example.com/s.xml</loc></sitemap></sitemapindex>",
        10,
      ),
    ).toMatchObject({ isIndex: true });
  });
});
