import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "./helpers/app.js";

describe("health and routing", () => {
  it("returns 200 { ok: true } on GET /health", async () => {
    const app = createTestApp();
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request("https://example.com/health"), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("returns 404 with a plain message for unknown paths", async () => {
    const app = createTestApp();
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request("https://example.com/nope"), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
  });
});

describe("admin same-origin check", () => {
  it("rejects POST to /api/admin/* with missing Origin without calling handler", async () => {
    const login = vi.fn(async () => Response.json({ ok: true }));
    const app = createTestApp({
      auth: {
        authenticate: async () => null,
        login,
        logout: async () => Response.json({ ok: true }),
      },
    });
    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request("https://example.com/api/admin/login", { method: "POST" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
    expect(login).not.toHaveBeenCalled();
  });

  it("rejects POST to /api/admin/* with foreign Origin without calling handler", async () => {
    const logout = vi.fn(async () => Response.json({ ok: true }));
    const app = createTestApp({
      auth: {
        authenticate: async () => null,
        login: async () => Response.json({ ok: true }),
        logout,
      },
    });
    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request("https://example.com/api/admin/logout", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
    expect(logout).not.toHaveBeenCalled();
  });

  it("allows POST to /api/admin/* with matching Origin", async () => {
    const login = vi.fn(async () => Response.json({ ok: true }));
    const app = createTestApp({
      auth: {
        authenticate: async () => null,
        login,
        logout: async () => Response.json({ ok: true }),
      },
    });
    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request("https://example.com/api/admin/login", {
        method: "POST",
        headers: { Origin: "https://example.com" },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(login).toHaveBeenCalledOnce();
  });

  it("allows GET to /api/admin/* without Origin", async () => {
    const app = createTestApp();
    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request("https://example.com/api/admin/assistants", { method: "GET" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
  });
});
