import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { newId, type SourceSyncStatus } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { SYNC_DUE_SLACK_MS, SYNC_INTERVAL_MS } from "../../src/ingest/sync.js";
import type { Limits, PageFetcher } from "../../src/seams/types.js";
import { fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

const ORG_A = TEST_ORG_ID;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const SITEMAP = "https://docs.example.com/sitemap.xml";
const page = (path: string) => `https://docs.example.com/${path}`;

function sitemapXml(paths: string[]): string {
  const urls = paths.map((path) => `<url><loc>${page(path)}</loc></url>`).join("");
  return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

interface Harness {
  app: ReturnType<typeof createApp>;
  /** Queue messages sent so far, page messages and indexing messages alike. */
  sent: unknown[];
  site: { paths: string[]; status: number };
  call(method: string, path: string, body?: unknown): Promise<Response>;
  /** Delivers every queued sync page message through the app's queue handler. */
  drain(): Promise<void>;
}

function harness(orgId: string, limits?: Limits): Harness {
  const site = { paths: ["a", "b"], status: 200 };
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
        title: new URL(url).pathname,
        markdown: `Body of ${url}.`,
        etag: null,
        lastModified: null,
        notModified: false,
      };
    },
  };
  const app = createApp(
    fakeSeams({
      pages,
      ...(limits ? { limits } : {}),
      auth: {
        async authenticate() {
          return { orgId, userId: "owner", role: "owner" };
        },
      },
    }),
    {
      // Only the sitemap is fetched with this; pages go through `pages`.
      fetch: async () =>
        site.status === 200
          ? new Response(sitemapXml(site.paths), { headers: { "content-type": "application/xml" } })
          : new Response("gone", { status: site.status }),
    },
  );
  const testEnv = { ...env, INGEST_QUEUE: queue as unknown as Queue };

  return {
    app,
    sent,
    site,
    async call(method, path, body) {
      const ctx = createExecutionContext();
      const headers: Record<string, string> = {};
      if (method !== "GET") headers.Origin = "https://example.com";
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await app.fetch(
        new Request(`https://example.com${path}`, {
          method,
          headers,
          body: body === undefined ? null : JSON.stringify(body),
        }),
        testEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    },
    async drain() {
      const pending = sent
        .splice(0)
        .filter((body) => (body as { kind?: string }).kind === "sync_page");
      const messages = pending.map((body) => {
        const message = {
          id: newId("msg"),
          timestamp: new Date(),
          body,
          attempts: 1,
          ack() {},
          retry() {},
        };
        return message as unknown as Message<unknown>;
      });
      await app.queue(
        { messages, queue: "q", retryAll() {}, ackAll() {} } as unknown as MessageBatch,
        testEnv,
        createExecutionContext(),
      );
    },
  };
}

async function createAssistant(h: Harness): Promise<string> {
  const res = await h.call("POST", "/api/admin/assistants", { name: "Docs", allowedOrigins: [] });
  return ((await res.json()) as { assistant: { id: string } }).assistant.id;
}

