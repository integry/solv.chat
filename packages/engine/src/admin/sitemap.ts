import { newId } from "@solvchat/core";
import type { SourceRow } from "../db/sources.js";
import { type PushDeps, pushDocuments } from "../ingest/documents.js";
import { decodeXmlEntities } from "../ingest/htmlToMarkdown.js";
import {
  MAX_PAGE_BYTES,
  MAX_PAGE_REDIRECTS,
  PAGE_FETCH_TIMEOUT_MS,
  plainPageFetcher,
} from "../ingest/pageFetcher.js";
import type { PageFetcher } from "../seams/types.js";
import {
  assertPublicHttpsUrl,
  fetchCapped,
  type HostResolver,
  UnsafeUrlError,
} from "../security/urlGuard.js";
import { sha256Hex } from "../util/crypto.js";
import { BadRequest, NotFound } from "./errors.js";

async function hashUrlExternalId(normalizedUrl: string): Promise<string> {
  return `sitemap:${await sha256Hex(normalizedUrl)}`;
}

// Caps chosen because the spec gives none for this path: a sitemap larger than
// this is not a small site's index, and the budgets stop one import from
// occupying the Worker.
export const MAX_SITEMAP_BYTES = 2 * 1024 * 1024;
// Pages are fetched through the page-fetcher seam; its caps apply to them.
export { MAX_PAGE_BYTES };
export const MAX_REDIRECTS = MAX_PAGE_REDIRECTS;
export const MAX_URLS = 500;
// Pages per import request, not per import: the admin sends a larger
// selection in batches of this size. Each page costs about six subrequests
// (two DNS-over-HTTPS lookups, the fetch, the R2 put, the queue send, D1), and
// Workers Free allows "50/request" (Paid: "10,000/request"), so five pages
// leave room for redirects and the fixed lookups.
// Source: https://developers.cloudflare.com/workers/platform/limits/ — checked 2026-11-14
export const MAX_IMPORT_URLS = 5;
export const FETCH_TIMEOUT_MS = PAGE_FETCH_TIMEOUT_MS;

function extractLocs(xml: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const locRe = /<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi;

  for (const match of xml.matchAll(locRe)) {
    let raw = (match[1] ?? "").trim();
    const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
    if (cdata?.[1] !== undefined) {
      raw = cdata[1].trim();
    } else {
      raw = decodeXmlEntities(raw);
    }
    if (!raw) continue;

    try {
      const safe = assertPublicHttpsUrl(raw);
      if (!seen.has(safe.href)) {
        seen.add(safe.href);
        urls.push(safe.href);
        if (urls.length >= MAX_URLS) break;
      }
    } catch {
      // Skip non-https or private URLs listed in a sitemap.
    }
  }

  return urls;
}

/**
 * Fetches a sitemap and returns the public https URLs it lists.
 *
 * The guards are the specification's rules for MCP server URLs — https only,
 * never a private or loopback address — applied here because the hazard is the
 * same: an owner-supplied URL fetched with the Worker's own network position.
 */
export interface SitemapFetchOptions {
  timeoutMs?: number | undefined;
  resolveHost?: HostResolver | undefined;
}

export async function previewSitemap(
  url: string,
  fetchImpl: typeof fetch = fetch,
  options?: SitemapFetchOptions,
): Promise<string[]> {
  const target = assertPublicHttpsUrl(url);
  // Redirects are followed manually so each hop is checked: `redirect: "follow"`
  // would let a public URL redirect to a link-local metadata address.
  const { body: xml } = await fetchCapped(target, fetchImpl, {
    maxRedirects: MAX_REDIRECTS,
    timeoutMs: options?.timeoutMs ?? FETCH_TIMEOUT_MS,
    maxBytes: MAX_SITEMAP_BYTES,
    accept: "application/xml, text/xml, */*",
    resolveHost: options?.resolveHost,
  });
  // A deliberately small extractor rather than an XML parser dependency: we
  // need <loc> values, and anything else in the document is not our business.
  return extractLocs(xml);
}

export interface SitemapImportInput {
  sitemapUrl?: string;
  urls: string[];
  label?: string;
  sourceId?: string;
}

