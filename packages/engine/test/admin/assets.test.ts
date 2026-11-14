import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
});