async function createSource(
  h: Harness,
  assistantId: string,
  kind: "sitemap" | "entry",
  settings: Record<string, unknown> = { url: SITEMAP },
): Promise<string> {
  const res = await h.call("POST", `/api/admin/assistants/${assistantId}/sources`, {
    kind,
    label: kind === "sitemap" ? "Docs site" : "Answers",
    ...(kind === "sitemap" ? { settings } : {}),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { source: { id: string } }).source.id;
}

type Listed = { id: string; kind: string; sync?: SourceSyncStatus };

async function listed(h: Harness, assistantId: string): Promise<Listed[]> {
  const res = await h.call("GET", `/api/admin/assistants/${assistantId}/sources`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { sources: Listed[] }).sources;
}

async function syncNow(h: Harness, sourceId: string): Promise<Response> {
  return h.call("POST", `/api/admin/sources/${sourceId}/sync`);
}

describe("admin source sync API", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM source_sync_pages"),
      env.DB.prepare("DELETE FROM source_sync_attempts"),
      env.DB.prepare("DELETE FROM source_syncs"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  it("lists the schedule and next sync on sitemap sources only, and saves a schedule change", async () => {
    const h = harness(ORG_A);
    const assistantId = await createAssistant(h);
    const sitemapId = await createSource(h, assistantId, "sitemap");
    const entryId = await createSource(h, assistantId, "entry");

    let sources = await listed(h, assistantId);
    expect(sources.find((s) => s.id === entryId)?.sync).toBeUndefined();
    expect(sources.find((s) => s.id === sitemapId)?.sync).toEqual({
      schedule: "off",
      last: null,
      nextSyncAt: null,
    });

    const before = Date.now();
    const patched = await h.call("PATCH", `/api/admin/sources/${sitemapId}`, {
      settings: { sync: "weekly" },
    });
    expect(patched.status).toBe(200);
    sources = await listed(h, assistantId);
    const sync = sources.find((s) => s.id === sitemapId)?.sync;
    expect(sync?.schedule).toBe("weekly");
    // Never synced: due at the scheduler's next check.
    expect(sync?.nextSyncAt).toBeGreaterThanOrEqual(before);
    expect(sync?.nextSyncAt).toBeLessThanOrEqual(Date.now());

    const bad = await h.call("PATCH", `/api/admin/sources/${sitemapId}`, {
      settings: { sync: "hourly" },
    });
    expect(bad.status).toBe(400);
  });

  it("starts a run on Sync now, reports its progress, refuses a second run, and reports the outcome", async () => {
    const h = harness(ORG_A);
    const assistantId = await createAssistant(h);
    const sourceId = await createSource(h, assistantId, "sitemap", { url: SITEMAP, sync: "daily" });

    const started = await syncNow(h, sourceId);
    expect(started.status).toBe(202);
    const running = ((await started.json()) as { sync: SourceSyncStatus }).sync;
    expect(running).toMatchObject({
      schedule: "daily",
      nextSyncAt: null,
      last: { outcome: "running", finishedAt: null, progress: { done: 0, total: 2 } },
    });

    // The same run is going: a second click does not start another.
    const again = await syncNow(h, sourceId);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe(
      "This source is already syncing.",
    );

    await h.drain();
    const done = await h.call("GET", `/api/admin/sources/${sourceId}/sync`);
    expect(done.status).toBe(200);
    const status = ((await done.json()) as { sync: SourceSyncStatus }).sync;
    expect(status.last).toMatchObject({
      outcome: "succeeded",
      error: null,
      progress: null,
      counts: { added: 2, updated: 0, unchanged: 0, removed: 0, failed: 0, deferred: 0 },
    });
    expect(status.last?.finishedAt).toEqual(expect.any(Number));
    expect(status.nextSyncAt).toBe(
      (status.last?.startedAt ?? 0) + SYNC_INTERVAL_MS.daily - SYNC_DUE_SLACK_MS,
    );

    const sources = await listed(h, assistantId);
    expect(sources.find((s) => s.id === sourceId)?.sync).toEqual(status);
  });

  it("runs Sync now on a source whose schedule is off", async () => {
    const h = harness(ORG_A);
    const assistantId = await createAssistant(h);
    const sourceId = await createSource(h, assistantId, "sitemap");

    const res = await syncNow(h, sourceId);
    expect(res.status).toBe(202);
    await h.drain();
    const sync = (await listed(h, assistantId)).find((s) => s.id === sourceId)?.sync;
    expect(sync).toMatchObject({
      schedule: "off",
      nextSyncAt: null,
      last: { outcome: "succeeded" },
    });
  });

  it("records a sitemap that cannot be read as failed and lists it under Overview's attention", async () => {
    const h = harness(ORG_A);
    const assistantId = await createAssistant(h);
    const sourceId = await createSource(h, assistantId, "sitemap");
    await createSource(h, assistantId, "entry");
    h.site.status = 404;

    const res = await syncNow(h, sourceId);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { sync: SourceSyncStatus }).sync.last).toMatchObject({
      outcome: "failed",
      error: "sitemap_unavailable",
      progress: null,
    });
    // Nothing queued: a failed read fetches no page.
    expect(h.sent).toEqual([]);

    const overview = await h.call("GET", `/api/admin/assistants/${assistantId}/overview`);
    const attention = (
      (await overview.json()) as {
        attention: { syncFailed: Array<{ sourceId: string; label: string; error: string | null }> };
      }
    ).attention;
    expect(attention.syncFailed).toEqual([
      { sourceId, label: "Docs site", error: "sitemap_unavailable" },
    ]);

    // A later run that succeeds takes it off the list.
    h.site.status = 200;
    expect((await syncNow(h, sourceId)).status).toBe(202);
    await h.drain();
    const after = await h.call("GET", `/api/admin/assistants/${assistantId}/overview`);
    expect(
      ((await after.json()) as { attention: { syncFailed: unknown[] } }).attention.syncFailed,
    ).toEqual([]);
  });

  it("asks the Limits seam and records its refusal without reading the sitemap", async () => {
    const h = harness(ORG_A, {
      async check() {
        return { ok: true };
      },
      async checkSync() {
        return { ok: false, reason: "suspended" };
      },
    });
    const assistantId = await createAssistant(h);
    const sourceId = await createSource(h, assistantId, "sitemap");

    const res = await syncNow(h, sourceId);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { sync: SourceSyncStatus }).sync.last).toMatchObject({
      outcome: "failed",
      error: "limit_refused",
    });
    expect(h.sent).toEqual([]);
  });

  it("refuses Sync now on sources that do not sync, and hides other orgs' sources", async () => {
    const a = harness(ORG_A);
    const b = harness(ORG_B);
    const assistantId = await createAssistant(a);
    const entryId = await createSource(a, assistantId, "entry");
    const sitemapId = await createSource(a, assistantId, "sitemap");

    const entry = await syncNow(a, entryId);
    expect(entry.status).toBe(400);
    expect((await a.call("GET", `/api/admin/sources/${entryId}/sync`)).status).toBe(400);

    expect((await syncNow(b, sitemapId)).status).toBe(404);
    expect((await b.call("GET", `/api/admin/sources/${sitemapId}/sync`)).status).toBe(404);
    expect((await syncNow(a, "src_missing")).status).toBe(404);
    // Nothing started for org B's attempt.
    const sync = (await listed(a, assistantId)).find((s) => s.id === sitemapId)?.sync;
    expect(sync?.last).toBeNull();
  });

  it("needs the Worker's own Origin to start a run", async () => {
    const h = harness(ORG_A);
    const assistantId = await createAssistant(h);
    const sourceId = await createSource(h, assistantId, "sitemap");
    const ctx = createExecutionContext();
    const res = await h.app.fetch(
      new Request(`https://example.com/api/admin/sources/${sourceId}/sync`, { method: "POST" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
  });
});
