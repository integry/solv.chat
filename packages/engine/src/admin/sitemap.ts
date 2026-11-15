import { MAX_DOCUMENT_MARKDOWN_BYTES, newId } from "@solvchat/core";
import type { SourceRow } from "../db/sources.js";
import { type PushDeps, pushDocuments } from "../ingest/documents.js";
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
export const MAX_PAGE_BYTES = MAX_DOCUMENT_MARKDOWN_BYTES;
export const MAX_REDIRECTS = 3;
export const MAX_URLS = 500;
// Pages per import request, not per import: the admin sends a larger
// selection in batches of this size. Each page costs about six subrequests
// (two DNS-over-HTTPS lookups, the fetch, the R2 put, the queue send, D1), and
// Workers Free allows "50/request" (Paid: "10,000/request"), so five pages
// leave room for redirects and the fixed lookups.
// Source: https://developers.cloudflare.com/workers/platform/limits/ — checked 2026-11-14
export const MAX_IMPORT_URLS = 5;
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

/**
 * Calls `onTag` for each `<...>` tag and `onText` for the text between them.
 * One left-to-right pass with `indexOf`: the page is up to 1 MiB of
 * owner-chosen HTML, and a regex such as `<[^>]+>` rescans to the end of the
 * input from every `<` that has no `>` after it, which is quadratic. Once no
 * `>` remains, the rest is text, as the regex would have left it.
 */
function scanTags(
  html: string,
  onText: (text: string) => void,
  onTag: (tag: string) => void,
): void {
  let pos = 0;
  while (pos < html.length) {
    const open = html.indexOf("<", pos);
    if (open === -1) break;
    const close = html.indexOf(">", open + 1);
    if (close === -1) break;
    if (close === open + 1) {
      // `<>` is not a tag; the old regex needed one character in between.
      onText(html.slice(pos, close + 1));
      pos = close + 1;
      continue;
    }
    onText(html.slice(pos, open));
    onTag(html.slice(open + 1, close));
    pos = close + 1;
  }
  onText(html.slice(pos));
}

function stripTags(html: string): string {
  const parts: string[] = [];
  scanTags(
    html,
    (text) => parts.push(text),
    () => parts.push(" "),
  );
  return parts.join("").replace(/\s+/g, " ").trim();
}

function isTagBoundary(char: string | undefined): boolean {
  return char === undefined || char === ">" || /\s/.test(char);
}

/**
 * Replaces every `<name ...>inner</name>` with `render(inner)`, matching the
 * first close after each open, as a lazy regex would. Linear: when an open
 * has no close after it, no later open has one either, so the scan stops.
 */
function replaceElements(
  html: string,
  name: string,
  render: (inner: string) => string,
  limit = Number.POSITIVE_INFINITY,
): string {
  const lower = html.toLowerCase();
  const openMarker = `<${name}`;
  const closeMarker = `</${name}>`;
  const out: string[] = [];
  let pos = 0;
  let search = 0;
  let replaced = 0;
  while (replaced < limit) {
    const open = lower.indexOf(openMarker, search);
    if (open === -1) break;
    if (!isTagBoundary(lower[open + openMarker.length])) {
      search = open + openMarker.length;
      continue;
    }
    const openEnd = lower.indexOf(">", open + openMarker.length);
    if (openEnd === -1) break;
    const close = lower.indexOf(closeMarker, openEnd + 1);
    if (close === -1) break;
    out.push(html.slice(pos, open), render(html.slice(openEnd + 1, close)));
    pos = close + closeMarker.length;
    search = pos;
    replaced++;
  }
  out.push(html.slice(pos));
  return out.join("");
}

function firstElementInner(html: string, name: string): string | null {
  let inner: string | null = null;
  replaceElements(
    html,
    name,
    (found) => {
      inner = found;
      return "";
    },
    1,
  );
  return inner;
}

const BLOCK_OPEN = new Set(["p", "div", "section", "article", "br", "tr", "blockquote"]);
const BLOCK_CLOSE = new Set(["p", "div", "section", "article", "blockquote"]);

function tagName(tag: string): string {
  const match = /^\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
  return match?.[1]?.toLowerCase() ?? "";
}

function trimTrailingBlanks(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return line.slice(0, end);
}

/** Converts a fetched page to a title and plain Markdown without backtracking regexes. */
export function htmlToTitleAndMarkdown(
  html: string,
  fallbackUrl: string,
): {
  title: string;
  markdown: string;
} {
  const titleInner = firstElementInner(html, "title");
  const rawTitle = titleInner ? decodeXmlEntities(stripTags(titleInner)) : "";
  const title = (rawTitle || new URL(fallbackUrl).pathname || fallbackUrl).slice(0, 300);

  let text = html;
  // `title` is the document's title already; left in, its text would also
  // open the body.
  for (const name of ["script", "style", "noscript", "title"]) {
    text = replaceElements(text, name, () => "\n");
  }
  for (let level = 1; level <= 6; level++) {
    text = replaceElements(
      text,
      `h${level}`,
      (inner) => `\n\n${"#".repeat(level)} ${stripTags(inner)}\n\n`,
    );
  }
  text = replaceElements(text, "li", (inner) => `\n- ${stripTags(inner)}`);

  const parts: string[] = [];
  scanTags(
    text,
    (chunk) => parts.push(chunk),
    (tag) => {
      const name = tagName(tag);
      if (tag.startsWith("/")) {
        if (BLOCK_CLOSE.has(name)) parts.push("\n\n");
      } else if (BLOCK_OPEN.has(name) && isTagBoundary(tag[name.length] ?? ">")) {
        parts.push("\n");
      }
    },
  );

  text = decodeXmlEntities(parts.join(""))
    .split("\n")
    .map(trimTrailingBlanks)
    .join("\n")
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
