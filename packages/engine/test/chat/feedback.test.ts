import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { forPrincipal } from "../../src/db/tenant.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

const OTHER_ORG_ID = "org_other00000000000000";

describe("chat/feedback", () => {
  const tenantA = forPrincipal(env.DB, {
    orgId: TEST_ORG_ID,
    userId: "usr_a",
    role: "owner",
  });
  const tenantB = forPrincipal(env.DB, {
    orgId: OTHER_ORG_ID,
    userId: "usr_b",
    role: "owner",
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id = ?1").bind(OTHER_ORG_ID),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(OTHER_ORG_ID, "Other Org"),
    ]);

    await tenantA.assistants.create({
      id: "ast_a",
      name: "Bot A",
      publicKey: "pk_a",
      allowedOrigins: ["https://a.example"],
      createdAt: 1000,
    });
    await tenantA.conversations.create({
      id: "cnv_a",
      assistantId: "ast_a",
      visitorId: "vis_1",
      startedAt: 1000,
      pageUrl: "https://a.example",
    });
    await tenantA.messages.create({
      id: "msg_a",
      conversationId: "cnv_a",
      role: "assistant",
      content: "Answer A",
      citations: [],
      toolCalls: null,
      tokensIn: 10,
      tokensOut: 5,
      answered: true,
      createdAt: 1000,
    });

    await tenantB.assistants.create({
      id: "ast_b",
      name: "Bot B",
      publicKey: "pk_b",
      allowedOrigins: ["https://b.example"],
      createdAt: 1000,
    });
    await tenantB.conversations.create({
      id: "cnv_b",
      assistantId: "ast_b",
      visitorId: "vis_1",
      startedAt: 1000,
      pageUrl: "https://b.example",
    });
    await tenantB.messages.create({
      id: "msg_b",
      conversationId: "cnv_b",
      role: "assistant",
      content: "Answer B",
      citations: [],
      toolCalls: null,
      tokensIn: 10,
      tokensOut: 5,
      answered: true,
      createdAt: 1000,
    });
  });

  it("writes up and down votes, replaces same-visitor votes, and keeps separate visitors as separate rows", async () => {
    const app = createTestApp();

    const post = async (body: unknown, origin = "https://a.example") => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request("https://engine.example/v1/feedback", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify(body),
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };

    const r1 = await post({
      messageId: "msg_a",
      visitorId: "vis_1",
      value: "up",
      note: "great",
    });
    expect(r1.status).toBe(200);
    expect(r1.headers.get("access-control-allow-origin")).toBe("https://a.example");

    // Second vote by same visitor replaces instead of stacking.
    const r2 = await post({
      messageId: "msg_a",
      visitorId: "vis_1",
      value: "down",
      note: "actually wrong",
    });
    expect(r2.status).toBe(200);

    // Different visitor adds a new row.
    const r3 = await post({
      messageId: "msg_a",
      visitorId: "vis_2",
      value: "up",
    });
    expect(r3.status).toBe(200);

    const rows = await tenantA.feedback.listForMessage("msg_a");
    expect(rows).toHaveLength(2);
    const vis1 = rows.find((r) => r.visitorId === "vis_1");
    const vis2 = rows.find((r) => r.visitorId === "vis_2");
    expect(vis1?.value).toBe("down");
    expect(vis1?.note).toBe("actually wrong");
    expect(vis2?.value).toBe("up");
  });

  it("rejects a messageId from another assistant/org and enforces the origin check", async () => {
    const app = createTestApp();

    // Missing Origin
    const ctxMissing = createExecutionContext();
    const missingRes = await app.fetch(
      new Request("https://engine.example/v1/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: "msg_a", visitorId: "vis_1", value: "up" }),
      }),
      env,
      ctxMissing,
    );
    await waitOnExecutionContext(ctxMissing);
    expect(missingRes.status).toBe(403);

    // messageId from org B sent from org A's origin
    const ctxCross = createExecutionContext();
    const crossRes = await app.fetch(
      new Request("https://engine.example/v1/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://a.example" },
        body: JSON.stringify({ messageId: "msg_b", visitorId: "vis_1", value: "up" }),
      }),
      env,
      ctxCross,
    );
    await waitOnExecutionContext(ctxCross);
    expect(crossRes.status).toBe(403);
    expect(await tenantB.feedback.listForMessage("msg_b")).toHaveLength(0);

    // Non-existent messageId
    const ctxUnknown = createExecutionContext();
    const unknownRes = await app.fetch(
      new Request("https://engine.example/v1/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://a.example" },
        body: JSON.stringify({ messageId: "msg_does_not_exist", visitorId: "vis_1", value: "up" }),
      }),
      env,
      ctxUnknown,
    );
    await waitOnExecutionContext(ctxUnknown);
    expect(unknownRes.status).toBe(404);
  });
});
