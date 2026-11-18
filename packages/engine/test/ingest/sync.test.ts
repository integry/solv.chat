import { createExecutionContext, createScheduledController, env } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { extractSitemapEntries, isWellFormedUrlset } from "../../src/admin/sitemap.js";
import { createApp } from "../../src/app.js";
import { forScheduledSync } from "../../src/db/tenant.js";
import {
  type IngestQueueMessage,
  pushDocuments,
  SyncRunEnded,
} from "../../src/ingest/documents.js";
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
  /** Served as the sitemap instead of one built from `sitemap`. */
  sitemapBody?: string;
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
    return new Response(site.sitemapBody ?? sitemapXml(site.sitemap), {
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
  async function drain(orgId = ORG, fetcher: PageFetcher = pages) {
    const tenant = forScheduledSync(env.DB, orgId);
    while (pageMessages.length > 0) {
      const batch = pageMessages.splice(0, 4).map((body) => fakeMessage(body));
      await runSyncPageBatch(batch, {
        tenant,
        orgId,
        docs: env.DOCS,
        queue,
        pages: fetcher,
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
      env.DB.prepare("DELETE FROM source_sync_attempts"),
      env.DB.prepare("DELETE FROM sync_org_refusals"),
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

  it("queues indexing again for an unchanged page whose indexing failed, by lastmod and by a 304", async () => {
    const h = harness({
      sitemap: { dated: "2026-11-01", etagged: null },
      pages: { dated: "Dated.", etagged: "Etagged." },
    });
    const sourceId = await seedSource(await seedAssistant());
    // First run: both pages written and queued for indexing, which then
    // fails for good (retries exhausted), so neither is indexed.
    await startSourceSync(h.deps(), ORG, sourceId);
    await h.drain();
    const tenant = forScheduledSync(env.DB, ORG);
    const docs = await tenant.documents.listForSync(sourceId);
    for (const doc of docs) {
      await tenant.documents.markIndexError(doc.id, doc.contentHash, "embedding_failed");
    }
    h.ingestMessages.length = 0;
    h.pageFetches.length = 0;

    // The owner fixes the embedding service; the pages have not changed.
    h.advance(SYNC_INTERVAL_MS.daily);
    await startSourceSync(h.deps(), ORG, sourceId);
    await h.drain();

    // `dated` is no longer skipped by its lastmod: both are asked with their
    // ETag, both answer 304, and both are queued for indexing again.
    expect(h.pageFetches.map((f) => f.url).sort()).toEqual([page("dated"), page("etagged")]);
    expect(h.pageFetches.every((f) => f.validators?.etag)).toBe(true);
    expect(
      h.ingestMessages.map((m) => ({ documentId: m.documentId, contentHash: m.contentHash })),
    ).toEqual(
      expect.arrayContaining(
        docs.map((doc) => ({ documentId: doc.id, contentHash: doc.contentHash })),
      ),
    );
    expect(h.ingestMessages).toHaveLength(2);
    expect((await state(sourceId))?.counts).toMatchObject({ unchanged: 2, failed: 0 });

    // Once indexed, unchanged pages are skipped again and nothing is queued.
    await env.DB.prepare("UPDATE documents SET indexed_hash = content_hash WHERE source_id = ?1")
      .bind(sourceId)
      .run();
    h.ingestMessages.length = 0;
    h.pageFetches.length = 0;
    h.advance(SYNC_INTERVAL_MS.daily);
    await syncOnce(h, sourceId);
    expect(h.pageFetches.map((f) => f.url)).toEqual([page("etagged")]);
    expect(h.ingestMessages).toEqual([]);
  });

  it("keeps a listed page whose entry holds a commented-out location, and never reads the comment", async () => {
    const h = harness({ sitemap: { a: null, b: null }, pages: { a: "A.", b: "B.", old: "Old." } });
    const sourceId = await seedSource(await seedAssistant());
    await syncOnce(h, sourceId);
    expect(await docUrls(sourceId)).toEqual([page("a"), page("b")]);
    h.pageFetches.length = 0;

    h.site.sitemapBody = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><!-- previous: <loc>${page("old")}</loc> --><loc>${page("a")}</loc></url>
      <url><loc>${page("b")}</loc></url>
      <!-- <url><loc>${page("gone")}</loc></url> -->
    </urlset>`;
    h.advance(SYNC_INTERVAL_MS.daily);
    await syncOnce(h, sourceId);

    expect(await docUrls(sourceId)).toEqual([page("a"), page("b")]);
    expect(h.pageFetches.map((f) => f.url).sort()).toEqual([page("a"), page("b")]);
    expect((await state(sourceId))?.counts).toMatchObject({ removed: 0, added: 0, failed: 0 });
  });

  it("heals a bad page served with a 200 once its lastmod is older than the recheck age", async () => {
    const h = harness({
      sitemap: { a: "2026-11-01", b: "2026-11-01" },
      pages: { a: "A.", b: "B." },
    });
    const sourceId = await seedSource(await seedAssistant());
    await syncOnce(h, sourceId);

    // The site is down for maintenance, answering 200, while the sitemap's
    // lastmod moved: the documents are overwritten with the maintenance page.
    h.site.sitemap = { a: "2026-11-10", b: "2026-11-10" };
    h.site.pages = { a: "Down for maintenance", b: "Down for maintenance" };
    h.advance(SYNC_INTERVAL_MS.daily);
    await syncOnce(h, sourceId);
    expect((await state(sourceId))?.counts).toMatchObject({ updated: 2 });

    // The site recovers, the sitemap keeps the same lastmod: trusted for now.
    h.site.pages = { a: "A, back.", b: "B, back." };
    h.pageFetches.length = 0;
    h.advance(6 * SYNC_INTERVAL_MS.daily);
    await syncOnce(h, sourceId);
    expect(h.pageFetches).toEqual([]);
    expect((await state(sourceId))?.counts).toMatchObject({ unchanged: 2, updated: 0 });

    // Seven days after the last check, each page is fetched again with its
    // validators and the real content comes back.
    h.advance(SYNC_INTERVAL_MS.daily);
    await syncOnce(h, sourceId);
    expect(h.pageFetches.map((f) => f.url).sort()).toEqual([page("a"), page("b")]);
    expect(h.pageFetches.every((f) => f.validators?.etag)).toBe(true);
    expect((await state(sourceId))?.counts).toMatchObject({ updated: 2 });
    const docs = await forScheduledSync(env.DB, ORG).documents.listBySource(sourceId);
    const bodies = await Promise.all(
      docs.map(async (d) => (await env.DOCS.get(d.bodyKey ?? ""))?.text()),
    );
    expect(bodies.sort()).toEqual(["A, back.", "B, back."]);

    // Checked again, the lastmod is trusted again; an unchanged page past
    // the age costs only a 304.
    h.pageFetches.length = 0;
    h.advance(SYNC_INTERVAL_MS.daily);
    await syncOnce(h, sourceId);
    expect(h.pageFetches).toEqual([]);
    h.advance(SYNC_INTERVAL_MS.weekly);
    h.ingestMessages.length = 0;
    await syncOnce(h, sourceId);
    expect(h.pageFetches).toHaveLength(2);
    expect(h.ingestMessages).toEqual([]);
    expect((await state(sourceId))?.counts).toMatchObject({ unchanged: 2, updated: 0 });
  });

  it("uses the source's own recheckDays", async () => {
    const h = harness({ sitemap: { a: "2026-11-01" }, pages: { a: "A." } });
    const sourceId = await seedSource(await seedAssistant(), {
      url: SITEMAP,
      sync: "daily",
      recheckDays: 2,
    });
    await syncOnce(h, sourceId);
    h.pageFetches.length = 0;
    h.advance(SYNC_INTERVAL_MS.daily);
    await syncOnce(h, sourceId);
    expect(h.pageFetches).toEqual([]);
    h.advance(SYNC_INTERVAL_MS.daily);
    await syncOnce(h, sourceId);
    expect(h.pageFetches.map((f) => f.url)).toEqual([page("a")]);
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
        counts: { removed: 0, added: 0, updated: 0, unchanged: 0, withheld: 3 },
      });
      // A refused run fetches nothing, not even the page still listed.
      expect(h.pageFetches).toEqual([]);

      h.site.sitemap = { a: null, b: null };
      h.advance(SYNC_INTERVAL_MS.daily);
      await syncOnce(h, sourceId);
      expect(await docUrls(sourceId)).toEqual([page("a"), page("b")]);
      expect(await state(sourceId)).toMatchObject({ outcome: "succeeded", counts: { removed: 2 } });
    });

    it("removes nothing when the sitemap is cut short, broken XML, or not a urlset", async () => {
      const { h, sourceId } = await seeded(fourPages());
      const two = `<url><loc>${page("a")}</loc></url><url><loc>${page("b")}</loc></url>`;
      const ns = `xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"`;
      const broken = [
        // Ends inside a third entry, with no closing </urlset>.
        `<?xml version="1.0"?><urlset ${ns}>${two}<url><loc>${page("c")}`,
        `<urlset ${ns}>${two}`,
        `<urlset ${ns}>${two}<url><loc>${page("c")}</url></loc></urlset>`,
        `<urlset ${ns}>${two}</urlset><url><loc>${page("c")}</loc></url>`,
        `<urlset ${ns}>${two}<url><loc>${page("c")}?a=1&b</loc></url></urlset>`,
        `<pages>${two}</pages>`,
        two,
      ];
      for (const body of broken) {
        h.site.sitemapBody = body;
        await syncOnce(h, sourceId);
        expect(await docUrls(sourceId), body).toHaveLength(4);
        expect(await state(sourceId), body).toMatchObject({
          outcome: "failed",
          error: "sitemap_invalid",
          counts: { removed: 0 },
        });
      }
      expect(h.pageFetches).toEqual([]);

      // The same two entries in a complete document remove the other two.
      h.site.sitemapBody = `<?xml version="1.0"?><urlset ${ns}>${two}</urlset>`;
      await syncOnce(h, sourceId);
      expect(await docUrls(sourceId)).toEqual([page("a"), page("b")]);
      expect(await state(sourceId)).toMatchObject({ outcome: "succeeded", counts: { removed: 2 } });
    });

    it.each([3, 10])(
      "a wrong sitemap of the same size (%i pages) adds nothing and removes nothing, run after run",
      async (size) => {
        // A sitemap swapped for one of another host or section: every real
        // document is "not listed", and as many unrelated pages are listed.
        const real = Array.from({ length: size }, (_, i) => `real-${i}`);
        const wrong = Array.from({ length: size }, (_, i) => `staging-${i}`);
        const { h, sourceId } = await seeded({
          sitemap: Object.fromEntries(real.map((p) => [p, null])),
          pages: Object.fromEntries(
            [...real, ...wrong].map((p) => [p, `Text of ${p}.`] as [string, string]),
          ),
        });
        h.ingestMessages.length = 0;
        h.site.sitemap = Object.fromEntries(wrong.map((p) => [p, null]));

        for (let run = 1; run <= 3; run++) {
          await syncOnce(h, sourceId);
          expect(await docUrls(sourceId), `run ${run}`).toEqual(real.map(page).sort());
          expect(await state(sourceId), `run ${run}`).toMatchObject({
            outcome: "failed",
            error: "too_many_removals",
            counts: { added: 0, updated: 0, removed: 0, withheld: size },
          });
          h.advance(SYNC_INTERVAL_MS.daily);
        }
        expect(h.pageFetches).toEqual([]);
        expect(h.ingestMessages).toEqual([]);
      },
    );

    it("leaves document count, chunks and validators unchanged on a refused run", async () => {
      const { h, sourceId } = await seeded(fourPages());
      // Give each document chunks and a vector, as the indexing consumer would.
      const docs = await forScheduledSync(env.DB, ORG).documents.listBySource(sourceId);
      for (const doc of docs) {
        await env.DB.prepare(
          "INSERT INTO chunks (id, org_id, document_id, ordinal, text) VALUES (?1, ?2, ?3, 0, ?4)",
        )
          .bind(`chk_${doc.id}`, ORG, doc.id, `Chunk of ${doc.url}.`)
          .run();
      }
      const retriever = h.deps().retriever as ReturnType<typeof memoryRetriever>;
      await retriever.upsert(
        docs.map((doc) => ({
          chunkId: `chk_${doc.id}`,
          vector: [1, 0],
          orgId: ORG,
          assistantId: "ast_fixture",
        })),
      );
      const snapshot = async () => ({
        documents: (
          await env.DB.prepare("SELECT * FROM documents WHERE source_id = ?1 ORDER BY url")
            .bind(sourceId)
            .all()
        ).results,
        chunks: (await env.DB.prepare("SELECT * FROM chunks ORDER BY id").all()).results,
        vectors: retriever.all(),
      });
      const before = await snapshot();
      expect(before.documents).toHaveLength(4);
      expect(before.chunks).toHaveLength(4);
      expect(before.documents.every((d) => d.etag !== null && d.sync_checked_at !== null)).toBe(
        true,
      );

      // `a` changed and `e` is new, but three of four would go.
      h.site.sitemap = { a: "2026-11-12", e: null };
      h.site.pages = { ...h.site.pages, a: "A, changed.", e: "E." };
      h.ingestMessages.length = 0;
      await syncOnce(h, sourceId);

      expect(await state(sourceId)).toMatchObject({
        outcome: "failed",
        error: "too_many_removals",
        counts: { added: 0, updated: 0, unchanged: 0, removed: 0, withheld: 3 },
      });
      expect(await snapshot()).toEqual(before);
      expect(h.pageFetches).toEqual([]);
      expect(h.ingestMessages).toEqual([]);
    });

    it("Sync anyway adds, updates and removes in one run", async () => {
      const { h, sourceId } = await seeded(fourPages());
      // A whole-site change: `a` stays but changed, the rest moved.
      h.site.sitemap = { a: null, "b/": null, "c/": null, "d/": null };
      h.site.pages = { ...h.site.pages, a: "A, changed.", "b/": "B.", "c/": "C.", "d/": "D." };
      await syncOnce(h, sourceId);
      expect(await docUrls(sourceId)).toEqual([page("a"), page("b"), page("c"), page("d")]);
      expect((await state(sourceId))?.counts.withheld).toBe(3);

      h.advance(60_000);
      await startSourceSync(h.deps(), ORG, sourceId, { allowRemovals: 3 });
      await h.drain();
      expect(await docUrls(sourceId)).toEqual([page("a"), page("b/"), page("c/"), page("d/")]);
      expect(await state(sourceId)).toMatchObject({
        outcome: "succeeded",
        error: null,
        counts: { added: 3, updated: 1, removed: 3, withheld: 0 },
      });
    });

    it("refuses removing the only page of a one-page source, and adds nothing", async () => {
      const { h, sourceId } = await seeded({ sitemap: { a: null }, pages: { a: "A.", b: "B." } });
      h.site.sitemap = { b: null };
      await syncOnce(h, sourceId);
      expect(await docUrls(sourceId)).toEqual([page("a")]);
      expect(await state(sourceId)).toMatchObject({
        outcome: "failed",
        error: "too_many_removals",
        counts: { added: 0, withheld: 1 },
      });
    });

    it("lifts the guard for one run with allowRemovals, up to the number allowed", async () => {
      const { h, sourceId } = await seeded(fourPages());
      h.site.sitemap = { a: null };
      await syncOnce(h, sourceId);
      expect((await state(sourceId))?.counts.withheld).toBe(3);

      // Fewer allowed than would go: refused as before, with the new number.
      h.advance(60_000);
      await startSourceSync(h.deps(), ORG, sourceId, { allowRemovals: 2 });
      await h.drain();
      expect(await docUrls(sourceId)).toHaveLength(4);
      expect(await state(sourceId)).toMatchObject({
        error: "too_many_removals",
        counts: { withheld: 3 },
      });

      h.advance(60_000);
      await startSourceSync(h.deps(), ORG, sourceId, { allowRemovals: 3 });
      await h.drain();
      expect(await docUrls(sourceId)).toEqual([page("a")]);
      expect(await state(sourceId)).toMatchObject({
        outcome: "succeeded",
        error: null,
        counts: { removed: 3, withheld: 0 },
      });

      // The next run has the usual guard again.
      h.site.sitemap = { b: null };
      h.site.pages.b = "B.";
      h.advance(SYNC_INTERVAL_MS.daily);
      await syncOnce(h, sourceId);
      expect(await docUrls(sourceId)).toEqual([page("a")]);
      expect(await state(sourceId)).toMatchObject({
        error: "too_many_removals",
        counts: { added: 0, withheld: 1 },
      });
    });

    it("keeps the other guards when allowRemovals is given", async () => {
      const { h, sourceId } = await seeded(fourPages());
      h.site.sitemap = {};
      await startSourceSync(h.deps(), ORG, sourceId, { allowRemovals: 4 });
      expect(await docUrls(sourceId)).toHaveLength(4);
      expect(await state(sourceId)).toMatchObject({ error: "sitemap_empty" });
    });

    it("reports a sitemap index as sitemap_index and changes nothing", async () => {
      const { h, sourceId } = await seeded(fourPages());
      h.site.sitemapBody = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${page("docs-sitemap.xml")}</loc></sitemap></sitemapindex>`;
      await syncOnce(h, sourceId);
      expect(await docUrls(sourceId)).toHaveLength(4);
      expect(await state(sourceId)).toMatchObject({ outcome: "failed", error: "sitemap_index" });
      expect(h.pageFetches).toEqual([]);
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

  it("gives deferred new pages their turn when the pages before them keep failing", async () => {
    const h = harness({
      sitemap: { bad1: null, bad2: null, good: null },
      pages: { good: "Good." },
    });
    const sourceId = await seedSource(await seedAssistant());
    const run = () =>
      startSourceSync({ ...h.deps(), caps: { maxPages: 2 } }, ORG, sourceId).then(() => h.drain());

    await run();
    expect(await docUrls(sourceId)).toEqual([]);
    expect((await state(sourceId))?.counts).toMatchObject({ failed: 2, deferred: 1 });

    h.advance(SYNC_INTERVAL_MS.daily);
    h.pageFetches.length = 0;
    await run();
    expect(h.pageFetches.map((f) => f.url)).toEqual([page("good"), page("bad1")]);
    expect(await docUrls(sourceId)).toEqual([page("good")]);
    expect((await state(sourceId))?.counts).toMatchObject({ added: 1, failed: 1, deferred: 1 });

    // A page no longer listed is forgotten once the whole sitemap was read.
    delete h.site.sitemap.bad2;
    h.advance(SYNC_INTERVAL_MS.daily);
    await run();
    const attempts = await forScheduledSync(env.DB, ORG).sync.attempts(sourceId);
    expect([...attempts.keys()].sort()).toEqual([page("bad1"), page("good")]);
  });

  it("gives deferred documents their turn when the documents before them keep failing", async () => {
    const h = harness({
      sitemap: { a: null, b: null, c: null },
      pages: { a: "A.", b: "B.", c: "C." },
    });
    const sourceId = await seedSource(await seedAssistant());
    await syncOnce(h, sourceId);
    const run = () =>
      startSourceSync({ ...h.deps(), caps: { maxPages: 2 } }, ORG, sourceId).then(() => h.drain());

    delete h.site.pages.a;
    delete h.site.pages.b;
    h.site.pages.c = "C, changed.";
    h.advance(SYNC_INTERVAL_MS.daily);
    await run();
    expect((await state(sourceId))?.counts).toMatchObject({ failed: 2, updated: 0, deferred: 1 });

    h.advance(SYNC_INTERVAL_MS.daily);
    h.pageFetches.length = 0;
    await run();
    expect(h.pageFetches[0]?.url).toBe(page("c"));
    expect((await state(sourceId))?.counts).toMatchObject({ updated: 1, failed: 1, deferred: 1 });
    const docs = await forScheduledSync(env.DB, ORG).documents.listBySource(sourceId);
    const c = docs.find((d) => d.url === page("c"));
    expect(await (await env.DOCS.get(c?.bodyKey ?? ""))?.text()).toBe("C, changed.");
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

  it("reads past an org the auth seam refuses, however many due sources it has", async () => {
    const h = harness({ sitemap: { a: null }, pages: { a: "A." } });
    const allowed = await seedSource(await seedAssistant());
    await syncOnce(h, allowed);
    h.advance(SYNC_INTERVAL_MS.daily);

    // More due sources than one tick reads, all never synced, so all ahead
    // of `allowed` in the oldest-first order.
    const otherAssistant = await seedAssistant(OTHER_ORG);
    const refused: string[] = [];
    for (let i = 0; i < 31; i++) {
      refused.push(await seedSource(otherAssistant, undefined, OTHER_ORG));
    }
    let refusing = true;
    const asked: string[] = [];
    const deps: SyncSchedulerDeps = {
      ...h.deps(),
      maxSources: 1,
      resolveOrg: async (orgId) => {
        asked.push(orgId);
        return refusing && orgId === OTHER_ORG ? null : orgId;
      },
    };

    expect(await runDueSyncs(deps)).toEqual({ started: [], refusedOrgs: 1 });
    expect(await runDueSyncs(deps)).toEqual({ started: [allowed], refusedOrgs: 0 });
    expect(asked).toEqual([OTHER_ORG, ORG]);
    for (const id of refused) expect(await state(id, OTHER_ORG)).toBeNull();

    // Once the org is allowed again, its sources come up in later ticks.
    refusing = false;
    h.advance(60_000);
    const { started } = await runDueSyncs(deps);
    expect(started).toHaveLength(1);
    expect(refused).toContain(started[0]);
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

  describe("a run whose lease ends while a page is being fetched", () => {
    /** A fetch during which the clock moves `ms` on. */
    const slowPages = (h: ReturnType<typeof harness>, ms: number): PageFetcher => ({
      async fetchPage(url, validators) {
        h.advance(ms);
        return h.pages.fetchPage(url, validators);
      },
    });
    const bodies = async (documentId: string) =>
      (await env.DOCS.list({ prefix: `org/${ORG}/doc/${documentId}/` })).objects.length;

    it("writes no new page and leaves the run interrupted", async () => {
      const h = harness({ sitemap: { a: null }, pages: { a: "A." } });
      const sourceId = await seedSource(await seedAssistant());
      await startSourceSync(h.deps(), ORG, sourceId);
      h.advance(SYNC_LEASE_MS - 1_000);
      await h.drain(ORG, slowPages(h, 2_000));
      expect(h.pageFetches).toHaveLength(1);
      expect(await docUrls(sourceId)).toEqual([]);
      expect(h.ingestMessages).toEqual([]);
      expect(await forScheduledSync(env.DB, ORG).sync.get(sourceId, h.now)).toMatchObject({
        outcome: "failed",
        error: "interrupted",
        finishedAt: null,
      });
    });

    it("changes neither an existing page nor its validators", async () => {
      const h = harness({ sitemap: { a: null, b: null }, pages: { a: "Old A.", b: "B." } });
      const sourceId = await seedSource(await seedAssistant());
      await syncOnce(h, sourceId);
      const tenant = forScheduledSync(env.DB, ORG);
      const before = await tenant.documents.listForSync(sourceId);
      h.ingestMessages.length = 0;

      h.site.pages.a = "New A!";
      h.advance(SYNC_INTERVAL_MS.daily);
      await startSourceSync(h.deps(), ORG, sourceId);
      h.advance(SYNC_LEASE_MS - 1_000);
      await h.drain(ORG, slowPages(h, 2_000));

      expect(h.ingestMessages).toEqual([]);
      expect(await tenant.documents.listForSync(sourceId)).toEqual(before);
      const a = (await tenant.documents.listBySource(sourceId)).find((d) => d.url === page("a"));
      expect(await (await env.DOCS.get(a?.bodyKey ?? ""))?.text()).toBe("Old A.");
      expect(await tenant.sync.get(sourceId, h.now)).toMatchObject({ error: "interrupted" });
    });

    it("fences each write itself, for a lease that ends after the check", async () => {
      const h = harness({ sitemap: { a: null }, pages: { a: "Old A." } });
      const assistantId = await seedAssistant();
      const sourceId = await seedSource(assistantId);
      await syncOnce(h, sourceId);
      const tenant = forScheduledSync(env.DB, ORG);
      const [doc] = await tenant.documents.listForSync(sourceId);
      if (!doc) throw new Error("no document");

      h.advance(SYNC_INTERVAL_MS.daily);
      const started = await startSourceSync(h.deps(), ORG, sourceId);
      if (started.status !== "queued") throw new Error("not queued");
      const { runId } = started;
      const ended = h.now + SYNC_LEASE_MS;
      const write = (at: number) =>
        pushDocuments(
          { tenant, docs: env.DOCS, queue: h.queue },
          { orgId: ORG, assistantId },
          {
            sourceId,
            documents: [{ externalId: doc.externalId, url: doc.url, title: "a", markdown: "New!" }],
          },
          { syncRun: { runId, now: () => at } },
        );

      h.ingestMessages.length = 0;
      await expect(write(ended)).rejects.toBeInstanceOf(SyncRunEnded);
      expect(await tenant.documents.listForSync(sourceId)).toEqual([doc]);
      expect(await bodies(doc.id)).toBe(1);
      expect(h.ingestMessages).toEqual([]);
      const check = { etag: "x", lastModified: null, sitemapLastmod: null, checkedAt: ended };
      expect(
        await tenant.documents.recordSyncCheck(sourceId, doc.externalId, check, {
          runId,
          now: ended,
        }),
      ).toBe(false);
      expect(await tenant.sync.completePage(sourceId, runId, page("a"), "updated", ended)).toBe(
        false,
      );
      expect(await tenant.sync.get(sourceId, ended)).toMatchObject({ error: "interrupted" });
      expect(await tenant.sync.pendingPage(sourceId, runId, page("a"), ended - 1)).not.toBeNull();

      // The same writes go through while the run still holds the source.
      await write(ended - 1);
      expect(h.ingestMessages).toHaveLength(1);
      expect(
        await tenant.documents.recordSyncCheck(sourceId, doc.externalId, check, {
          runId,
          now: ended - 1,
        }),
      ).toBe(true);
      expect(await tenant.sync.completePage(sourceId, runId, page("a"), "updated", ended - 1)).toBe(
        true,
      );
      expect(await tenant.sync.get(sourceId, ended - 1)).toMatchObject({ outcome: "succeeded" });
    });
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
      wellFormed: true,
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

describe("extractSitemapEntries comments and markup", () => {
  it("ignores locations, entries and roots inside comments, processing instructions and CDATA", () => {
    const xml = `<?xml version="1.0"?>
      <!-- <sitemapindex> -->
      <urlset>
        <url><!-- <loc>https://a.example.com/old</loc> --><loc>https://a.example.com/a</loc>
          <!-- <lastmod>2020-01-01</lastmod> --><lastmod>2026-11-01</lastmod></url>
        <!-- <url><loc>https://a.example.com/commented</loc></url> -->
        <url><?pi <loc>https://a.example.com/pi</loc> ?><loc>https://a.example.com/b</loc></url>
        <url><loc><![CDATA[https://a.example.com/c]]></loc><x><![CDATA[<loc>https://a.example.com/cdata</loc>]]></x></url>
        <url><loc>https://a.example.com/<!-- split -->d</loc></url>
      </urlset>`;
    expect(extractSitemapEntries(xml, 10)).toEqual({
      entries: [
        { url: "https://a.example.com/a", lastmod: "2026-11-01" },
        { url: "https://a.example.com/b", lastmod: null },
        { url: "https://a.example.com/c", lastmod: null },
        { url: "https://a.example.com/d", lastmod: null },
      ],
      truncated: false,
      isIndex: false,
      wellFormed: true,
    });
  });

  it("reads bare <loc> children of the urlset", () => {
    expect(
      extractSitemapEntries(
        "<urlset><loc>https://a.example.com/x</loc><!-- <loc>https://a.example.com/y</loc> --></urlset>",
        10,
      ).entries,
    ).toEqual([{ url: "https://a.example.com/x", lastmod: null }]);
  });
});

describe("isWellFormedUrlset", () => {
  const ns = `xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"`;
  const entry = "<url><loc>https://a.example.com/x?a=1&amp;b=2</loc></url>";

  it("accepts complete urlset documents", () => {
    for (const xml of [
      `<urlset>${entry}</urlset>`,
      `\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by hand -->\n<urlset ${ns}>${entry}</urlset>\n`,
      `<urlset ${ns} xmlns:image='http://www.google.com/schemas/sitemap-image/1.1'><url><loc><![CDATA[https://a.example.com/<y>]]></loc><image:image><image:loc>https://a.example.com/i.png</image:loc></image:image></url></urlset>`,
      `<urlset ${ns}/>`,
      `<urlset><url ><loc>https://a.example.com/&#233;&#xE9;</loc></url ></urlset>`,
    ]) {
      expect(isWellFormedUrlset(xml), xml).toBe(true);
    }
  });

  it("refuses a body cut short, broken XML, and other roots", () => {
    for (const xml of [
      "",
      `<urlset ${ns}>${entry}`,
      `<urlset>${entry}<url><loc>https://a.example.com/y`,
      `<urlset>${entry}<url><loc>https://a.example.com/y</url></loc></urlset>`,
      `<urlset>${entry}</urlset>${entry}`,
      `<urlset>${entry}</urlset>trailing`,
      `<urlset>${entry}<!-- unfinished`,
      `<urlset><url><loc>https://a.example.com/?a=1&b=2</loc></url></urlset>`,
      `<urlset><url><loc>a < b</loc></url></urlset>`,
      `<urlset a=unquoted>${entry}</urlset>`,
      `<!DOCTYPE urlset><urlset>${entry}</urlset>`,
      `<sitemapindex><sitemap><loc>https://a.example.com/s.xml</loc></sitemap></sitemapindex>`,
      `<sm:urlset>${entry}</sm:urlset>`,
      entry,
      "<loc>https://a.example.com/x</loc>",
    ]) {
      expect(isWellFormedUrlset(xml), xml).toBe(false);
    }
  });
});
