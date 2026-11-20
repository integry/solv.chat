import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { contentStatus } from "../../src/admin/contentStatus.js";
import { reindexAssistant } from "../../src/admin/reindex.js";
import { deleteSource } from "../../src/admin/sources.js";
import { pushDocuments } from "../../src/ingest/documents.js";
import { INDEX_SETTLE_MS } from "../../src/ingest/indexLag.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { tokenEmbedder } from "../fakes/tokenEmbedder.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";
import { capturingQueue, runConsumer, seedSite } from "../helpers/pipeline.js";

/**
 * Issue #131: while the index may not reflect an assistant's content
 * changes, Sources and Try it say so (`GET …/content-status`).
 */
describe("admin content status", () => {
  let site: Awaited<ReturnType<typeof seedSite>>;
  const embedder = tokenEmbedder();
  const retriever = memoryRetriever();
  const scope = () => ({ orgId: TEST_ORG_ID, assistantId: site.assistantId });

  async function importPage() {
    const queue = capturingQueue();
    await pushDocuments({ tenant: site.tenant, docs: env.DOCS, queue }, scope(), {
      sourceId: site.sitemapSourceId,
      documents: [
        {
          externalId: "intro",
          url: "https://docs.example.com/intro",
          title: "Intro",
          markdown:
            "# Intro\n\nThe service keeps every upload for ninety days before it is removed.",
        },
      ],
    });
    return queue;
  }

  beforeEach(async () => {
    site = await seedSite();
  });

  it("is quiet for an assistant whose content never changed", async () => {
    expect(await contentStatus(site.tenant, site.assistantId)).toEqual({
      settling: false,
      indexing: 0,
      settlesAt: null,
    });
  });

  it("is on from an import until a while after its pages are indexed, then clears", async () => {
    const queue = await importPage();
    // Queued, not yet indexed.
    expect(await contentStatus(site.tenant, site.assistantId)).toEqual({
      settling: true,
      indexing: 1,
      settlesAt: null,
    });

    const before = Date.now();
    await runConsumer(queue.messages, { embedder, retriever });
    const after = Date.now();
    const indexed = await contentStatus(site.tenant, site.assistantId, after);
    expect(indexed.settling).toBe(true);
    expect(indexed.indexing).toBe(0);
    expect(indexed.settlesAt).toBeGreaterThanOrEqual(before + INDEX_SETTLE_MS);
    expect(indexed.settlesAt).toBeLessThanOrEqual(after + INDEX_SETTLE_MS);

    const later = await contentStatus(site.tenant, site.assistantId, after + INDEX_SETTLE_MS + 1);
    expect(later).toEqual({ settling: false, indexing: 0, settlesAt: null });
  });

  it("is on after a Rebuild, and clears", async () => {
    await runConsumer((await importPage()).messages, { embedder, retriever });
    await env.DB.prepare("UPDATE assistants SET content_changed_at = 1").run();
    await env.DB.prepare("UPDATE documents SET ingest_version = 1").run();
    expect((await contentStatus(site.tenant, site.assistantId)).settling).toBe(false);

    const queue = capturingQueue();
    const res = await reindexAssistant(
      {
        tenant: site.tenant,
        orgId: TEST_ORG_ID,
        queue,
        limits: { check: async () => ({ ok: true }) },
      },
      site.assistantId,
    );
    expect(res.queued).toBe(1);
    expect((await contentStatus(site.tenant, site.assistantId)).settling).toBe(true);

    await runConsumer(queue.messages, { embedder, retriever });
    const done = Date.now();
    expect((await contentStatus(site.tenant, site.assistantId, done)).settling).toBe(true);
    expect(
      (await contentStatus(site.tenant, site.assistantId, done + INDEX_SETTLE_MS + 1)).settling,
    ).toBe(false);
  });

  it("is on after a source is deleted, and clears", async () => {
    await runConsumer((await importPage()).messages, { embedder, retriever });
    await env.DB.prepare("UPDATE assistants SET content_changed_at = 1").run();
    expect((await contentStatus(site.tenant, site.assistantId)).settling).toBe(false);

    await deleteSource({ tenant: site.tenant, docs: env.DOCS, retriever }, site.sitemapSourceId);
    const now = Date.now();
    expect(await contentStatus(site.tenant, site.assistantId, now)).toMatchObject({
      settling: true,
      indexing: 0,
    });
    expect(
      (await contentStatus(site.tenant, site.assistantId, now + INDEX_SETTLE_MS + 1)).settling,
    ).toBe(false);
  });

  it("is served for the signed-in org's assistant only", async () => {
    await importPage();
    const appFor = (orgId: string) =>
      createTestApp({
        auth: {
          async authenticate() {
            return { orgId, userId: "owner", role: "owner" };
          },
          async login() {
            return Response.json({ ok: true });
          },
          async logout() {
            return Response.json({ ok: true });
          },
        },
      });
    const get = async (orgId: string) => {
      const ctx = createExecutionContext();
      const res = await appFor(orgId).fetch(
        new Request(`https://example.com/api/admin/assistants/${site.assistantId}/content-status`),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };
    const own = await get(TEST_ORG_ID);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ settling: true, indexing: 1, settlesAt: null });
    await env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING")
      .bind("org_cccccccccccccccccccc", "Org C")
      .run();
    expect((await get("org_cccccccccccccccccccc")).status).toBe(404);
  });
});
