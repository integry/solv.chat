import { env } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { saveEntry } from "../../src/admin/entries.js";
import { getRepeatedBlocks, listSources } from "../../src/admin/sources.js";
import { forPrincipal, type Tenant } from "../../src/db/tenant.js";
import { runIngestBatch } from "../../src/ingest/consumer.js";
import {
  deleteDocuments,
  type IngestQueueMessage,
  pushDocuments,
} from "../../src/ingest/documents.js";
import { extractHtml } from "../../src/ingest/htmlToMarkdown.js";
import {
  pageBlocks,
  REPEATED_MIN_SOURCE_PAGES,
  repeatedThreshold,
  splitBlocks,
  withoutRepeated,
} from "../../src/ingest/repeated.js";
import {
  type RepeatedQueue,
  type RepeatedSourceMessage,
  runRepeatedSourceBatch,
} from "../../src/ingest/repeatedSource.js";
import { INGEST_VERSION } from "../../src/ingest/version.js";
import type { Embedder } from "../../src/providers/retrieval.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { tokenEmbedder } from "../fakes/tokenEmbedder.js";
import { acceptQueuedOrg, TEST_ORG_ID } from "../helpers/app.js";
import { capturingQueue, drainConsumer, seedSite } from "../helpers/pipeline.js";

// A site built from plain `div`s: no `nav`, `footer`, `aside` or ARIA role
// anywhere, and chrome that is prose, so neither the landmark rule nor the
// link-list rule of #123 catches it.
const FOOTER =
  "Acme Docs is made by Acme Software Ltd, 12 Harbour Street, Bristol BS1 4QA. Registered in England, company number 01234567.";
const COOKIE =
  "We use cookies to remember your settings and to see which pages are read. You can turn them off at any time in the cookie settings.";
const RAIL_ONE = "Billing explained: how plans, seats and invoices work each month.";
const RAIL_TWO = "Team accounts: inviting colleagues and choosing what they can change.";

const TOPICS = [
  ["Install the agent", "Download the installer for your system and run it as an administrator."],
  ["Connect a printer", "Plug the printer in, then choose Add device and pick it from the list."],
  ["Reset a password", "Open the sign-in page, choose Forgot password and follow the email."],
  ["Export a report", "Pick a date range, choose Export and select spreadsheet or PDF output."],
  ["Schedule a backup", "Choose a folder, a time of day and how many copies to keep for safety."],
  ["Change the language", "Open Preferences and choose one of the twelve languages on offer."],
  ["Archive a project", "Archived projects are read-only and can be restored by any owner."],
  ["Merge two contacts", "Select both contacts, choose Merge and keep the details you want."],
] as const;

interface Page {
  externalId: string;
  title: string;
  html: string;
}

function divPage(title: string, own: string, overview: string, chrome = true): string {
  const rail = `<div class="rail"><div class="rail-title"><h3>Related</h3></div><div class="item"><p>${RAIL_ONE}</p></div><div class="item"><p>${RAIL_TWO}</p></div></div>`;
  const tail = chrome
    ? `${rail}<div class="bottom"><div class="col"><p>${FOOTER}</p></div></div><div class="cookie-bar"><p>${COOKIE}</p></div>`
    : "";
  return `<!doctype html><html><head><title>${title}</title></head><body>
<div class="page"><div class="content"><h1>${title}</h1><h2>Overview</h2><p>${overview}</p><p>${own}</p></div>${tail}</div></body></html>`;
}

function sitePages(count: number = TOPICS.length): Page[] {
  return Array.from({ length: count }, (_, i) => {
    const [title, own] = TOPICS[i % TOPICS.length] as readonly [string, string];
    const name = count > TOPICS.length ? `${title} (part ${i})` : title;
    return {
      externalId: `page-${i}`,
      title: name,
      html: divPage(
        name,
        `${own} This is step ${i} of the guide and only this page says it.`,
        `This page covers ${name.toLowerCase()}, with the screens you will see on the way.`,
      ),
    };
  });
}

function toDocuments(pages: readonly Page[]) {
  return pages.map((page) => {
    const url = `https://docs.example.com/${page.externalId}`;
    const { title, markdown } = extractHtml(page.html, url);
    return { externalId: page.externalId, url, title, markdown };
  });
}

