import { MAX_DOCUMENT_MARKDOWN_BYTES } from "@solvchat/core";
import type { PageFetcher, PageFetchResult, PageValidators } from "../seams/types.js";
import { assertPublicHttpsUrl, fetchCapped, type HostResolver } from "../security/urlGuard.js";
import { extractHtml } from "./htmlToMarkdown.js";

// Caps chosen because the spec gives none for this path: a page larger than a
// document may be is refused rather than truncated, and the budgets stop one
// fetch from occupying the Worker.
export const MAX_PAGE_BYTES = MAX_DOCUMENT_MARKDOWN_BYTES;
export const MAX_PAGE_REDIRECTS = 3;
export const PAGE_FETCH_TIMEOUT_MS = 10_000;

export interface PlainPageFetcherOptions {
  /** Defaults to the global `fetch`. Tests pass a fake. */
  fetch?: typeof fetch | undefined;
  /**
   * Defaults to DNS-over-HTTPS when `fetch` is the global one. With a fake
   * `fetch` and no resolver the address check is skipped, as in `urlGuard`.
   */
  resolveHost?: HostResolver | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  maxRedirects?: number | undefined;
}

type Body = "html" | "text" | null;

function bodyKind(contentType: string): Body {
  if (contentType.includes("text/markdown") || contentType.includes("text/plain")) return "text";
  // A server that names no type gets the HTML extractor, as the sitemap
  // import always did.
  if (
    contentType === "" ||
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml+xml")
  ) {
    return "html";
  }
  return null;
}

function contentTypeOf(response: Response): string {
  return response.headers.get("content-type")?.toLowerCase().trim() ?? "";
}

function pathTitle(url: URL): string {
  return (url.pathname || url.hostname).slice(0, 300);
}

/**
 * The open build's page fetcher: Workers `fetch` with every hop checked by
 * `urlGuard` (https only, DNS-over-HTTPS refusing private, loopback and
 * link-local addresses), a size cap and a timeout, then the HTML-to-Markdown
 * extraction in `ingest/htmlToMarkdown`. Markdown and plain-text responses are
 * kept as they are.
 *
 * Titles that fall back to the URL path use the URL asked for, not the one
 * redirected to, so a document keeps its title when a site moves a page.
 */
export function plainPageFetcher(options: PlainPageFetcherOptions = {}): PageFetcher {
  return {
    async fetchPage(url: string, validators?: PageValidators): Promise<PageFetchResult> {
      const target = assertPublicHttpsUrl(url);
      const headers: Record<string, string> = {};
      if (validators?.etag) headers["if-none-match"] = validators.etag;
      if (validators?.lastModified) headers["if-modified-since"] = validators.lastModified;
      const conditional = Object.keys(headers).length > 0;

      const { response, body, finalUrl } = await fetchCapped(target, options.fetch ?? fetch, {
        maxRedirects: options.maxRedirects ?? MAX_PAGE_REDIRECTS,
        timeoutMs: options.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS,
        maxBytes: options.maxBytes ?? MAX_PAGE_BYTES,
        accept: "text/html, text/markdown, text/plain, */*",
        resolveHost: options.resolveHost,
        headers,
        allowNotModified: conditional,
        // Refused by type before the body is read, so a large PDF is
        // reported as not a page rather than as too big.
        skipBody: (res) => bodyKind(contentTypeOf(res)) === null,
      });
      const contentType = contentTypeOf(response);
      const kind = bodyKind(contentType);

      const fields = {
        finalUrl: finalUrl.href,
        status: response.status,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      };

      if (response.status === 304) {
        return {
          ...fields,
          kind: "not_modified",
          notModified: true,
          // A 304 may omit validators that still hold; keep the ones sent.
          etag: fields.etag ?? validators?.etag ?? null,
          lastModified: fields.lastModified ?? validators?.lastModified ?? null,
          title: null,
          markdown: null,
        };
      }

      const noContent = (reason: "not_html" | "empty", title: string | null) => ({
        ...fields,
        kind: "no_content" as const,
        notModified: false as const,
        reason,
        contentType: contentType === "" ? null : contentType,
        title,
        markdown: null,
      });

      if (kind === null) return noContent("not_html", null);

      let title: string;
      let markdown: string;
      if (kind === "text") {
        title = pathTitle(target);
        markdown = body.trim();
      } else {
        ({ title, markdown } = extractHtml(body, target.href));
      }
      if (markdown === "") return noContent("empty", title);

      return { ...fields, kind: "page", notModified: false, title, markdown };
    },
  };
}
