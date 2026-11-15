import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers/app.js";

describe("GET /widget.js", () => {
  it("serves the widget bundle with JavaScript content-type and long Cache-Control", async () => {
    const app = createTestApp();
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request("https://example.com/widget.js"), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/javascript");
    expect(response.headers.get("cache-control")).toMatch(/max-age=\d+/);

    const body = await response.text();
    expect(body).toContain("solv-chat");
  });
});
