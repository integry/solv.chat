import { describe, expect, it } from "vitest";
import {
  assertPublicHttpsUrl,
  assertPublicIpAddress,
  fetchCapped,
  followCheckingEachHop,
  UnsafeUrlError,
} from "../../src/security/urlGuard.js";

describe("urlGuard", () => {
  it("rejects non-https and private literal addresses", () => {
    expect(() => assertPublicHttpsUrl("http://docs.example.com/")).toThrow(UnsafeUrlError);
    expect(() => assertPublicHttpsUrl("https://localhost/")).toThrow(UnsafeUrlError);
    expect(() => assertPublicHttpsUrl("https://127.0.0.1/")).toThrow(UnsafeUrlError);
    expect(() => assertPublicHttpsUrl("https://10.0.0.1/")).toThrow(UnsafeUrlError);
    expect(() => assertPublicHttpsUrl("https://169.254.169.254/latest/meta-data")).toThrow(
      UnsafeUrlError,
    );
    expect(() => assertPublicHttpsUrl("https://192.168.1.1/")).toThrow(UnsafeUrlError);
    expect(() => assertPublicHttpsUrl("https://[::1]/")).toThrow(UnsafeUrlError);
    expect(() => assertPublicHttpsUrl("https://[fc00::1]/")).toThrow(UnsafeUrlError);

    expect(assertPublicHttpsUrl("https://docs.example.com/sitemap.xml").href).toBe(
      "https://docs.example.com/sitemap.xml",
    );
  });

  it("refuses NAT64 and 6to4 addresses that embed a private IPv4 address", () => {
    const refused = [
      "64:ff9b::7f00:1", // NAT64 → 127.0.0.1
      "64:ff9b::a9fe:a9fe", // NAT64 → 169.254.169.254
      "64:ff9b::c0a8:101", // NAT64 → 192.168.1.1
      "64:ff9b:1::808:808", // local-use NAT64: embedding unknown, whole prefix
      "2002:7f00:1::", // 6to4 → 127.0.0.1
      "2002:a00:1::1", // 6to4 → 10.0.0.1
      "2002:a9fe:a9fe::", // 6to4 → 169.254.169.254
    ];
    for (const ip of refused) {
      expect(() => assertPublicIpAddress(ip), ip).toThrow(UnsafeUrlError);
      expect(() => assertPublicHttpsUrl(`https://[${ip}]/`), ip).toThrow(UnsafeUrlError);
    }
    // The same prefixes embedding a public address are ordinary addresses.
    for (const ip of ["64:ff9b::808:808", "2002:808:808::1"]) {
      expect(assertPublicIpAddress(ip)).toBeTruthy();
      expect(assertPublicHttpsUrl(`https://[${ip}]/`).hostname).toBe(`[${ip}]`);
    }
  });

  it("refuses hostnames resolving to private, loopback, or link-local addresses", async () => {
    let fetchCalled = false;
    const fetchImpl: typeof fetch = async () => {
      fetchCalled = true;
      return new Response("ok");
    };

    await expect(
      followCheckingEachHop(new URL("https://internal.example.com/"), fetchImpl, {
        maxRedirects: 3,
        timeoutMs: 1000,
        resolveHost: async () => ["127.0.0.1"],
      }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(fetchCalled).toBe(false);

    await expect(
      followCheckingEachHop(new URL("https://metadata.example.com/"), fetchImpl, {
        maxRedirects: 3,
        timeoutMs: 1000,
        resolveHost: async () => ["93.184.216.34", "169.254.169.254"],
      }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(fetchCalled).toBe(false);
  });

  it("refuses redirects to private literal addresses or hostnames resolving to private addresses", async () => {
    const redirectToLiteral: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/secret" },
      });

    await expect(
      followCheckingEachHop(new URL("https://docs.example.com/"), redirectToLiteral, {
        maxRedirects: 3,
        timeoutMs: 1000,
        resolveHost: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow(UnsafeUrlError);

    const redirectToPrivateHost: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://public.example.com/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://private.example.com/secret" },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    };

    await expect(
      followCheckingEachHop(new URL("https://public.example.com/"), redirectToPrivateHost, {
        maxRedirects: 3,
        timeoutMs: 1000,
        resolveHost: async (host) =>
          host === "public.example.com" ? ["93.184.216.34"] : ["10.0.0.5"],
      }),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("refuses more redirects than maxRedirects", async () => {
    let hops = 0;
    const fetchImpl: typeof fetch = async () => {
      hops++;
      return new Response(null, {
        status: 302,
        headers: { location: `https://docs.example.com/hop-${hops}` },
      });
    };

    await expect(
      followCheckingEachHop(new URL("https://docs.example.com/"), fetchImpl, {
        maxRedirects: 2,
        timeoutMs: 1000,
        resolveHost: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(hops).toBe(3);
  });

  it("times out and cancels a stalled response body", async () => {
    let cancelled = false;
    const fetchImpl: typeof fetch = async () => {
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      writer.closed.catch(() => {
        cancelled = true;
      });
      void writer.write(new TextEncoder().encode("partial")).catch(() => {});
      return new Response(stream.readable, { status: 200 });
    };

    await expect(
      fetchCapped(new URL("https://docs.example.com/slow"), fetchImpl, {
        maxRedirects: 3,
        timeoutMs: 25,
        maxBytes: 1024,
        resolveHost: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(cancelled).toBe(true);
  });

  it("rejects oversize bodies via Content-Length and streamed byte count", async () => {
    const declaredOversize: typeof fetch = async () =>
      new Response("small", {
        status: 200,
        headers: { "content-length": "2048" },
      });

    await expect(
      fetchCapped(new URL("https://docs.example.com/big-header"), declaredOversize, {
        maxRedirects: 3,
        timeoutMs: 1000,
        maxBytes: 1024,
        resolveHost: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow(UnsafeUrlError);

    const streamedOversize: typeof fetch = async () =>
      new Response("x".repeat(1025), { status: 200 });

    await expect(
      fetchCapped(new URL("https://docs.example.com/big-body"), streamedOversize, {
        maxRedirects: 3,
        timeoutMs: 1000,
        maxBytes: 1024,
        resolveHost: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow(UnsafeUrlError);
  });
});
