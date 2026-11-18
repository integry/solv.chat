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

export async function hashUrlExternalId(normalizedUrl: string): Promise<string> {
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

/** A `<loc>` value as the sitemap wrote it, unwrapped and decoded; "" when blank. */
function locValue(inner: string): string {
  const raw = inner.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  if (cdata?.[1] !== undefined) return cdata[1].trim();
  return decodeXmlEntities(raw).trim();
}

/** The URL normalized, or null for a non-https or private URL listed in a sitemap. */
function safeLoc(raw: string): string | null {
  if (!raw) return null;
  try {
    return assertPublicHttpsUrl(raw).href;
  } catch {
    return null;
  }
}

function extractLocs(xml: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const locRe = /<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi;

  for (const match of xml.matchAll(locRe)) {
    const safe = safeLoc(locValue(match[1] ?? ""));
    if (safe !== null && !seen.has(safe)) {
      seen.add(safe);
      urls.push(safe);
      if (urls.length >= MAX_URLS) break;
    }
  }

  return urls;
}

/** One page a sitemap lists, with its `<lastmod>` as written, or null when it has none. */
export interface SitemapEntry {
  url: string;
  lastmod: string | null;
}

export interface SitemapEntries {
  entries: SitemapEntry[];
  /** True when the sitemap listed more pages than `maxUrls`; the rest were not read. */
  truncated: boolean;
  /** True for a sitemap index, which lists other sitemaps rather than pages. */
  isIndex: boolean;
  /**
   * True only for a complete, well-formed XML document whose root is
   * `<urlset>`. A body cut short, broken XML, or a list of bare `<loc>`
   * elements is false: its entries may be read, but they cannot be trusted
   * to say which pages left the sitemap.
   */
  wellFormed: boolean;
}

// Element names as the sitemap protocol writes them; a prefixed name is
// accepted as XML but the root must be the plain `urlset` the extractor reads.
const XML_NAME = "[A-Za-z_][\\w.:-]*";
const XML_TAG_RE = new RegExp(
  `<(/)?(${XML_NAME})((?:\\s+${XML_NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/)?>`,
  "y",
);
// An `&` that does not start a named or numeric character reference.
const BARE_AMPERSAND_RE = /&(?![A-Za-z_][\w.-]*;|#[0-9]+;|#x[0-9A-Fa-f]+;)/;

/** What `walkXml` reports as it reads a document, in order. */
interface XmlVisitor {
  /** An element opened; `depth` is how many elements enclose it (0 for the root). */
  open(name: string, depth: number): void;
  /** An element closed; `depth` as for its `open`. */
  close(name: string, depth: number): void;
  /** Character data inside an element: raw text (entities not decoded), or a CDATA section's contents. */
  text(value: string, cdata: boolean): void;
}

/**
 * Reads `xml` left to right and reports its elements and character data to
 * `visitor`, skipping comments and processing instructions. Returns the root
 * element's name and whether the whole input is one complete, well-formed
 * XML document: every element closed in order, attributes quoted, no stray
 * `<` or `&`, nothing but comments, processing instructions and whitespace
 * outside the root. Not a validating parser: it checks what a sync needs to
 * know, that the body was not cut short or broken before its last entry.
 * A DOCTYPE is refused; the sitemap protocol has no use for one. Reading
 * stops at the first fault, so a visitor may have seen only part of it.
 */
function walkXml(xml: string, visitor: XmlVisitor): { root: string | null; wellFormed: boolean } {
  const n = xml.length;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const open: string[] = [];
  let root: string | null = null;
  let rootClosed = false;
  const fault = () => ({ root, wellFormed: false });
  while (i < n) {
    const lt = xml.indexOf("<", i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      const text = xml.slice(i, textEnd);
      if (open.length === 0 ? /\S/.test(text) : BARE_AMPERSAND_RE.test(text)) return fault();
      if (open.length > 0) visitor.text(text, false);
      i = textEnd;
      if (lt === -1) break;
    }
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end === -1) return fault();
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      if (open.length === 0 || end === -1) return fault();
      visitor.text(xml.slice(i + 9, end), true);
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2);
      if (end === -1) return fault();
      i = end + 2;
      continue;
    }
    XML_TAG_RE.lastIndex = i;
    const tag = XML_TAG_RE.exec(xml);
    if (tag === null) return fault();
    const [whole, closing, name = "", attributes = "", selfClosing] = tag;
    if (BARE_AMPERSAND_RE.test(attributes)) return fault();
    if (closing !== undefined) {
      if (attributes !== "" || selfClosing !== undefined || open.pop() !== name) return fault();
      visitor.close(name, open.length);
      if (open.length === 0) rootClosed = true;
    } else {
      if (open.length === 0) {
        if (root !== null) return fault();
        root = name;
      }
      visitor.open(name, open.length);
      if (selfClosing === undefined) {
        open.push(name);
      } else {
        visitor.close(name, open.length);
        if (open.length === 0) rootClosed = true;
      }
    }
    i += whole.length;
  }
  return { root, wellFormed: root !== null && rootClosed && open.length === 0 };
}