/** Every page's indexed text: its chunks' heading paths and text, in order. */
async function indexedText(sourceId: string): Promise<Map<string, string>> {
  const rows = await env.DB.prepare(
    `SELECT d.external_id AS external_id, c.heading_path AS heading_path, c.text AS text
       FROM chunks c JOIN documents d ON d.org_id = c.org_id AND d.id = c.document_id
      WHERE d.source_id = ?1 ORDER BY d.external_id, c.ordinal`,
  )
    .bind(sourceId)
    .all<{ external_id: string; heading_path: string; text: string }>();
  const out = new Map<string, string>();
  for (const row of rows.results) {
    const before = out.get(row.external_id);
    const part = `[${row.heading_path}]\n${row.text}`;
    out.set(row.external_id, before === undefined ? part : `${before}\n${part}`);
  }
  return out;
}

const CHROME = [FOOTER, COOKIE, RAIL_ONE, RAIL_TWO, "Related"];

describe("repeated blocks: the rules", () => {
  it("cuts Markdown into blocks, keeping a fenced block whole and headings apart", () => {
    const blocks = splitBlocks("# A\nText under A.\n\n```\ncode\n\nmore code\n```\n\n- one\n- two");
    expect(blocks).toEqual([
      { text: "# A", heading: true },
      { text: "Text under A.", heading: false },
      { text: "```\ncode\n\nmore code\n```", heading: false },
      { text: "- one\n- two", heading: false },
    ]);
  });

  it("needs at least 5 pages, 3 pages and half of them", () => {
    expect(REPEATED_MIN_SOURCE_PAGES).toBe(5);
    expect(repeatedThreshold(4)).toBeNull();
    expect(repeatedThreshold(5)).toBe(3);
    expect(repeatedThreshold(6)).toBe(3);
    expect(repeatedThreshold(7)).toBe(4);
    expect(repeatedThreshold(40)).toBe(20);
  });

  it("compares on case and whitespace, not on digits", async () => {
    const a = await pageBlocks("We use  Cookies.\n\n© 2026 Acme");
    const b = await pageBlocks("we use\ncookies.\n\n© 2025 Acme");
    expect(a.units[0]?.hash).toBe(b.units[0]?.hash);
    expect(a.units[1]?.hash).not.toBe(b.units[1]?.hash);
  });

  it("drops a heading only with its repeated body, and never most of a page or all of it", async () => {
    const own = "This paragraph is what the page is about, and it is long enough to matter here.";
    const page = await pageBlocks(`## Need help?\n\nEmail us.\n\n## Overview\n\n${own}`);
    const repeated = new Set(page.units.filter((u) => u.kind === "h").map((u) => u.hash));
    const box = page.units.find((u) => u.kind === "b" && u.blocks[0] === 1);
    repeated.add(box?.hash as string);
    // The "Overview" unit is in the set too, but its body is not repeated.
    expect(withoutRepeated("", page, repeated).markdown).toBe(`## Overview\n\n${own}`);

    // A repeated block that is most of its page stays.
    const big = await pageBlocks(`Short intro.\n\n${own}`);
    const bigRepeated = new Set([big.units[1]?.hash as string]);
    expect(withoutRepeated("as stored", big, bigRepeated)).toEqual({
      markdown: "as stored",
      dropped: 0,
    });
    // A page whose every block is repeated is kept whole.
    const all = await pageBlocks("First repeated line.\n\nOther repeated line.");
    expect(withoutRepeated("as stored", all, new Set(all.hashes)).dropped).toBe(0);
  });
});

// Each test imports and indexes several pages, some more than once, through
// D1 and R2; on a loaded host that takes longer than the default 5 seconds.
/**
 * `env.DB`, running `after` once a statement matching `sql` has returned
 * its rows: another worker's writes landing between this one's read and
 * its next statement.
 */
