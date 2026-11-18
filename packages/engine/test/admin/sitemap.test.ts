import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  importSitemapUrls,
  MAX_IMPORT_URLS,
  MAX_REDIRECTS,
  MAX_SITEMAP_BYTES,
  previewSitemap,
  UnsafeUrlError,
} from "../../src/admin/sitemap.js";
import { createApp } from "../../src/app.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { runIngestBatch } from "../../src/ingest/consumer.js";
import type { IngestQueueMessage } from "../../src/ingest/documents.js";
import { htmlToTitleAndMarkdown } from "../../src/ingest/htmlToMarkdown.js";
import { plainPageFetcher } from "../../src/ingest/pageFetcher.js";
import type { PageFetcher } from "../../src/seams/types.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { acceptQueuedOrg, createTestApp, fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

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

  it("refuses more pages in one request than fit the Workers subrequest budget, before fetching", async () => {
    const assistantId = await seedAssistant(ORG_A);
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    let fetches = 0;
    const urls = Array.from(
      { length: MAX_IMPORT_URLS + 1 },
      (_, i) => `https://docs.example.com/p${i}`,
    );
    await expect(
      importSitemapUrls(
        { tenant, docs: env.DOCS, queue: makeQueue() },
        { orgId: ORG_A, assistantId },
        { urls },
        plainPageFetcher({
          fetch: async () => {
            fetches++;
            return new Response("x");
          },
        }),
      ),
    ).rejects.toThrow(/at most 5 URLs per request/);
    expect(fetches).toBe(0);
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
      plainPageFetcher({ fetch: fetchImpl }),
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
      {
        db: env.DB,
        resolveOrg: acceptQueuedOrg,
        docs: env.DOCS,
        embedder: fakeEmbedder(),
        retriever,
      },
    );

    for (const doc of docs) {
      const chunks = await tenant.documents.listChunks(doc.id);
      expect(chunks.length).toBeGreaterThan(0);
    }
  });

  it("times out and cancels a stalled body in both previewSitemap and importSitemapUrls", async () => {
    let previewCancelled = false;
    const stalledPreviewFetch: typeof fetch = async () => {
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      writer.closed.catch(() => {
        previewCancelled = true;
      });
      void writer.write(new TextEncoder().encode("<urlset>")).catch(() => {});
      return new Response(stream.readable, {
        status: 200,
        headers: { "content-type": "application/xml" },
      });
    };

    await expect(
      previewSitemap("https://docs.example.com/sitemap.xml", stalledPreviewFetch, {
        timeoutMs: 25,
      }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(previewCancelled).toBe(true);

    const assistantId = await seedAssistant(ORG_A);
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const queue = makeQueue();

    let importCancelled = false;
    const stalledImportFetch: typeof fetch = async () => {
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      writer.closed.catch(() => {
        importCancelled = true;
      });
      void writer
        .write(new TextEncoder().encode("<html><title>Slow</title><body>"))
        .catch(() => {});
      return new Response(stream.readable, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };

    await expect(
      importSitemapUrls(
        { tenant, docs: env.DOCS, queue },
        { orgId: ORG_A, assistantId },
        { urls: ["https://docs.example.com/stalled"] },
        plainPageFetcher({ fetch: stalledImportFetch, timeoutMs: 25 }),
      ),
    ).rejects.toThrow(UnsafeUrlError);
    expect(importCancelled).toBe(true);
  });

  it("imports a mixed batch containing a URL longer than 200 characters with a bounded stable externalId", async () => {
    const assistantId = await seedAssistant(ORG_A);
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const queue = makeQueue();

    const shortUrl = "https://docs.example.com/short";
    const longUrl = `https://docs.example.com/guides/${"a".repeat(220)}?ref=sitemap`;
    expect(longUrl.length).toBeGreaterThan(200);

    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(
        `<html><head><title>Page</title></head><body><p>Body for ${url}</p></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    };

    const first = await importSitemapUrls(
      { tenant, docs: env.DOCS, queue },
      { orgId: ORG_A, assistantId },
      { sitemapUrl: "https://docs.example.com/sitemap.xml", urls: [shortUrl, longUrl] },
      plainPageFetcher({ fetch: fetchImpl }),
    );
    expect(first.written).toBe(2);
    expect(first.total).toBe(2);

    const docs = await tenant.documents.listBySource(first.source.id);
    expect(docs).toHaveLength(2);
    for (const doc of docs) {
      expect(doc.externalId.length).toBeGreaterThan(0);
      expect(doc.externalId.length).toBeLessThanOrEqual(200);
    }
    expect(docs.map((d) => d.url).sort()).toEqual([shortUrl, longUrl].sort());

    // Re-importing the same URLs into the same source resolves the same stable externalIds.
    const second = await importSitemapUrls(
      { tenant, docs: env.DOCS, queue },
      { orgId: ORG_A, assistantId },
      { sourceId: first.source.id, urls: [shortUrl, longUrl] },
      plainPageFetcher({ fetch: fetchImpl }),
    );
    expect(second.total).toBe(2);
    const docsAfter = await tenant.documents.listBySource(first.source.id);
    expect(
      docsAfter
        .map((d) => ({ id: d.id, externalId: d.externalId }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(
      docs
        .map((d) => ({ id: d.id, externalId: d.externalId }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
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

  it("recovers within the same source without duplicating documents when retrying after a queue failure", async () => {
    const assistantId = await seedAssistant(ORG_A);
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });

    const createdSource = await tenant.sources.create({
      id: newId("src"),
      assistantId,
      kind: "sitemap",
      label: "docs.example.com",
      settings: { url: "https://docs.example.com/sitemap.xml" },
      createdAt: Date.now(),
    });

    const sent: IngestQueueMessage[] = [];
    let sendCalls = 0;
    let shouldFailSecond = true;
    const flakyQueue = {
      async send(message: IngestQueueMessage) {
        sendCalls++;
        if (shouldFailSecond && sendCalls === 2) {
          throw new Error("queue send failed");
        }
        sent.push(message);
      },
    };

    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(
        `<html><head><title>Page</title></head><body><p>Body for ${url}</p></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    };

    const chosen = ["https://docs.example.com/one", "https://docs.example.com/two"];

    await expect(
      importSitemapUrls(
        { tenant, docs: env.DOCS, queue: flakyQueue },
        { orgId: ORG_A, assistantId },
        {
          sourceId: createdSource.id,
          sitemapUrl: "https://docs.example.com/sitemap.xml",
          urls: chosen,
        },
        plainPageFetcher({ fetch: fetchImpl }),
      ),
    ).rejects.toThrow("queue send failed");

    // Retry with the same sourceId after the transient queue failure clears.
    shouldFailSecond = false;
    const retried = await importSitemapUrls(
      { tenant, docs: env.DOCS, queue: flakyQueue },
      { orgId: ORG_A, assistantId },
      {
        sourceId: createdSource.id,
        sitemapUrl: "https://docs.example.com/sitemap.xml",
        urls: chosen,
      },
      plainPageFetcher({ fetch: fetchImpl }),
    );

    expect(retried.source.id).toBe(createdSource.id);
    expect(retried.total).toBe(2);

    const sources = await tenant.sources.listWithStats(assistantId);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.id).toBe(createdSource.id);
    expect(sources[0]?.documentCount).toBe(2);

    const docs = await tenant.documents.listBySource(createdSource.id);
    expect(docs).toHaveLength(2);

    const retriever = memoryRetriever();
    await runIngestBatch(
      {
        messages: sent.map((body) => ({
          id: newId("msg"),
          timestamp: new Date(),
          attempts: 1,
          body,
          ack() {},
          retry() {},
        })),
      },
      {
        db: env.DB,
        resolveOrg: acceptQueuedOrg,
        docs: env.DOCS,
        embedder: fakeEmbedder(),
        retriever,
      },
    );

    for (const doc of docs) {
      const chunks = await tenant.documents.listChunks(doc.id);
      expect(chunks.length).toBeGreaterThan(0);
    }
  });

  it("refuses hostnames resolving to private or loopback addresses on initial, redirect, and imported page fetches", async () => {
    let fetchCalled = false;
    const fetchImpl: typeof fetch = async () => {
      fetchCalled = true;
      return new Response("");
    };

    // 1. Initial sitemap hostname resolves to loopback.
    await expect(
      previewSitemap("https://internal.example.com/sitemap.xml", fetchImpl, {
        resolveHost: async () => ["127.0.0.1"],
      }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(fetchCalled).toBe(false);

    // 2. Hostname resolving to a mix of public and private IPs is rejected.
    await expect(
      previewSitemap("https://dual.example.com/sitemap.xml", fetchImpl, {
        resolveHost: async () => ["93.184.216.34", "169.254.169.254"],
      }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(fetchCalled).toBe(false);

    // 3. Empty resolution is rejected.
    await expect(
      previewSitemap("https://missing.example.com/sitemap.xml", fetchImpl, {
        resolveHost: async () => [],
      }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(fetchCalled).toBe(false);

    // 4. Redirect to a hostname resolving to a private IP is rejected before fetching the hop.
    const redirectFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://public.example.com/sitemap.xml") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://rebind.example.com/secret" },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    };

    await expect(
      previewSitemap("https://public.example.com/sitemap.xml", redirectFetch, {
        resolveHost: async (host) =>
          host === "public.example.com" ? ["93.184.216.34"] : ["10.0.0.42"],
      }),
    ).rejects.toThrow(UnsafeUrlError);

    // 5. Imported page URL resolving to private IPv6 loopback is rejected.
    const assistantId = await seedAssistant(ORG_A);
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const queue = makeQueue();
    await expect(
      importSitemapUrls(
        { tenant, docs: env.DOCS, queue },
        { orgId: ORG_A, assistantId },
        { urls: ["https://v6loop.example.com/page"] },
        plainPageFetcher({ fetch: fetchImpl, resolveHost: async () => ["::1"] }),
      ),
    ).rejects.toThrow(UnsafeUrlError);
    expect(fetchCalled).toBe(false);
  });
});

describe("sitemap import through the page-fetcher seam", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
    ]);
  });

  async function postImport(
    app: ReturnType<typeof createApp>,
    assistantId: string,
    urls: string[],
  ) {
    const ctx = createExecutionContext();
    // A local queue: a real send is delivered after the test, into whichever
    // test file's storage is current by then.
    const queue = makeQueue();
    const res = await app.fetch(
      new Request(`https://example.com/api/admin/assistants/${assistantId}/sitemap-import`, {
        method: "POST",
        headers: { Origin: "https://example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      }),
      { ...env, INGEST_QUEUE: queue as unknown as Queue },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(queue.sent.length).toBe(urls.length);
    return res;
  }

  it("skips a non-HTML page and writes a page with no text as its title, as before", async () => {
    const assistantId = await seedAssistant(ORG_A);
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith(".pdf")) {
        return new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } });
      }
      if (url.endsWith("/empty")) {
        return new Response("<title>Coming soon</title><script>x()</script>", {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("<title>Guide</title><p>Read me.</p>", {
        headers: { "content-type": "text/html" },
      });
    };

    const result = await importSitemapUrls(
      { tenant, docs: env.DOCS, queue: makeQueue() },
      { orgId: ORG_A, assistantId },
      {
        urls: [
          "https://docs.example.com/guide",
          "https://docs.example.com/manual.pdf",
          "https://docs.example.com/empty",
        ],
      },
      plainPageFetcher({ fetch: fetchImpl }),
    );

    expect(result).toMatchObject({ written: 2, unchanged: 0, total: 2, skipped: 1 });
    const docs = await tenant.documents.listBySource(result.source.id);
    expect(docs.map((d) => d.title).sort()).toEqual(["Coming soon", "Guide"]);
    const empty = docs.find((d) => d.title === "Coming soon");
    const stored = await env.DOCS.get(empty?.bodyKey ?? "");
    expect(await stored?.text()).toBe("# Coming soon");
  });

  it("uses the host's page fetcher when createApp is given one", async () => {
    const assistantId = await seedAssistant(ORG_A);
    const asked: string[] = [];
    const pages: PageFetcher = {
      async fetchPage(url) {
        asked.push(url);
        return {
          kind: "page",
          finalUrl: url,
          status: 200,
          title: "Rendered",
          markdown: "Rendered by the host.",
          etag: null,
          lastModified: null,
          notModified: false,
        };
      },
    };
    const app = createApp(fakeSeams({ pages }), {
      fetch: async () => {
        throw new Error("the default fetcher must not run");
      },
    });

    const res = await postImport(app, assistantId, ["https://docs.example.com/spa"]);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ written: 1, total: 1, skipped: 0 });
    expect(asked).toEqual(["https://docs.example.com/spa"]);
  });

  it("falls back to the plain fetcher when the host passes no page fetcher", async () => {
    const assistantId = await seedAssistant(ORG_A);
    const fetched: string[] = [];
    const seams = fakeSeams();
    expect(seams.pages).toBeUndefined();
    const app = createApp(seams, {
      fetch: async (input) => {
        fetched.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return new Response("<title>Plain</title><p>Fetched.</p>", {
          headers: { "content-type": "text/html" },
        });
      },
    });

    const res = await postImport(app, assistantId, ["https://docs.example.com/plain"]);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ written: 1, total: 1, skipped: 0 });
    expect(fetched).toEqual(["https://docs.example.com/plain"]);
  });
});

