import { describe, expect, it } from "vitest";
import { MAX_PAGE_BYTES, plainPageFetcher } from "../../src/ingest/pageFetcher.js";
import { UnsafeUrlError } from "../../src/security/urlGuard.js";

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

const publicHost = async () => ["93.184.216.34"];

describe("plainPageFetcher", () => {
  it("turns a 200 HTML page into a title, Markdown and validators, following a redirect", async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = urlOf(input);
      requested.push(url);
      expect(init?.redirect).toBe("manual");
      expect(headerOf(init, "if-none-match")).toBeNull();
      if (url === "https://docs.example.com/old") {
        return new Response(null, { status: 301, headers: { location: "/billing" } });
      }
      return new Response(
        "<html><head><title>Billing</title></head><body><h1>Plans</h1><p>Pay monthly.</p></body></html>",
        {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            etag: '"v1"',
            "last-modified": "Tue, 17 Nov 2026 10:00:00 GMT",
          },
        },
      );
    };

    const result = await plainPageFetcher({
      fetch: fetchImpl,
      resolveHost: publicHost,
    }).fetchPage("https://docs.example.com/old");

    expect(requested).toEqual(["https://docs.example.com/old", "https://docs.example.com/billing"]);
    expect(result).toEqual({
      kind: "page",
      finalUrl: "https://docs.example.com/billing",
      status: 200,
      title: "Billing",
      markdown: "# Plans\n\nPay monthly.",
      etag: '"v1"',
      lastModified: "Tue, 17 Nov 2026 10:00:00 GMT",
      notModified: false,
    });
  });

  it("keeps Markdown and plain-text responses as they are", async () => {
    const fetcher = plainPageFetcher({
      fetch: async () =>
        new Response("  # Notes\n\nPlain words.  ", {
          headers: { "content-type": "text/markdown" },
        }),
    });
    const result = await fetcher.fetchPage("https://docs.example.com/notes.md");
    expect(result.kind).toBe("page");
    expect(result.title).toBe("/notes.md");
    expect(result.markdown).toBe("# Notes\n\nPlain words.");
    expect(result.etag).toBeNull();
    expect(result.lastModified).toBeNull();
  });

  it("sends the validators and reports a 304 as not modified", async () => {
    let sent: { etag: string | null; since: string | null } | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      sent = {
        etag: headerOf(init, "if-none-match"),
        since: headerOf(init, "if-modified-since"),
      };
      return new Response(null, { status: 304, headers: { etag: '"v2"' } });
    };

    const result = await plainPageFetcher({ fetch: fetchImpl }).fetchPage(
      "https://docs.example.com/billing",
      { etag: '"v2"', lastModified: "Tue, 17 Nov 2026 10:00:00 GMT" },
    );

    expect(sent).toEqual({ etag: '"v2"', since: "Tue, 17 Nov 2026 10:00:00 GMT" });
    expect(result).toEqual({
      kind: "not_modified",
      finalUrl: "https://docs.example.com/billing",
      status: 304,
      title: null,
      markdown: null,
      etag: '"v2"',
      // The 304 left it out; the one sent still holds.
      lastModified: "Tue, 17 Nov 2026 10:00:00 GMT",
      notModified: true,
    });
  });

  it("refuses a 304 to a request that sent no validators", async () => {
    const fetcher = plainPageFetcher({ fetch: async () => new Response(null, { status: 304 }) });
    await expect(fetcher.fetchPage("https://docs.example.com/")).rejects.toThrow(
      "upstream returned HTTP 304",
    );
  });

  it("refuses a redirect to a private address before fetching it", async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = urlOf(input);
      requested.push(url);
      if (url === "https://docs.example.com/literal") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data" },
        });
      }
      if (url === "https://docs.example.com/named") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://rebind.example.com/secret" },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    };
    const fetcher = plainPageFetcher({
      fetch: fetchImpl,
      resolveHost: async (host) =>
        host === "docs.example.com" ? ["93.184.216.34"] : ["10.0.0.42"],
    });

    await expect(fetcher.fetchPage("https://docs.example.com/literal")).rejects.toThrow(
      UnsafeUrlError,
    );
    await expect(fetcher.fetchPage("https://docs.example.com/named")).rejects.toThrow(
      UnsafeUrlError,
    );
    expect(requested).toEqual([
      "https://docs.example.com/literal",
      "https://docs.example.com/named",
    ]);
  });

  it("refuses non-https and private URLs without fetching", async () => {
    let fetched = false;
    const fetcher = plainPageFetcher({
      fetch: async () => {
        fetched = true;
        return new Response("<p>x</p>");
      },
    });
    for (const url of ["http://docs.example.com/", "https://127.0.0.1/", "https://localhost/"]) {
      await expect(fetcher.fetchPage(url)).rejects.toThrow(UnsafeUrlError);
    }
    await expect(
      plainPageFetcher({
        fetch: async () => {
          fetched = true;
          return new Response("<p>x</p>");
        },
        resolveHost: async () => ["fe80::1"],
      }).fetchPage("https://docs.example.com/"),
    ).rejects.toThrow(UnsafeUrlError);
    expect(fetched).toBe(false);
  });

  it("refuses an oversized body, declared or streamed", async () => {
    const declared = plainPageFetcher({
      fetch: async () =>
        new Response("<p>small</p>", {
          headers: { "content-type": "text/html", "content-length": String(MAX_PAGE_BYTES + 1) },
        }),
    });
    await expect(declared.fetchPage("https://docs.example.com/big")).rejects.toThrow(
      `response exceeds ${MAX_PAGE_BYTES} bytes`,
    );

    const streamed = plainPageFetcher({
      maxBytes: 16,
      fetch: async () =>
        new Response("<p>this body is longer than sixteen bytes</p>", {
          headers: { "content-type": "text/html" },
        }),
    });
    await expect(streamed.fetchPage("https://docs.example.com/big")).rejects.toThrow(
      "response exceeds 16 bytes",
    );
  });

  it("times out a stalled body", async () => {
    let cancelled = false;
    const fetcher = plainPageFetcher({
      timeoutMs: 25,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/html" } },
        ),
    });
    await expect(fetcher.fetchPage("https://docs.example.com/slow")).rejects.toThrow(
      "request timed out",
    );
    expect(cancelled).toBe(true);
  });

  it("reports a non-HTML response as no content without reading its body", async () => {
    let bodyRead = false;
    let cancelled = false;
    const fetcher = plainPageFetcher({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                bodyRead = true;
                controller.enqueue(new Uint8Array(MAX_PAGE_BYTES + 1));
              },
              cancel() {
                cancelled = true;
              },
            },
            // No read ahead: `pull` runs only when someone reads.
            { highWaterMark: 0 },
          ),
          {
            headers: {
              "content-type": "application/pdf",
              "content-length": String(MAX_PAGE_BYTES + 1),
            },
          },
        ),
    });

    const result = await fetcher.fetchPage("https://docs.example.com/guide.pdf");
    expect(bodyRead).toBe(false);
    expect(cancelled).toBe(true);
    expect(result).toEqual({
      kind: "no_content",
      reason: "not_html",
      contentType: "application/pdf",
      finalUrl: "https://docs.example.com/guide.pdf",
      status: 200,
      title: null,
      markdown: null,
      etag: null,
      lastModified: null,
      notModified: false,
    });
  });

  it("reports a page with no text as an empty extraction, not an empty document", async () => {
    const fetcher = plainPageFetcher({
      fetch: async () =>
        new Response(
          "<html><head><title>Loading</title><script>app()</script></head><body></body></html>",
          { headers: { "content-type": "text/html" } },
        ),
    });
    const result = await fetcher.fetchPage("https://docs.example.com/app");
    expect(result).toMatchObject({
      kind: "no_content",
      reason: "empty",
      contentType: "text/html",
      title: "Loading",
      markdown: null,
    });

    const blank = plainPageFetcher({
      fetch: async () => new Response("   \n", { headers: { "content-type": "text/plain" } }),
    });
    expect(await blank.fetchPage("https://docs.example.com/blank.txt")).toMatchObject({
      kind: "no_content",
      reason: "empty",
      title: "/blank.txt",
    });
  });

  it("reads a response with no content-type as HTML, as the sitemap import always has", async () => {
    const fetcher = plainPageFetcher({
      fetch: async () => {
        const res = new Response("<p>Hello</p>");
        res.headers.delete("content-type");
        return res;
      },
    });
    expect(await fetcher.fetchPage("https://docs.example.com/")).toMatchObject({
      kind: "page",
      markdown: "Hello",
    });
  });
});