export interface SitemapImportResult {
  source: SourceRow;
  written: number;
  unchanged: number;
  total: number;
  /** Chosen URLs that answered with something other than a page or text, such as a PDF. Not written. */
  skipped: number;
}

/**
 * Fetches the chosen URLs once, converts them to Markdown, and writes them
 * through `pushDocuments` so they are hashed, stored in R2, and enqueued for
 * chunking and embedding via the same consumer as pushed content.
 *
 * Every page goes through the page-fetcher seam (`plainPageFetcher` unless the
 * host passed its own). A page with no text is written as its title alone, as
 * the import always has; a response that is not a page at all is skipped.
 */
export async function importSitemapUrls(
  deps: PushDeps,
  scope: { orgId: string; assistantId: string },
  input: SitemapImportInput,
  pages: PageFetcher = plainPageFetcher(),
): Promise<SitemapImportResult> {
  const assistant = await deps.tenant.assistants.get(scope.assistantId);
  if (assistant === null) throw new NotFound("assistant");

  if (!Array.isArray(input.urls) || input.urls.length === 0) {
    throw new BadRequest(["urls: choose at least one URL to import"]);
  }
  if (input.urls.length > MAX_IMPORT_URLS) {
    throw new BadRequest([`urls: import at most ${MAX_IMPORT_URLS} URLs per request`]);
  }

  const dedupedUrls: URL[] = [];
  const seen = new Set<string>();
  for (const raw of input.urls) {
    if (typeof raw !== "string") {
      throw new BadRequest(["urls: every item must be a URL string"]);
    }
    const safe = assertPublicHttpsUrl(raw);
    if (!seen.has(safe.href)) {
      seen.add(safe.href);
      dedupedUrls.push(safe);
    }
  }

  const safeSitemapUrl =
    input.sitemapUrl !== undefined && input.sitemapUrl.trim() !== ""
      ? assertPublicHttpsUrl(input.sitemapUrl)
      : dedupedUrls[0];

  if (!safeSitemapUrl) {
    throw new BadRequest(["urls: choose at least one URL to import"]);
  }

  let source: SourceRow;
  if (input.sourceId !== undefined) {
    const existing = await deps.tenant.sources.get(input.sourceId);
    if (existing === null || existing.assistantId !== scope.assistantId) {
      throw new NotFound("source");
    }
    if (existing.kind !== "sitemap") {
      throw new BadRequest(["source: sitemap import requires a sitemap source"]);
    }
    source = existing;
  } else {
    const label =
      typeof input.label === "string" && input.label.trim().length > 0
        ? input.label.trim().slice(0, 80)
        : safeSitemapUrl.hostname;
    source = await deps.tenant.sources.create({
      id: newId("src"),
      assistantId: scope.assistantId,
      kind: "sitemap",
      label,
      settings: { url: safeSitemapUrl.href },
      createdAt: Date.now(),
    });
  }

  const documents: Array<{
    externalId: string;
    url: string;
    title: string;
    markdown: string;
  }> = [];

  let skipped = 0;
  for (const pageUrl of dedupedUrls) {
    const page = await pages.fetchPage(pageUrl.href);
    let title: string;
    let markdown: string;
    if (page.kind === "page") {
      ({ title, markdown } = page);
    } else if (page.kind === "no_content" && page.reason === "empty") {
      // Kept from before the seam existed: re-importing a page that lost its
      // text replaces the old copy rather than leaving it searchable.
      title = page.title ?? pageUrl.pathname;
      markdown = `# ${title}`;
    } else {
      // `not_html`; `not_modified` cannot happen, as no validators were sent.
      skipped++;
      continue;
    }

    documents.push({
      externalId: await hashUrlExternalId(pageUrl.href),
      url: pageUrl.href,
      title,
      markdown,
    });
  }

  const counts =
    documents.length > 0
      ? await pushDocuments(deps, scope, { sourceId: source.id, documents })
      : { written: 0, unchanged: 0 };

  return {
    source,
    written: counts.written,
    unchanged: counts.unchanged,
    total: documents.length,
    skipped,
  };
}

export { UnsafeUrlError };
