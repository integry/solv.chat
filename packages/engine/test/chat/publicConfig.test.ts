import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { defaultVersionConfig } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { forPrincipal } from "../../src/db/tenant.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

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
      new Request("https://engine.example/v1/assistants/pk_pub_1"),
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
    });

    // Publish the draft change and verify it becomes visible.
    await tenant.versions.publishDraft("ast_1", "ver_2", "ver_3", 3000);
    const ctx2 = createExecutionContext();
    const res2 = await app.fetch(
      new Request("https://engine.example/v1/assistants/pk_pub_1"),
      env,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);

    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2.title).toBe("Draft Only Title");
  });
});