describe("htmlToTitleAndMarkdown", () => {
  it("turns an ordinary page into a title and Markdown", () => {
    const html = `<html><head><title>Billing &amp; plans</title><style>p{color:red}</style></head>
<body><h1 class="top">Billing <b>help</b></h1><p>Pay by <a href="/card">card</a>.</p>
<ul><li>Monthly</li><li class="x">Yearly <i>saves</i></li></ul>
<script>var s = "<p>hidden</p>";</script><noscript>Enable JS</noscript>
<div>Line one<br>Line two</div><h2>Refunds</h2>Within 30 days &lt;always&gt;</body></html>`;
    expect(htmlToTitleAndMarkdown(html, "https://example.com/billing")).toEqual({
      title: "Billing & plans",
      markdown:
        "# Billing help\n\nPay by card.\n\n- Monthly\n- Yearly saves\n\nLine one\nLine two\n\n## Refunds\n\nWithin 30 days <always>",
    });
  });

  it("falls back to the URL path when there is no title", () => {
    expect(htmlToTitleAndMarkdown("<p>Body</p>", "https://example.com/a/b").title).toBe("/a/b");
  });

  it("handles a 1 MiB page of unclosed tags in linear time", () => {
    for (const unit of ["<script ", "<style ", "<title ", "<h1>", "<li>", "<p ", "<"]) {
      const html = unit.repeat(Math.floor((1024 * 1024) / unit.length));
      const started = Date.now();
      htmlToTitleAndMarkdown(html, "https://example.com/");
      // The regex version took minutes on the same input; a linear scan takes
      // milliseconds. The bound is loose so a slow CI host cannot flake it.
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });
});