function interleavedDb(sql: RegExp, after: () => Promise<void>): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!sql.test(query)) return statement;
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async all<T>() {
                  const rows = await bound.all<T>();
                  await after();
                  return rows;
                },
              };
            },
          };
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("repeated blocks across a source's pages", { timeout: 60_000 }, () => {
  let site: Awaited<ReturnType<typeof seedSite>>;
  let tenant: Tenant;
  let embedCalls: number;
  let embedder: Embedder;
  const retriever = memoryRetriever();

  beforeEach(async () => {
    site = await seedSite();
    tenant = site.tenant;
    embedCalls = 0;
    const inner = tokenEmbedder();
    embedder = {
      dimensions: inner.dimensions,
      async embed(texts, onBilled) {
        embedCalls += texts.length;
        return inner.embed(texts, onBilled);
      },
    };
  });

  async function push(
    pages: readonly Page[],
    options: { tenant?: Tenant; assistantId?: string; sourceId?: string; orgId?: string } = {},
  ): Promise<IngestQueueMessage[]> {
    const queue = capturingQueue();
    await pushDocuments(
      { tenant: options.tenant ?? tenant, docs: env.DOCS, queue },
      { orgId: options.orgId ?? TEST_ORG_ID, assistantId: options.assistantId ?? site.assistantId },
      { sourceId: options.sourceId ?? site.sitemapSourceId, documents: toDocuments(pages) },
    );
    return queue.messages;
  }

  async function importPages(pages: readonly Page[], batchSize = 4) {
    const messages = await push(pages);
    return drainConsumer(messages, { embedder, retriever }, batchSize);
  }

  it("leaves a div-only site's prose footer, cookie notice and related rail out, and keeps each page's own text", async () => {
    const pages = sitePages();
    // The markup rules of #123 keep all of it.
    const { markdown } = extractHtml(pages[0]?.html as string, "https://docs.example.com/p");
    for (const chrome of CHROME) expect(markdown).toContain(chrome);

    expect(await importPages(pages)).toMatchObject({ retried: 0 });
    const text = await indexedText(site.sitemapSourceId);
    expect(text.size).toBe(pages.length);
    pages.forEach((page, i) => {
      const indexed = text.get(page.externalId) ?? "";
      for (const chrome of CHROME) expect(indexed).not.toContain(chrome);
      const [, own] = TOPICS[i] as readonly [string, string];
      expect(indexed).toContain(own);
      expect(indexed).toContain(`step ${i} of the guide`);
      // "Overview" is on every page, over a different body each time.
      expect(indexed).toContain("Overview");
      expect(indexed).toContain(`This page covers ${page.title.toLowerCase()}`);
    });
    // Nothing of the text is stored but the documents' own bodies.
    const stored = await env.DB.prepare(
      "SELECT block_hash FROM document_blocks UNION ALL SELECT repeated_blocks FROM sources",
    ).all<{ block_hash: string }>();
    expect(JSON.stringify(stored.results)).not.toMatch(/cookies|Harbour/);
    for (const row of await env.DB.prepare("SELECT block_hash FROM document_blocks")
      .all<{
        block_hash: string;
      }>()
      .then((r) => r.results)) {
      expect(row.block_hash).toMatch(/^[bh][0-9a-f]{16}$/);
    }
  });

  it("keeps a block that is on 2 of 40 pages", async () => {
    const pages = sitePages(40).map((page, i) =>
      i === 3 || i === 30
        ? {
            ...page,
            html: page.html.replace(
              "</h1>",
              "</h1><p>Shared note: this setting needs the Business plan or above.</p>",
            ),
          }
        : page,
    );
    await importPages(pages, 10);
    const text = await indexedText(site.sitemapSourceId);
    expect(text.get("page-3")).toContain("Shared note: this setting needs the Business plan");
    expect(text.get("page-30")).toContain("Shared note: this setting needs the Business plan");
    expect(text.get("page-12")).not.toContain(COOKIE);
  });

  it("leaves a source of 3 pages untouched", async () => {
    await importPages(sitePages(3));
    const text = await indexedText(site.sitemapSourceId);
    expect(text.size).toBe(3);
    for (const indexed of text.values()) {
      for (const chrome of CHROME) expect(indexed).toContain(chrome);
    }
  });

  it("keeps the repeated block on a page that is mostly that block", async () => {
    const contact: Page = {
      externalId: "contact",
      title: "Contact",
      html: `<html><head><title>Contact</title></head><body><div><h1>Contact</h1><p>Write to us.</p><p>${FOOTER}</p></div></body></html>`,
    };
    await importPages([...sitePages(), contact]);
    const text = await indexedText(site.sitemapSourceId);
    expect(text.get("contact")).toContain(FOOTER);
    expect(text.get("page-0")).not.toContain(FOOTER);
  });

  /** The source's indexed text after importing every page in one go, in order. */
  async function importedInOrder(pages: readonly Page[]): Promise<Map<string, string>> {
    await importPages(pages);
    const inOrder = await indexedText(site.sitemapSourceId);
    site = await seedSite();
    tenant = site.tenant;
    return inOrder;
  }

  it("cleans the early pages once a block crosses the threshold, ending as an import in order would", async () => {
    const pages = sitePages();
    const inOrder = await importedInOrder(pages);
    // Reversed, one page per import: the first four are indexed with the
    // chrome (the source is too small), then the fifth page brings the count
    // to the threshold and they are cleaned.
    const reversed = [...pages].reverse();
    for (const [i, page] of reversed.entries()) {
      await importPages([page], 1);
      const text = await indexedText(site.sitemapSourceId);
      if (i < REPEATED_MIN_SOURCE_PAGES - 1) {
        expect(text.get(page.externalId)).toContain(COOKIE);
      } else {
        for (const indexed of text.values()) expect(indexed).not.toContain(COOKIE);
      }
    }
    expect(await indexedText(site.sitemapSourceId)).toEqual(inOrder);
  });

  it("gives the same result in a shuffled order, in batches", async () => {
    const pages = sitePages();
    const inOrder = await importedInOrder(pages);
    const shuffled = [5, 2, 7, 0, 6, 1, 3, 4].map((i) => pages[i] as Page);
    for (let i = 0; i < shuffled.length; i += 3) {
      await importPages(shuffled.slice(i, i + 3), 1);
    }
    expect(await indexedText(site.sitemapSourceId)).toEqual(inOrder);
  });

  it("re-embeds only pages whose chunks changed, and each of those once", async () => {
    const pages = sitePages();
    await importPages(pages.slice(0, 4), 1);
    const before = embedCalls;
    await importPages(pages.slice(4, 5), 1);
    // The fifth page, and the four before it once more, cleaned.
    expect(await tenant.documents.listBySource(site.sitemapSourceId)).toHaveLength(5);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM documents WHERE source_id = ?1 AND repeated_key <> ''",
    )
      .bind(site.sitemapSourceId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(5);
    expect(embedCalls - before).toBeGreaterThan(0);

    // Pushing the same pages again changes nothing and embeds nothing.
    const after = embedCalls;
    await importPages(pages.slice(0, 5), 1);
    expect(embedCalls).toBe(after);
  });

  it("gives the blocks back when removals take the source under the threshold", async () => {
    await importPages(sitePages(6));
    expect((await indexedText(site.sitemapSourceId)).get("page-0")).not.toContain(COOKIE);

    const queue = capturingQueue();
    await deleteDocuments(
      {
        tenant,
        docs: env.DOCS,
        retriever,
        repeated: {
          queue: {
            async sendBatch(batch: Array<{ body: IngestQueueMessage }>) {
              queue.messages.push(...batch.map((m) => m.body));
            },
          },
          orgId: TEST_ORG_ID,
        },
      },
      { orgId: TEST_ORG_ID, assistantId: site.assistantId },
      { sourceId: site.sitemapSourceId, externalIds: ["page-4", "page-5"] },
    );
    expect(queue.messages).toHaveLength(4);
    await drainConsumer(queue.messages, { embedder, retriever });
    // Four pages: the same as a source that only ever had these four.
    const text = await indexedText(site.sitemapSourceId);
    expect(text.size).toBe(4);
    for (const indexed of text.values()) expect(indexed).toContain(COOKIE);
  });

  /** A queue whose first `failures` sends throw before anything is delivered. */
  function flakyQueue(failures: number) {
    const messages: Array<IngestQueueMessage | RepeatedSourceMessage> = [];
    let left = failures;
    return {
      messages,
      async sendBatch(batch: Array<{ body: IngestQueueMessage | RepeatedSourceMessage }>) {
        if (left > 0) {
          left--;
          throw new Error("queue unavailable");
        }
        messages.push(...batch.map((m) => m.body));
      },
    };
  }

  /** Delivers messages once to the consumer with `queue` wired in. */
  async function deliverOnce(
    messages: Array<IngestQueueMessage | RepeatedSourceMessage>,
    queue: RepeatedQueue,
    attempts = 1,
    db: D1Database = env.DB,
  ): Promise<{ acked: number; retried: number }> {
    let acked = 0;
    let retried = 0;
    await runIngestBatch(
      {
        messages: messages.splice(0).map((body) => ({
          id: newId("msg"),
          timestamp: new Date(),
          attempts,
          body,
          ack() {
            acked++;
          },
          retry() {
            retried++;
          },
        })),
      },
      { db, resolveOrg: acceptQueuedOrg, docs: env.DOCS, embedder, retriever, queue },
    );
    return { acked, retried };
  }

  async function pending(sourceId: string): Promise<string[]> {
    return (await tenant.blocks.stored(sourceId))?.pending ?? [];
  }

  it("still cleans the earlier pages when queuing them fails after the change is stored", async () => {
    const pages = sitePages(6);
    await importPages(pages.slice(0, 4), 1);
    // The fifth page makes the chrome repeated; sending the four earlier
    // pages to be cleaned fails after the new set is stored.
    const fifth = await push(pages.slice(4, 5));
    expect(await deliverOnce(fifth, flakyQueue(1))).toEqual({ acked: 0, retried: 1 });
    expect((await tenant.blocks.stored(site.sitemapSourceId))?.hashes.length).toBeGreaterThan(0);
    expect(await pending(site.sitemapSourceId)).not.toEqual([]);
    expect((await indexedText(site.sitemapSourceId)).get("page-0")).toContain(COOKIE);

    // A sixth page leaves the set as it is, and still brings the four in.
    await importPages(pages.slice(5, 6), 1);
    const text = await indexedText(site.sitemapSourceId);
    expect(text.size).toBe(6);
    for (const indexed of text.values()) expect(indexed).not.toContain(COOKIE);
    expect(await pending(site.sitemapSourceId)).toEqual([]);
  });

  it("cleans the earlier pages when the failed message is retried", async () => {
    const pages = sitePages(5);
    await importPages(pages.slice(0, 4), 1);
    const fifth = await push(pages.slice(4, 5));
    const retry = [...fifth];
    expect(await deliverOnce(fifth, flakyQueue(1))).toEqual({ acked: 0, retried: 1 });

    // The retry finds its own page current, and reconciles anyway.
    const queue = capturingQueue();
    expect(await deliverOnce(retry, queue, 2)).toEqual({ acked: 1, retried: 0 });
    // The five pages holding the chrome; the fifth is then acknowledged.
    expect(queue.messages).toHaveLength(5);
    await drainConsumer(queue.messages, { embedder, retriever });
    for (const indexed of (await indexedText(site.sitemapSourceId)).values()) {
      expect(indexed).not.toContain(COOKIE);
    }
    expect(await pending(site.sitemapSourceId)).toEqual([]);
  });

  async function owedRemovals(sourceId: string): Promise<number> {
    return (await tenant.blocks.stored(sourceId))?.owed ?? 0;
  }

  /** `tenant`, with its repeated-block counting failing for the next `failures` calls. */
  function failingCompute(failures: number): Tenant {
    let left = failures;
    return {
      ...tenant,
      blocks: {
        ...tenant.blocks,
        async compute(sourceId: string) {
          if (left > 0) {
            left--;
            throw new Error("D1 unavailable");
          }
          return tenant.blocks.compute(sourceId);
        },
      },
    };
  }

  async function removePages(
    externalIds: string[],
    queue: RepeatedQueue,
    on: Tenant = tenant,
  ): Promise<{ deleted: number }> {
    return deleteDocuments(
      { tenant: on, docs: env.DOCS, retriever, repeated: { queue, orgId: TEST_ORG_ID } },
      { orgId: TEST_ORG_ID, assistantId: site.assistantId },
      { sourceId: site.sitemapSourceId, externalIds },
    );
  }

  async function expectBlocksGivenBack() {
    const text = await indexedText(site.sitemapSourceId);
    expect(text.size).toBe(4);
    for (const indexed of text.values()) expect(indexed).toContain(COOKIE);
    expect(await pending(site.sitemapSourceId)).toEqual([]);
    expect(await owedRemovals(site.sitemapSourceId)).toBe(0);
  }

  it("clears what a removal owes once it has reconciled", async () => {
    await importPages(sitePages(6));
    const queue = capturingQueue();
    await removePages(["page-4", "page-5"], queue);
    expect(queue.messages).toHaveLength(4);
    expect(await owedRemovals(site.sitemapSourceId)).toBe(0);
  });

  it("gives the blocks back after a removal whose queuing failed, on its own", async () => {
    await importPages(sitePages(6));
    const queue = flakyQueue(1);
    expect(await removePages(["page-4", "page-5"], queue)).toMatchObject({ deleted: 2 });
    expect((await tenant.blocks.stored(site.sitemapSourceId))?.hashes).toEqual([]);
    expect(await pending(site.sitemapSourceId)).not.toEqual([]);
    expect(await owedRemovals(site.sitemapSourceId)).toBe(1);

    // The removal queued the source itself: no other activity is needed.
    expect(queue.messages).toEqual([
      { kind: "repeated_source", orgId: TEST_ORG_ID, sourceId: site.sitemapSourceId },
    ]);
    await drainConsumer(queue.messages, { embedder, retriever });
    await expectBlocksGivenBack();
  });

  it("gives the blocks back after a removal whose counting failed before anything was stored", async () => {
    await importPages(sitePages(6));
    const queue = capturingQueue();
    const scheduled: Array<IngestQueueMessage | RepeatedSourceMessage> = [];
    expect(
      await removePages(
        ["page-4", "page-5"],
        {
          async sendBatch(batch) {
            scheduled.push(...batch.map((m) => m.body));
          },
        },
        failingCompute(1),
      ),
    ).toMatchObject({ deleted: 2 });
    // Nothing changed yet: the set is still the six-page one, nothing pending.
    expect((await tenant.blocks.stored(site.sitemapSourceId))?.hashes).not.toEqual([]);
    expect(await pending(site.sitemapSourceId)).toEqual([]);
    expect(await owedRemovals(site.sitemapSourceId)).toBe(1);
    expect(scheduled).toEqual([
      { kind: "repeated_source", orgId: TEST_ORG_ID, sourceId: site.sitemapSourceId },
    ]);
    expect(queue.messages).toEqual([]);

    await drainConsumer(scheduled, { embedder, retriever });
    await expectBlocksGivenBack();
  });

  it("retries the source's message until its reconciliation runs through", async () => {
    await importPages(sitePages(6));
    const scheduled = capturingQueue();
    await removePages(["page-4", "page-5"], flakyQueue(1));
    const message = {
      kind: "repeated_source",
      orgId: TEST_ORG_ID,
      sourceId: site.sitemapSourceId,
    } as const;

    // Delivered while the counting fails: retried, still owed.
    let acked = 0;
    let retried = 0;
    const delivery = (attempts: number) => ({
      id: newId("msg"),
      timestamp: new Date(),
      attempts,
      body: message,
      ack() {
        acked++;
      },
      retry() {
        retried++;
      },
    });
    await runRepeatedSourceBatch([delivery(1)], {
      tenant: failingCompute(1),
      orgId: TEST_ORG_ID,
      queue: scheduled,
    });
    expect({ acked, retried }).toEqual({ acked: 0, retried: 1 });
    expect(await owedRemovals(site.sitemapSourceId)).toBe(1);

    // The retry runs through and queues the four pages.
    await runRepeatedSourceBatch([delivery(2)], {
      tenant,
      orgId: TEST_ORG_ID,
      queue: scheduled,
    });
    expect({ acked, retried }).toEqual({ acked: 1, retried: 1 });
    expect(scheduled.messages).toHaveLength(4);
    await drainConsumer(scheduled.messages, { embedder, retriever });
    await expectBlocksGivenBack();
  });

  it("fails a removal it could neither reconcile nor queue, and its retry reconciles", async () => {
    await importPages(sitePages(6));
    const down = {
      async sendBatch(): Promise<unknown> {
        throw new Error("queue unavailable");
      },
    };
    await expect(removePages(["page-4", "page-5"], down, failingCompute(1))).rejects.toThrow(
      "queue unavailable",
    );
    // The pages are gone and what they owe is recorded.
    expect((await indexedText(site.sitemapSourceId)).size).toBe(4);
    expect(await owedRemovals(site.sitemapSourceId)).toBe(1);

    // The same request again: nothing is left to remove, and it reconciles.
    const queue = capturingQueue();
    expect(await removePages(["page-4", "page-5"], queue)).toMatchObject({ deleted: 0 });
    expect(queue.messages).toHaveLength(4);
    await drainConsumer(queue.messages, { embedder, retriever });
    await expectBlocksGivenBack();
  });

  it("never touches written answers", async () => {
    await importPages(sitePages());
    const queue = capturingQueue();
    for (let i = 0; i < 6; i++) {
      await saveEntry(
        { tenant, docs: env.DOCS, queue, publicBaseUrl: "https://solv.example" },
        { orgId: TEST_ORG_ID },
        {
          assistantId: site.assistantId,
          question: `Question ${i}?`,
          answer: `Answer ${i}.\n\n${COOKIE}`,
        },
      );
    }
    await drainConsumer(queue.messages, { embedder, retriever });
    const text = await indexedText(site.entrySourceId);
    expect(text.size).toBe(6);
    for (const indexed of text.values()) expect(indexed).toContain(COOKIE);
    const blocks = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM document_blocks WHERE source_id = ?1",
    )
      .bind(site.entrySourceId)
      .first<{ n: number }>();
    expect(blocks?.n).toBe(0);
  });

  it("never counts across sources, assistants or organisations", async () => {
    // Four pages in each of four places: eight, twelve, sixteen pages share
    // the chrome, but no one source reaches five.
    const OTHER_ORG = "org_11111111111111111111";
    await env.DB.prepare(
      "INSERT INTO orgs (id, name) VALUES (?1, 'Other') ON CONFLICT(id) DO NOTHING",
    )
      .bind(OTHER_ORG)
      .run();
    const otherOrg = forPrincipal(env.DB, { orgId: OTHER_ORG, userId: "usr_2", role: "owner" });
    const makeAssistant = async (t: Tenant) => {
      const id = newId("ast");
      await t.assistants.create({
        id,
        name: "other",
        publicKey: `pk_${newId("ast").slice(4)}`,
        allowedOrigins: [],
        createdAt: 1000,
      });
      const sourceId = newId("src");
      await t.sources.create({
        id: sourceId,
        assistantId: id,
        kind: "sitemap",
        label: "Docs",
        settings: { url: "https://docs.example.com/sitemap.xml" },
        createdAt: 1000,
      });
      return { assistantId: id, sourceId };
    };
    const secondSource = newId("src");
    await tenant.sources.create({
      id: secondSource,
      assistantId: site.assistantId,
      kind: "sitemap",
      label: "Blog",
      settings: { url: "https://docs.example.com/blog.xml" },
      createdAt: 1000,
    });
    const otherAssistant = await makeAssistant(tenant);
    const foreign = await makeAssistant(otherOrg);
    const pages = sitePages(4);
    const messages = [
      ...(await push(pages)),
      ...(await push(pages, { sourceId: secondSource })),
      ...(await push(pages, otherAssistant)),
      ...(await push(pages, { tenant: otherOrg, orgId: OTHER_ORG, ...foreign })),
    ];
    await drainConsumer(messages, { embedder, retriever });

    for (const sourceId of [
      site.sitemapSourceId,
      secondSource,
      otherAssistant.sourceId,
      foreign.sourceId,
    ]) {
      const text = await indexedText(sourceId);
      expect(text.size).toBe(4);
      for (const indexed of text.values()) expect(indexed).toContain(COOKIE);
      const most = await env.DB.prepare(
        "SELECT MAX(pages) AS pages FROM source_blocks WHERE source_id = ?1",
      )
        .bind(sourceId)
        .first<{ pages: number }>();
      expect(most?.pages).toBe(4);
    }
  });

  it("shows on Sources how many blocks were left out, with the first 80 characters of each", async () => {
    await importPages(sitePages());
    const listed = await listSources(tenant, site.assistantId);
    const sitemap = listed.find((s) => s.id === site.sitemapSourceId);
    expect(sitemap?.repeatedBlockCount).toBe(4);
    expect(listed.find((s) => s.id === site.entrySourceId)?.repeatedBlockCount).toBe(0);

    const { blocks } = await getRepeatedBlocks(tenant, env.DOCS, site.sitemapSourceId);
    expect(blocks).toHaveLength(4);
    expect(blocks.every((b) => b.pages === 8)).toBe(true);
    expect(blocks.map((b) => b.text).sort()).toEqual(
      [FOOTER, COOKIE, RAIL_ONE, RAIL_TWO].map((t) => t.slice(0, 80)).sort(),
    );
    expect(blocks.find((b) => b.text === COOKIE.slice(0, 80))?.truncated).toBe(true);
    expect(blocks.find((b) => b.text === RAIL_ONE)?.truncated).toBe(false);
  });

  it("brings pages indexed before this version in without embedding them again", async () => {
    // Four pages with no repeated block, as version 2 left them.
    await importPages(sitePages(4));
    await env.DB.prepare(
      "UPDATE documents SET ingest_version = 2, repeated_key = NULL WHERE source_id = ?1",
    )
      .bind(site.sitemapSourceId)
      .run();
    await env.DB.prepare("DELETE FROM document_blocks").run();
    const before = embedCalls;
    const outdated = await tenant.documents.listOutdated(site.assistantId, INGEST_VERSION, 100);
    expect(outdated).toHaveLength(4);
    await drainConsumer(
      outdated.map((doc) => ({
        orgId: TEST_ORG_ID,
        documentId: doc.id,
        contentHash: doc.contentHash,
      })),
      { embedder, retriever },
    );
    expect(embedCalls).toBe(before);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM documents WHERE source_id = ?1 AND ingest_version = ?2 AND repeated_key = ''",
    )
      .bind(site.sitemapSourceId, INGEST_VERSION)
      .first<{ n: number }>();
    expect(rows?.n).toBe(4);
  });
  it("does not keep chunks another build replaced after they were compared", async () => {
    // Four pages with no repeated block, as version 2 left them.
    await importPages(sitePages(4));
    await env.DB.prepare(
      "UPDATE documents SET ingest_version = 2, repeated_key = NULL WHERE source_id = ?1",
    )
      .bind(site.sitemapSourceId)
      .run();
    await env.DB.prepare("DELETE FROM document_blocks").run();
    const [doc] = await tenant.documents.listBySource(site.sitemapSourceId);
    if (doc === undefined) throw new Error("no document");
    const before = (await indexedText(site.sitemapSourceId)).get(doc.externalId);

    // Another build, made while a block of this page was repeated, commits
    // its chunks right after this build compared the stored ones.
    const other = { id: newId("chk"), ordinal: 0, text: "Only what was left.", headingPath: "" };
    let interleaved = false;
    const db = interleavedDb(
      /FROM chunks WHERE org_id = \?1 AND document_id = \?2 ORDER BY ordinal/,
      async () => {
        if (interleaved) return;
        interleaved = true;
        expect(
          await tenant.documents.replaceChunks(doc.id, [other], doc.contentHash, INGEST_VERSION, {
            blocks: {
              sourceId: site.sitemapSourceId,
              hashes: ["b0123456789abcdef"],
              key: "kother",
            },
          }),
        ).toBe(true);
      },
    );
    const message = { orgId: TEST_ORG_ID, documentId: doc.id, contentHash: doc.contentHash };
    const queue = capturingQueue();
    // Its chunks match what is stored when compared, but not when it commits:
    // refused and retried, and the other build's state is left as it was.
    expect(await deliverOnce([message], queue, 1, db)).toEqual({ acked: 0, retried: 1 });
    expect(interleaved).toBe(true);
    const after = await tenant.documents.get(doc.id);
    expect(after?.repeatedKey).toBe("kother");
    expect((await tenant.documents.listChunks(doc.id)).map((c) => c.id)).toEqual([other.id]);

    // The retry finds the page built with a set the source no longer has,
    // and rebuilds it: its text is back.
    expect(await deliverOnce([message], queue, 2)).toEqual({ acked: 1, retried: 0 });
    expect((await indexedText(site.sitemapSourceId)).get(doc.externalId)).toBe(before);
    expect((await tenant.documents.get(doc.id))?.repeatedKey).toBe("");
  });
});
