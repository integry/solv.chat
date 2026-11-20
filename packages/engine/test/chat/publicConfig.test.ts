import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { defaultVersionConfig } from "@solvchat/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { basicLimits } from "../../src/seams/open/basicLimits.js";
import { createTestApp, fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

describe("chat/publicConfig", () => {
  const tenant = forPrincipal(env.DB, {
    orgId: TEST_ORG_ID,
    userId: "usr_1",
    role: "owner",
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
    ]);

    await tenant.assistants.create({
      id: "ast_1",
      name: "Docs Bot",
      publicKey: "pk_pub_1",
      allowedOrigins: ["https://site.example"],
      createdAt: 1000,
    });
  });

  it("records the widget's first load on an allowed origin, once, for the Overview checklist", async () => {
    const draft = await tenant.versions.createDraft({
      id: "ver_seen",
      assistantId: "ast_1",
      config: defaultVersionConfig(),
      createdAt: 1000,
    });
    await tenant.versions.publishDraft("ast_1", draft.id, "ver_seen_2", 2000);
    const app = createTestApp();
    const load = async (headers: Record<string, string>) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request("https://engine.example/v1/assistants/pk_pub_1", { headers }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };

    // A load the origin check refuses is not the snippet on the owner's site.
    expect((await load({ origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await load({})).status).toBe(403);
    expect((await tenant.assistants.milestones("ast_1"))?.widgetSeenAt).toBeNull();

    expect((await load({ origin: "https://site.example" })).status).toBe(200);
    const first = (await tenant.assistants.milestones("ast_1"))?.widgetSeenAt;
    expect(first).toEqual(expect.any(Number));

    await new Promise((r) => setTimeout(r, 5));
    expect((await load({ origin: "https://site.example" })).status).toBe(200);
    expect((await tenant.assistants.milestones("ast_1"))?.widgetSeenAt).toBe(first);
  });

  it("still loads the widget when the first-load record cannot be written", async () => {
    const draft = await tenant.versions.createDraft({
      id: "ver_seen_fail",
      assistantId: "ast_1",
      config: defaultVersionConfig(),
      createdAt: 1000,
    });
    await tenant.versions.publishDraft("ast_1", draft.id, "ver_seen_fail_2", 2000);
    // Every statement works except the milestone write, which fails like D1 would.
    const failing = {
      prepare(sql: string) {
        if (sql.includes("SET widget_seen_at")) {
          return {
            bind: () => ({
              run: async () => {
                throw new Error("D1_ERROR: simulated");
              },
            }),
          };
        }
        return env.DB.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
    } as unknown as D1Database;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ctx = createExecutionContext();
      const res = await createTestApp().fetch(
        new Request("https://engine.example/v1/assistants/pk_pub_1", {
          headers: { origin: "https://site.example" },
        }),
        { ...env, DB: failing },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ title: expect.any(String) });
      expect(errorSpy).toHaveBeenCalledWith(
        "overview: milestone write failed",
        expect.objectContaining({ milestone: "widget_seen" }),
      );
      expect((await tenant.assistants.milestones("ast_1"))?.widgetSeenAt).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns 404 for an unknown key or a never-published assistant", async () => {
    await tenant.versions.createDraft({
      id: "ver_draft_only",
      assistantId: "ast_1",
      config: defaultVersionConfig(),
      createdAt: 1000,
    });

    const app = createTestApp();

    const ctx1 = createExecutionContext();
    const unknownRes = await app.fetch(
      new Request("https://engine.example/v1/assistants/pk_missing"),
      env,
      ctx1,
    );
    await waitOnExecutionContext(ctx1);
    expect(unknownRes.status).toBe(404);

    const ctx2 = createExecutionContext();
    const neverPubRes = await app.fetch(
      new Request("https://engine.example/v1/assistants/pk_pub_1", {
        headers: { origin: "https://site.example" },
      }),
      env,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);
    expect(neverPubRes.status).toBe(404);
  });

  it("returns the exact allow-listed key set and keeps draft-only changes invisible until publish", async () => {
    const base = defaultVersionConfig();
    base.widget = {
      title: "Published Title",
      accentColor: "#112233",
      position: "left",
    };
    base.behaviour = {
      greeting: "Published greeting",
      persona: "Secret owner persona",
      fallbackText: "Secret fallback",
      suggestedQuestions: ["How do I start?"],
      showSources: true,
    };
    base.actions = {
      builtins: true,
      allowedOrigins: ["https://shop.example"],
    };

    const draft = await tenant.versions.createDraft({
      id: "ver_1",
      assistantId: "ast_1",
      config: base,
      createdAt: 1000,
    });
    await tenant.versions.publishDraft("ast_1", draft.id, "ver_2", 2000);

    // Update draft only — should not appear on public config yet.
    const updatedDraft = defaultVersionConfig();
    updatedDraft.widget.title = "Draft Only Title";
    updatedDraft.actions = {
      builtins: false,
      allowedOrigins: ["https://draft-only.example"],
    };
    await tenant.versions.updateDraft("ast_1", updatedDraft);

    const app = createTestApp();
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://engine.example/v1/assistants/pk_pub_1", {
        headers: { origin: "https://site.example" },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://site.example");

    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "accentColor",
      "actions",
      "greeting",
      "position",
      "suggestedQuestions",
      "title",
    ]);
    expect(body).toEqual({
      title: "Published Title",
      accentColor: "#112233",
      position: "left",
      greeting: "Published greeting",
      suggestedQuestions: ["How do I start?"],
      actions: {
        builtins: true,
        allowedOrigins: ["https://shop.example"],
      },
    });

    // Publish the draft change and verify it becomes visible.
    await tenant.versions.publishDraft("ast_1", "ver_2", "ver_3", 3000);
    const ctx2 = createExecutionContext();
    const res2 = await app.fetch(
      new Request("https://engine.example/v1/assistants/pk_pub_1", {
        headers: { origin: "https://site.example" },
      }),
      env,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);

    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2.title).toBe("Draft Only Title");
    expect(body2.actions).toEqual({
      builtins: false,
      allowedOrigins: ["https://draft-only.example"],
    });
  });

  it("rejects missing or unlisted Origin with 403 before checking limits", async () => {
    const draft = await tenant.versions.createDraft({
      id: "ver_1",
      assistantId: "ast_1",
      config: defaultVersionConfig(),
      createdAt: 1000,
    });
    await tenant.versions.publishDraft("ast_1", draft.id, "ver_2", 2000);

    const limitsCheck = vi.fn(async () => ({ ok: true as const }));
    const app = createApp(fakeSeams({ limits: { check: limitsCheck } }));

    for (const headers of [undefined, { origin: "https://evil.example" }]) {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request("https://engine.example/v1/assistants/pk_pub_1", headers ? { headers } : {}),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(await res.json()).toEqual({ error: "This assistant is not available on this page." });
    }

    expect(limitsCheck).not.toHaveBeenCalled();
  });

  it("enforces rate limit and daily spend cap on GET requests", async () => {
    const draft = await tenant.versions.createDraft({
      id: "ver_1",
      assistantId: "ast_1",
      config: defaultVersionConfig(),
      createdAt: 1000,
    });
    await tenant.versions.publishDraft("ast_1", draft.id, "ver_2", 2000);

    for (const [reason, expectedMessage] of [
      ["rate_limit", "Too many requests just now. Please wait a moment."],
      ["spend_cap", "This assistant has reached its limit for today."],
    ] as const) {
      const limitsCheck = vi.fn(async () => ({ ok: false as const, reason }));
      const app = createApp(fakeSeams({ limits: { check: limitsCheck } }));

      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request("https://engine.example/v1/assistants/pk_pub_1", {
          headers: { origin: "https://site.example", "cf-connecting-ip": "1.2.3.4" },
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(429);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://site.example");
      expect(await res.json()).toEqual({ error: expectedMessage });
      // Its own action kind, so the seam can keep config reads off the
      // visitor's chat budget.
      expect(limitsCheck).toHaveBeenCalledWith(TEST_ORG_ID, "ast_1", {
        kind: "config",
        ip: "1.2.3.4",
      });
    }
  });

  it("leaves a visitor's questions untouched after many page loads with the open limits", async () => {
    const draft = await tenant.versions.createDraft({
      id: "ver_1",
      assistantId: "ast_1",
      config: defaultVersionConfig(),
      createdAt: 1000,
    });
    await tenant.versions.publishDraft("ast_1", draft.id, "ver_2", 2000);
    await env.DB.prepare("DELETE FROM rate_counters").run();

    // The open implementation, injected explicitly: the default test seams
    // allow everything and would pass whatever the counters did.
    const limits = basicLimits(env.DB);
    const app = createTestApp({ limits });
    const ip = "203.0.113.77";
    for (let i = 0; i < 25; i++) {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request("https://engine.example/v1/assistants/pk_pub_1", {
          headers: { origin: "https://site.example", "cf-connecting-ip": ip },
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
    }

    const chatHits = await env.DB.prepare(
      "SELECT COALESCE(SUM(hits), 0) AS hits FROM rate_counters WHERE org_id = ?1 AND ip = ?2",
    )
      .bind(TEST_ORG_ID, ip)
      .first<{ hits: number }>();
    expect(chatHits?.hits).toBe(0);

    // The page loads did count, against their own budget.
    const configHits = await env.DB.prepare(
      "SELECT COALESCE(SUM(hits), 0) AS hits FROM rate_counters WHERE org_id = ?1 AND ip = ?2",
    )
      .bind(TEST_ORG_ID, `config:${ip}`)
      .first<{ hits: number }>();
    expect(configHits?.hits).toBe(25);

    // 25 page loads exceed the 20-question budget, yet a question still passes.
    expect(await limits.check(TEST_ORG_ID, "ast_1", { kind: "chat", ip })).toEqual({ ok: true });
  });
});
