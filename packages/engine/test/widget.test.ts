import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/util/crypto.js";
import { scriptAsset } from "../src/util/scriptAsset.js";
import { createTestApp } from "./helpers/app.js";

const CACHE_CONTROL = "public, max-age=300, must-revalidate, no-transform";

describe.each([
  { path: "/widget.js", marker: "solv-chat", contentTypeOptions: null },
  { path: "/v1/check/frame.js", marker: "solvCheckLoaded", contentTypeOptions: "nosniff" },
])("GET $path", ({ path, marker, contentTypeOptions }) => {
  async function load(ifNoneMatch?: string): Promise<Response> {
    const ctx = createExecutionContext();
    const request = new Request(`https://example.com${path}`, {
      headers: {
        origin: "https://embed.example",
        ...(ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch }),
      },
    });
    const response = await createTestApp().fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  it("serves JavaScript with a strong content tag and five minutes of freshness", async () => {
    const response = await load();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(CACHE_CONTROL);
    expect(response.headers.get("x-content-type-options")).toBe(contentTypeOptions);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const body = await response.text();
    expect(body).toContain(marker);
    expect(response.headers.get("etag")).toBe(`"${await sha256Hex(body)}"`);
  });

  it("revalidates with a bodyless 304 when any requested tag matches", async () => {
    const tag = (await load()).headers.get("etag") ?? "";
    for (const validator of [tag, `"older,build", W/${tag}`, "*"]) {
      const response = await load(validator);
      expect(response.status).toBe(304);
      expect(response.body).toBeNull();
      expect(response.headers.get("etag")).toBe(tag);
      expect(response.headers.get("cache-control")).toBe(CACHE_CONTROL);
      expect(response.headers.get("x-content-type-options")).toBe(contentTypeOptions);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("serves the script when the requested tag does not match", async () => {
    const response = await load('W/"old-build"');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(marker);
  });
});

it("serves a changed bundle at the same URL with a different tag", async () => {
  const url = "https://example.com/widget.js";
  const oldBuild = scriptAsset("console.log('old build');");
  const newBody = "console.log('new build');";
  const newBuild = scriptAsset(newBody);

  const oldResponse = await oldBuild(new Request(url));
  const oldTag = oldResponse.headers.get("etag") ?? "";
  const response = await newBuild(new Request(url, { headers: { "if-none-match": oldTag } }));
  expect(response.status).toBe(200);
  expect(response.headers.get("etag")).not.toBe(oldTag);
  expect(await response.text()).toBe(newBody);
});
