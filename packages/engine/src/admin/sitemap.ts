import { MAX_DOCUMENT_MARKDOWN_BYTES, newId } from "@solvchat/core";
import type { SourceRow } from "../db/sources.js";
import { type PushDeps, pushDocuments } from "../ingest/documents.js";
import {
  assertPublicHttpsUrl,
  fetchCapped,
  type HostResolver,
  UnsafeUrlError,
} from "../security/urlGuard.js";
import { BadRequest, NotFound } from "./errors.js";

const textEncoder = new TextEncoder();

async function hashUrlExternalId(normalizedUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(normalizedUrl));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `sitemap:${hex}`;
}

// Caps chosen because the spec gives none for this path: a sitemap larger than
// this is not a small site's index, and the budgets stop one import from
// occupying the Worker.
export const MAX_SITEMAP_BYTES = 2 * 1024 * 1024;
export const MAX_PAGE_BYTES = MAX_DOCUMENT_MARKDOWN_BYTES;
export const MAX_REDIRECTS = 3;
export const MAX_URLS = 500;
export const MAX_IMPORT_URLS = 100;
export const FETCH_TIMEOUT_MS = 10_000;

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

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

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToTitleAndMarkdown(
  html: string,
  fallbackUrl: string,
): {
  title: string;
  markdown: string;
} {
  const titleMatch = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(html);
  const rawTitle = titleMatch?.[1] ? decodeXmlEntities(stripTags(titleMatch[1])) : "";
  const title = (rawTitle || new URL(fallbackUrl).pathname || fallbackUrl).slice(0, 300);

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "\n")
    .replace(/<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
      const hashes = "#".repeat(Number(level));
      return `\n\n${hashes} ${stripTags(inner)}\n\n`;
    })
    .replace(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${stripTags(inner)}`)
    .replace(/<(?:p|div|section|article|br|tr|blockquote)(?:\s[^>]*)?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|blockquote)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");

  text = decodeXmlEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!text) {
    text = `# ${title}`;
  }

  return { title, markdown: text };
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
}

/**
 * Fetches the chosen URLs once, converts them to Markdown, and writes them
 * through `pushDocuments` so they are hashed, stored in R2, and enqueued for
 * chunking and embedding via the same consumer as pushed content.
 */
export async function importSitemapUrls(
  deps: PushDeps,
  scope: { orgId: string; assistantId: string },
  input: SitemapImportInput,
  fetchImpl: typeof fetch = fetch,
  options?: SitemapFetchOptions,
): Promise<SitemapImportResult> {
  const assistant = await deps.tenant.assistants.get(scope.assistantId);
  if (assistant === null) throw new NotFound("assistant");

  if (!Array.isArray(input.urls) || input.urls.length === 0) {
    throw new BadRequest(["urls: choose at least one URL to import"]);
  }
  if (input.urls.length > MAX_IMPORT_URLS) {
    throw new BadRequest([`urls: import at most ${MAX_IMPORT_URLS} URLs at once`]);
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

  for (const pageUrl of dedupedUrls) {
    const { response, body } = await fetchCapped(pageUrl, fetchImpl, {
      maxRedirects: MAX_REDIRECTS,
      timeoutMs: options?.timeoutMs ?? FETCH_TIMEOUT_MS,
      maxBytes: MAX_PAGE_BYTES,
      accept: "text/html, text/markdown, text/plain, */*",
      resolveHost: options?.resolveHost,
    });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

    let title: string;
    let markdown: string;
    if (contentType.includes("text/markdown") || contentType.includes("text/plain")) {
      title = (new URL(pageUrl.href).pathname || pageUrl.hostname).slice(0, 300);
      markdown = body.trim() || `# ${title}`;
    } else {
      ({ title, markdown } = htmlToTitleAndMarkdown(body, pageUrl.href));
    }

    documents.push({
      externalId: await hashUrlExternalId(pageUrl.href),
      url: pageUrl.href,
      title,
      markdown,
    });
  }

  const counts = await pushDocuments(deps, scope, {
    sourceId: source.id,
    documents,
  });

  return {
    source,
    written: counts.written,
    unchanged: counts.unchanged,
    total: documents.length,
  };
}

export { UnsafeUrlError };