const IGNORE_XML: XmlVisitor = { open() {}, close() {}, text() {} };

/**
 * True when `xml` is one complete, well-formed XML document whose root is
 * `<urlset>` (see `walkXml` for what that checks). A prefixed name is
 * accepted as XML, but the root must be the plain `urlset` the extractor reads.
 * Source: https://www.sitemaps.org/protocol.html — checked 2026-11-18
 */
export function isWellFormedUrlset(xml: string): boolean {
  const { root, wellFormed } = walkXml(xml, IGNORE_XML);
  return wellFormed && root === "urlset";
}

/** Character data collected from one element, decoded as `locValue` would. */
function elementValue(parts: Array<{ value: string; cdata: boolean }>): string {
  return parts
    .map((part) => (part.cdata ? part.value : decodeXmlEntities(part.value)))
    .join("")
    .trim();
}

/**
 * Reads `<url>` entries with their `<lastmod>`, from the same reading of the
 * document `isWellFormedUrlset` checks: comments, processing instructions
 * and markup inside CDATA are never taken for elements, so a commented-out
 * `<loc>` or `<url>` is not a page the sitemap lists. An entry's location is
 * its first `<loc>` child. A sitemap written as bare `<loc>` elements (no
 * `<url>` wrappers) is read without dates.
 */
export function extractSitemapEntries(xml: string, maxUrls: number): SitemapEntries {
  const seen = new Set<string>();
  const entries: SitemapEntry[] = [];
  let truncated = false;
  const add = (url: string | null, lastmod: string | null): void => {
    if (truncated || url === null || seen.has(url)) return;
    if (entries.length >= maxUrls) {
      truncated = true;
      return;
    }
    seen.add(url);
    entries.push({ url, lastmod });
  };

  let sawUrl = false;
  const bareLocs: string[] = [];
  // The `<url>` being read (a child of the root), and the element of it whose text is collected.
  let entry: { loc: string | null; lastmod: string | null } | null = null;
  let capture: {
    name: string;
    depth: number;
    parts: Array<{ value: string; cdata: boolean }>;
  } | null = null;
  const { root, wellFormed } = walkXml(xml, {
    open(name, depth) {
      if (capture !== null) return;
      if (depth === 1 && name === "url") {
        sawUrl = true;
        entry = { loc: null, lastmod: null };
      } else if (name === "loc" || (name === "lastmod" && entry !== null && depth === 2)) {
        capture = { name, depth, parts: [] };
      }
    },
    text(value, cdata) {
      capture?.parts.push({ value, cdata });
    },
    close(name, depth) {
      if (capture !== null && capture.depth === depth && capture.name === name) {
        const value = elementValue(capture.parts);
        capture = null;
        if (entry !== null && depth === 2) {
          if (name === "loc" && entry.loc === null) entry.loc = value;
          if (name === "lastmod" && entry.lastmod === null) entry.lastmod = value.slice(0, 64);
        } else if (name === "loc" && !sawUrl) {
          bareLocs.push(value);
        }
        return;
      }
      if (capture === null && entry !== null && depth === 1 && name === "url") {
        const done: { loc: string | null; lastmod: string | null } = entry;
        entry = null;
        add(safeLoc(done.loc ?? ""), done.lastmod === "" ? null : done.lastmod);
      }
    },
  });
  if (!sawUrl) for (const loc of bareLocs) add(safeLoc(loc), null);
  const isIndex = root === "sitemapindex";
  return { entries, truncated, isIndex, wellFormed: wellFormed && root === "urlset" };
}

/** Fetches a sitemap under the same guards and caps as the preview. */
export async function fetchSitemapXml(
  url: string,
  fetchImpl: typeof fetch = fetch,
  options?: SitemapFetchOptions,
): Promise<string> {
  const target = assertPublicHttpsUrl(url);
  // Redirects are followed manually so each hop is checked: `redirect: "follow"`
  // would let a public URL redirect to a link-local metadata address.
  const { body } = await fetchCapped(target, fetchImpl, {
    maxRedirects: MAX_REDIRECTS,
    timeoutMs: options?.timeoutMs ?? FETCH_TIMEOUT_MS,
    maxBytes: MAX_SITEMAP_BYTES,
    accept: "application/xml, text/xml, */*",
    resolveHost: options?.resolveHost,
  });
  return body;
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
  const xml = await fetchSitemapXml(url, fetchImpl, options);
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
