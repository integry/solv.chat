import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { ADMIN_PREVIEW_CSP } from "@solvchat/core";
import { describe, expect, it } from "vitest";
import { assetBody } from "../../src/admin/assets.js";
import { createTestApp, fakeSeams } from "../helpers/app.js";

const unauthenticatedApp = () =>
  createTestApp({
    auth: {
      ...fakeSeams().auth,
      async authenticate() {
        return null;
      },
    },
  });

describe("admin static assets", () => {
  it("serves the HTML shell on /admin and deep paths with no-store and without authentication", async () => {
    const app = unauthenticatedApp();

    for (const path of ["/admin", "/admin/", "/admin/behaviour", "/admin/widget"]) {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`https://example.com${path}`), env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-store");

      const html = await res.text();
      expect(html).toContain('<div id="root">');
      expect(html).not.toContain("pk_");
      expect(html).not.toContain("https://cdn");
    }
  });

  it("serves hashed assets with a long max-age and returns 404 for unknown assets", async () => {
    const app = unauthenticatedApp();

    const htmlCtx = createExecutionContext();
    const htmlRes = await app.fetch(new Request("https://example.com/admin"), env, htmlCtx);
    await waitOnExecutionContext(htmlCtx);
    const html = await htmlRes.text();

    const jsMatch = /src="(\/admin\/assets\/[^"]+\.js)"/.exec(html);
    expect(jsMatch?.[1]).toBeTruthy();

    const assetCtx = createExecutionContext();
    const assetRes = await app.fetch(
      new Request(`https://example.com${jsMatch?.[1] ?? ""}`),
      env,
      assetCtx,
    );
    await waitOnExecutionContext(assetCtx);

    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get("content-type")).toContain("application/javascript");
    expect(assetRes.headers.get("cache-control")).toMatch(/max-age=31536000/);

    const missingCtx = createExecutionContext();
    const missingRes = await app.fetch(
      new Request("https://example.com/admin/assets/does-not-exist.js"),
      env,
      missingCtx,
    );
    await waitOnExecutionContext(missingCtx);

    expect(missingRes.status).toBe(404);
  });

  it("serves a binary asset byte for byte", async () => {
    // PNG signature plus bytes that are not valid UTF-8 on their own.
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80];
    const body = assetBody({
      body: btoa(String.fromCharCode(...bytes)),
      type: "image/png",
      encoding: "base64",
    });
    const served = new Uint8Array(await new Response(body).arrayBuffer());
    expect([...served]).toEqual(bytes);

    expect(assetBody({ body: "a{}", type: "text/css", encoding: "utf8" })).toBe("a{}");
  });

  it("sets security headers on the admin shell while hashed assets and 404s keep their behaviour", async () => {
    const app = unauthenticatedApp();

    const shellCtx = createExecutionContext();
    const shellRes = await app.fetch(new Request("https://example.com/admin"), env, shellCtx);
    await waitOnExecutionContext(shellCtx);

    expect(shellRes.status).toBe(200);
    expect(shellRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(shellRes.headers.get("referrer-policy")).toBe("same-origin");
    expect(shellRes.headers.get("x-frame-options")).toBe("DENY");

    const csp = shellRes.headers.get("content-security-policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // The Widget screen frames /admin/preview.html, and nothing else.
    expect(csp).toContain("frame-src 'self'");

    const html = await shellRes.text();
    const jsMatch = /src="(\/admin\/assets\/[^"]+\.js)"/.exec(html);
    expect(jsMatch?.[1]).toBeTruthy();

    const assetCtx = createExecutionContext();
    const assetRes = await app.fetch(
      new Request(`https://example.com${jsMatch?.[1] ?? ""}`),
      env,
      assetCtx,
    );
    await waitOnExecutionContext(assetCtx);
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get("content-type")).toContain("application/javascript");
    expect(assetRes.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(assetRes.headers.get("content-security-policy")).toBeNull();

    const missingCtx = createExecutionContext();
    const missingRes = await app.fetch(
      new Request("https://example.com/admin/assets/missing.js"),
      env,
      missingCtx,
    );
    await waitOnExecutionContext(missingCtx);
    expect(missingRes.status).toBe(404);
  });

  it("serves the Widget preview page with its own policy and revalidates the unhashed preview files", async () => {
    const app = unauthenticatedApp();
    const get = async (path: string) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`https://example.com${path}`), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };

    const page = await get("/admin/preview.html");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(page.headers.get("x-frame-options")).toBeNull();
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(`${ADMIN_PREVIEW_CSP}; frame-ancestors 'self'`);
    expect(csp).not.toContain("connect-src");
    expect(csp).not.toContain("unsafe-inline");
    const html = await page.text();
    // The static page, not the app shell the SPA fallback would return.
    expect(html).toContain("<solv-chat></solv-chat>");
    expect(html).toContain('<script src="preview.js">');
    expect(html).not.toContain('<div id="root">');

    for (const [path, type] of [
      ["/admin/preview.js", "application/javascript"],
      ["/admin/preview.css", "text/css"],
    ] as const) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(type);
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });
});
