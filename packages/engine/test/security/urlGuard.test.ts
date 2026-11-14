import { describe, expect, it, vi } from "vitest";
import {
  createPinnedHttpsTransport,
  followCheckingEachHop,
  type HttpsRequestFn,
  type PinnedHttpsIncomingMessage,
  type PinnedHttpsRequestOptions,
  UnsafeUrlError,
} from "../../src/security/urlGuard.js";

function makeFakeHttpsRequest(
  onRequest: (
    options: PinnedHttpsRequestOptions,
    emitResponse: (res: PinnedHttpsIncomingMessage) => void,
  ) => void,
): { fn: HttpsRequestFn; getDestroyed: () => boolean } {
  let destroyed = false;
  const fn: HttpsRequestFn = (options, callback) => {
    const errorListeners: Array<(err: Error) => void> = [];
    return {
      on(event, listener) {
        if (event === "error") errorListeners.push(listener);
      },
      end() {
        onRequest(options, callback);
      },
      destroy() {
        destroyed = true;
      },
    };
  };
  return { fn, getDestroyed: () => destroyed };
}

describe("urlGuard pinned production transport", () => {
  it("pins the connection to resolvedIp while preserving SNI servername and Host header", async () => {
    let capturedOptions: PinnedHttpsRequestOptions | undefined;
    const { fn } = makeFakeHttpsRequest((options, emitResponse) => {
      capturedOptions = options;
      const listeners = new Map<string, Array<(arg?: unknown) => void>>();
      const on = (event: string, cb: (arg?: unknown) => void) => {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
      };
      emitResponse({
        statusCode: 200,
        headers: {
          "content-type": "application/xml",
          "x-multi": ["one", "two"],
        },
        on: on as PinnedHttpsIncomingMessage["on"],
        resume() {},
        destroy() {},
      });
      queueMicrotask(() => {
        for (const cb of listeners.get("data") ?? []) {
          cb(new TextEncoder().encode("<urlset/>"));
        }
        for (const cb of listeners.get("end") ?? []) {
          cb();
        }
      });
    });

    const transport = createPinnedHttpsTransport(async () => fn);
    const response = await transport(
      {
        url: new URL("https://docs.example.com:8443/sitemap.xml?v=1"),
        resolvedIp: "93.184.216.34",
      },
      { method: "GET", headers: { accept: "application/xml" } },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<urlset/>");
    expect(response.headers.get("content-type")).toBe("application/xml");
    expect(response.headers.get("x-multi")).toBe("one, two");

    expect(capturedOptions?.host).toBe("93.184.216.34");
    expect(capturedOptions?.port).toBe(8443);
    expect(capturedOptions?.path).toBe("/sitemap.xml?v=1");
    expect(capturedOptions?.servername).toBe("docs.example.com");
    expect(capturedOptions?.headers.host).toBe("docs.example.com:8443");
    expect(capturedOptions?.headers.accept).toBe("application/xml");

    let lookedUp: { err: Error | null; address: string; family: number } | undefined;
    capturedOptions?.lookup("docs.example.com", {}, (err, address, family) => {
      lookedUp = { err, address, family };
    });
    expect(lookedUp).toEqual({ err: null, address: "93.184.216.34", family: 4 });
  });

  it("handles null-body statuses such as 204 without throwing", async () => {
    let resumed = false;
    const { fn } = makeFakeHttpsRequest((_options, emitResponse) => {
      emitResponse({
        statusCode: 204,
        headers: {},
        on() {},
        resume() {
          resumed = true;
        },
        destroy() {},
      });
    });

    const transport = createPinnedHttpsTransport(async () => fn);
    const response = await transport(
      { url: new URL("https://docs.example.com/empty"), resolvedIp: "2606:2800:220:1::" },
      { method: "GET" },
    );
    expect(response.status).toBe(204);
    expect(resumed).toBe(true);
  });

  it("fails closed when resolvedIp is missing, private, or https.request is unavailable", async () => {
    const transport = createPinnedHttpsTransport(async () => {
      throw new Error("should not be called");
    });

    await expect(
      transport({ url: new URL("https://docs.example.com/"), resolvedIp: null }, { method: "GET" }),
    ).rejects.toThrow(UnsafeUrlError);

    await expect(
      transport(
        { url: new URL("https://docs.example.com/"), resolvedIp: "127.0.0.1" },
        { method: "GET" },
      ),
    ).rejects.toThrow(UnsafeUrlError);

    await expect(
      transport(
        { url: new URL("https://docs.example.com/"), resolvedIp: "::1" },
        { method: "GET" },
      ),
    ).rejects.toThrow(UnsafeUrlError);

    const unavailable = createPinnedHttpsTransport(async () => null);
    await expect(
      unavailable(
        { url: new URL("https://docs.example.com/"), resolvedIp: "93.184.216.34" },
        { method: "GET" },
      ),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("destroys the underlying request when aborted", async () => {
    const controller = new AbortController();
    const { fn, getDestroyed } = makeFakeHttpsRequest(() => {
      // Abort once the request is in flight.
      controller.abort();
    });
    const transport = createPinnedHttpsTransport(async () => fn);
    const pending = transport(
      { url: new URL("https://docs.example.com/slow"), resolvedIp: "93.184.216.34" },
      { method: "GET", signal: controller.signal },
    );

    await expect(pending).rejects.toThrow(UnsafeUrlError);
    expect(getDestroyed()).toBe(true);
  });

  it("uses the production pinned transport rather than fetch when no transport override is provided", async () => {
    const fetchSpy = vi.fn(async () => new Response("should not be called via fetch"));
    vi.stubGlobal("fetch", fetchSpy);

    try {
      await expect(
        followCheckingEachHop(new URL("https://docs.example.com/sitemap.xml"), fetch, {
          maxRedirects: 3,
          timeoutMs: 150,
          resolveHost: async () => ["93.184.216.34"],
        }),
      ).rejects.toThrow(UnsafeUrlError);

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
