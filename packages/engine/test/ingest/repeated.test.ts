import { env } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { saveEntry } from "../../src/admin/entries.js";
import { getRepeatedBlocks, listSources } from "../../src/admin/sources.js";
import { forPrincipal, type Tenant } from "../../src/db/tenant.js";
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
import { INGEST_VERSION } from "../../src/ingest/version.js";
import type { Embedder } from "../../src/providers/retrieval.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { tokenEmbedder } from "../fakes/tokenEmbedder.js";
import { TEST_ORG_ID } from "../helpers/app.js";
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
});
