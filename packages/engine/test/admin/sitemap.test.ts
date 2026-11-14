import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  importSitemapUrls,
  MAX_REDIRECTS,
  MAX_SITEMAP_BYTES,
  previewSitemap,
  UnsafeUrlError,
} from "../../src/admin/sitemap.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { runIngestBatch } from "../../src/ingest/consumer.js";
import type { IngestQueueMessage } from "../../src/ingest/documents.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

const ORG_A = TEST_ORG_ID;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";

function makeQueue() {
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

describe("admin sitemap preview and import", () => {
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

  it("lists URLs from canned sitemap XML", async () => {
    const cannedXml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://docs.example.com/start</loc></url>
        <url><loc>https://docs.example.com/pricing?a=1&amp;b=2</loc></url>
      </urlset>`;

    const fetchImpl: typeof fetch = async () =>
      new Response(cannedXml, {
        status: 200,
        headers: { "content-type": "application/xml" },
      });

    const urls = await previewSitemap("https://docs.example.com/sitemap.xml", fetchImpl);
    expect(urls).toEqual([
      "https://docs.example.com/start",
      "https://docs.example.com/pricing?a=1&b=2",
    ]);
  });

  it("rejects non-https sitemap URLs without calling fetch", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("");
    };

    await expect(previewSitemap("http://docs.example.com/sitemap.xml", fetchImpl)).rejects.toThrow(
      UnsafeUrlError,
    );
    expect(called).toBe(false);
  });

  it("rejects localhost and loopback addresses without calling fetch", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("");
    };

    await expect(previewSitemap("https://localhost/sitemap.xml", fetchImpl)).rejects.toThrow(
      UnsafeUrlError,
    );
    await expect(previewSitemap("https://127.0.0.1/sitemap.xml", fetchImpl)).rejects.toThrow(
      UnsafeUrlError,
    );
    await expect(previewSitemap("https://[::1]/sitemap.xml", fetchImpl)).rejects.toThrow(
      UnsafeUrlError,
    );
    expect(called).toBe(false);
  });

  it("rejects private and link-local addresses without calling fetch", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("");
    };

    await expect(
      previewSitemap("https://169.254.169.254/latest/meta-data", fetchImpl),
    ).rejects.toThrow(UnsafeUrlError);
    await expect(previewSitemap("https://10.0.0.5/sitemap.xml", fetchImpl)).rejects.toThrow(
      UnsafeUrlError,
    );
    await expect(previewSitemap("https://192.168.1.1/sitemap.xml", fetchImpl)).rejects.toThrow(
      UnsafeUrlError,
    );
    expect(called).toBe(false);
  });

  it("refuses a sitemap redirecting to a private or loopback address", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/secret" },
      });

    await expect(previewSitemap("https://docs.example.com/sitemap.xml", fetchImpl)).rejects.toThrow(
      UnsafeUrlError,
    );
  });

  it("rejects a sitemap over the size cap", async () => {
    const oversized = "x".repeat(MAX_SITEMAP_BYTES + 1);
    const fetchImpl: typeof fetch = async () =>
      new Response(oversized, {
        status: 200,
        headers: { "content-type": "application/xml" },
      });

    await expect(previewSitemap("https://docs.example.com/sitemap.xml", fetchImpl)).rejects.toThrow(
      UnsafeUrlError,
    );
  });

  it("refuses more redirects than the cap", async () => {
    let hops = 0;
    const fetchImpl: typeof fetch = async () => {
      hops++;
      return new Response(null, {
        status: 302,
        headers: { location: `https://docs.example.com/hop-${hops}` },
      });
    };

    await expect(previewSitemap("https://docs.example.com/sitemap.xml", fetchImpl)).rejects.toThrow(
      UnsafeUrlError,
    );
    expect(hops).toBe(MAX_REDIRECTS + 1);
  });

  it("imports only the chosen URLs through pushDocuments and produces chunks via the consumer", async () => {
    const assistantId = await seedAssistant(ORG_A);
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const queue = makeQueue();

    const fetchedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetchedUrls.push(url);
      return new Response(
        `<html><head><title>Page ${fetchedUrls.length}</title></head><body><h1>Heading</h1><p>Content for ${url}</p></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    };

    const chosen = ["https://docs.example.com/one", "https://docs.example.com/two"];
    const result = await importSitemapUrls(
      { tenant, docs: env.DOCS, queue },
      { orgId: ORG_A, assistantId },
      { sitemapUrl: "https://docs.example.com/sitemap.xml", urls: chosen },
      fetchImpl,
    );

    expect(fetchedUrls).toEqual(chosen);
    expect(result.written).toBe(2);
    expect(result.total).toBe(2);
    expect(queue.sent).toHaveLength(2);

    const docs = await tenant.documents.listBySource(result.source.id);
    expect(docs).toHaveLength(2);

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

    for (const doc of docs) {
      const chunks = await tenant.documents.listChunks(doc.id);
      expect(chunks.length).toBeGreaterThan(0);
    }
  });

  it("returns 404 for another org's assistant on sitemap-preview and sitemap-import", async () => {
    const assistantA = await seedAssistant(ORG_A);
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

    const callB = async (path: string, body: unknown) => {
      const ctx = createExecutionContext();
      const res = await appB.fetch(
        new Request(`https://example.com${path}`, {
          method: "POST",
          headers: { Origin: "https://example.com", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };

    expect(
      (
        await callB(`/api/admin/assistants/${assistantA}/sitemap-preview`, {
          url: "https://docs.example.com/sitemap.xml",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await callB(`/api/admin/assistants/${assistantA}/sitemap-import`, {
          urls: ["https://docs.example.com/one"],
        })
      ).status,
    ).toBe(404);
  });
});
