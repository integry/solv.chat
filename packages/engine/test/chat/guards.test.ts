import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { parseChatEventLine } from "@solvchat/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { directoryResolveOrg, fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

function parseSseBody(text: string) {
  return text
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const name =
        lines
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim() ?? "";
      const data =
        lines
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim() ?? "";
      return parseChatEventLine(name, data);
    });
}

describe("chat/guards", () => {
  const tenant = forPrincipal(env.DB, {
    orgId: TEST_ORG_ID,
    userId: "usr_1",
    role: "owner",
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
    ]);

    await tenant.assistants.create({
      id: "ast_1",
      name: "Docs",
      publicKey: "pk_test_1",
      allowedOrigins: ["https://site.example"],
      createdAt: 1000,
    });
    const draft = await tenant.versions.createDraft({
      id: "ver_1",
      assistantId: "ast_1",
      config: {
        behaviour: {
          greeting: "Hi",
          persona: "",
          fallbackText: "Not found.",
          suggestedQuestions: [],
        },
        widget: {
          title: "Docs",
          accentColor: "#2563eb",
          position: "right",
        },
        limits: { dailyCostCapMicros: 2_000_000 },
        allowedTools: [],
        actions: { builtins: false, allowedOrigins: [] },
      },
      createdAt: 1000,
    });
    await tenant.versions.publishDraft("ast_1", draft.id, "ver_2", 2000);
  });

  it("rejects missing or unlisted Origin with a single error event and zero embedder/provider calls", async () => {
    const embedSpy = vi.fn(fakeEmbedder().embed);
    const streamSpy = vi.fn();
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.balanced.id,
      async *stream() {
        streamSpy();
        yield { kind: "text", text: "nope" };
      },
    };
    const app = createApp(fakeSeams(), {
      chat: {
        embedder: { dimensions: 1536, embed: embedSpy },
        retriever: memoryRetriever(),
        provider,
      },
    });

    for (const headers of [
      { "content-type": "application/json" },
      { "content-type": "application/json", origin: "https://evil.example" },
    ]) {
      const ctx = createExecutionContext();
      const response = await app.fetch(
        new Request("https://engine.example/v1/chat", {
          method: "POST",
          headers,
          body: JSON.stringify({
            protocol: 1,
            assistant: "pk_test_1",
            visitorId: "vis_1",
            message: "Hello?",
          }),
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);

      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      const events = parseSseBody(await response.text());
      expect(events).toEqual([
        { type: "error", message: "This assistant is not available on this page." },
      ]);
    }

    expect(embedSpy).not.toHaveBeenCalled();
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("enforces order: wrong Origin fails before limits.check, embedder, or provider", async () => {
    const limitsCheck = vi.fn(async () => ({ ok: false as const, reason: "rate_limit" as const }));
    const embedSpy = vi.fn(fakeEmbedder().embed);
    const streamSpy = vi.fn();
    const app = createApp(
      fakeSeams({
        limits: { check: limitsCheck },
      }),
      {
        chat: {
          embedder: { dimensions: 1536, embed: embedSpy },
          retriever: memoryRetriever(),
          provider: {
            name: "anthropic",
            model: ANTHROPIC_MODELS.balanced.id,
            async *stream() {
              streamSpy();
              yield { kind: "text", text: "nope" };
            },
          },
        },
      },
    );

    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://wrong.example",
        },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_test_1",
          visitorId: "vis_1",
          message: "Hello?",
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const events = parseSseBody(await response.text());
    expect(events).toEqual([
      { type: "error", message: "This assistant is not available on this page." },
    ]);
    expect(limitsCheck).not.toHaveBeenCalled();
    expect(embedSpy).not.toHaveBeenCalled();
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("returns an error event with zero embedder/provider calls on rate_limit and spend_cap", async () => {
    for (const reason of ["rate_limit", "spend_cap"] as const) {
      const embedSpy = vi.fn(fakeEmbedder().embed);
      const streamSpy = vi.fn();
      const app = createApp(
        fakeSeams({
          limits: {
            async check() {
              return { ok: false, reason };
            },
          },
        }),
        {
          chat: {
            embedder: { dimensions: 1536, embed: embedSpy },
            retriever: memoryRetriever(),
            provider: {
              name: "anthropic",
              model: ANTHROPIC_MODELS.balanced.id,
              async *stream() {
                streamSpy();
                yield { kind: "text", text: "nope" };
              },
            },
          },
        },
      );

      const ctx = createExecutionContext();
      const response = await app.fetch(
        new Request("https://engine.example/v1/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://site.example",
          },
          body: JSON.stringify({
            protocol: 1,
            assistant: "pk_test_1",
            visitorId: "vis_1",
            message: "Hello?",
          }),
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);

      expect(response.headers.get("access-control-allow-origin")).toBe("https://site.example");
      const events = parseSseBody(await response.text());
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("error");
      expect(embedSpy).not.toHaveBeenCalled();
      expect(streamSpy).not.toHaveBeenCalled();
    }
  });

  it("rejects unsupported protocol with an error event naming supported versions and makes zero seam calls", async () => {
    const authSpy = vi.fn(async () => null);
    const limitsSpy = vi.fn(async () => ({ ok: true as const }));
    const keysSpy = vi.fn(async () => "unused");
    const usageSpy = vi.fn(async () => {});

    const app = createApp({
      auth: {
        authenticate: authSpy,
        login: async () => Response.json({ ok: true }),
        logout: async () => Response.json({ ok: true }),
        // Only finds the key's org, so the error event can carry CORS
        // headers for an allowed site; nothing billable or limited runs.
        resolveOrg: directoryResolveOrg,
      },
      limits: { check: limitsSpy },
      keys: { modelKey: keysSpy, embeddingKey: keysSpy },
      usage: { record: usageSpy },
    });

    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://site.example",
        },
        body: JSON.stringify({
          protocol: 99,
          assistant: "pk_test_1",
          visitorId: "vis_1",
          message: "Hello?",
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const events = parseSseBody(await response.text());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    if (events[0]?.type === "error") {
      expect(events[0].message).toContain("1");
    }
    expect(response.headers.get("access-control-allow-origin")).toBe("https://site.example");
    expect(response.headers.get("vary")).toBe("Origin");
    expect(authSpy).not.toHaveBeenCalled();
    expect(limitsSpy).not.toHaveBeenCalled();
    expect(keysSpy).not.toHaveBeenCalled();
    expect(usageSpy).not.toHaveBeenCalled();

    // Disallowed origin with unsupported protocol must not receive CORS headers.
    const evilCtx = createExecutionContext();
    const evilResponse = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({
          protocol: 99,
          assistant: "pk_test_1",
          visitorId: "vis_1",
          message: "Hello?",
        }),
      }),
      env,
      evilCtx,
    );
    await waitOnExecutionContext(evilCtx);
    expect(evilResponse.headers.get("access-control-allow-origin")).toBeNull();
    expect(parseSseBody(await evilResponse.text())[0]).toMatchObject({ type: "error" });
  });

  it("echoes matched Access-Control-Allow-Origin (never *) and handles OPTIONS preflight", async () => {
    const app = createApp(fakeSeams(), {
      chat: {
        embedder: fakeEmbedder(),
        retriever: memoryRetriever(),
        provider: {
          name: "anthropic",
          model: ANTHROPIC_MODELS.balanced.id,
          async *stream() {
            yield { kind: "text", text: "ok" };
          },
        },
      },
    });

    const preflightCtx = createExecutionContext();
    const preflight = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "OPTIONS",
        headers: { origin: "https://site.example" },
      }),
      env,
      preflightCtx,
    );
    await waitOnExecutionContext(preflightCtx);

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://site.example");
    expect(preflight.headers.get("access-control-allow-origin")).not.toBe("*");

    const postCtx = createExecutionContext();
    const post = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://site.example",
        },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_test_1",
          visitorId: "vis_1",
          message: "Hello?",
        }),
      }),
      env,
      postCtx,
    );
    await waitOnExecutionContext(postCtx);
    await post.text();

    expect(post.headers.get("access-control-allow-origin")).toBe("https://site.example");
    expect(post.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it.each(["/v1/chat", "/v1/feedback"])(
    "%s preflight echoes only an Origin that some assistant allows",
    async (path) => {
      const app = createApp(fakeSeams());
      const ask = async (origin: string) => {
        const ctx = createExecutionContext();
        const res = await app.fetch(
          new Request(`https://engine.example${path}`, { method: "OPTIONS", headers: { origin } }),
          env,
          ctx,
        );
        await waitOnExecutionContext(ctx);
        return res;
      };

      const allowed = await ask("https://site.example");
      expect(allowed.status).toBe(204);
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://site.example");

      const other = await ask("https://evil.example");
      expect(other.status).toBe(204);
      expect(other.headers.get("access-control-allow-origin")).toBeNull();

      // The preflight reads the origins index, which follows every change to
      // an allow-list at once, and forgets a deleted assistant.
      await tenant.assistants.update("ast_1", {
        name: "Docs",
        allowedOrigins: ["https://new.example"],
      });
      expect((await ask("https://new.example")).headers.get("access-control-allow-origin")).toBe(
        "https://new.example",
      );
      expect(
        (await ask("https://site.example")).headers.get("access-control-allow-origin"),
      ).toBeNull();
      await tenant.assistants.remove("ast_1");
      expect(
        (await ask("https://new.example")).headers.get("access-control-allow-origin"),
      ).toBeNull();
    },
  );

  it.each(["/v1/assistants/%E0%A4%A", "/v1/ingest/%E0%A4%A/documents"])(
    "answers 404 for malformed percent-encoding in %s",
    async (path) => {
      const app = createApp(fakeSeams());
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`https://engine.example${path}`), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(404);
    },
  );

  it("rejects action resumption requests (with or without message) on both /v1/chat and /api/admin/chat", async () => {
    const embedSpy = vi.fn(fakeEmbedder().embed);
    const streamSpy = vi.fn();
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.balanced.id,
      async *stream() {
        streamSpy();
        yield { kind: "text", text: "nope" };
      },
    };
    const app = createApp(fakeSeams(), {
      chat: {
        embedder: { dimensions: 1536, embed: embedSpy },
        retriever: memoryRetriever(),
        provider,
      },
    });

    const cases = [
      {
        name: "without message",
        body: {
          protocol: 2,
          assistant: "pk_test_1",
          visitorId: "vis_1",
          resumeMessageId: "msg_1",
          actionResults: [{ callId: "call_1", ok: true, result: "{}" }],
        },
      },
      {
        name: "with message",
        body: {
          protocol: 2,
          assistant: "pk_test_1",
          visitorId: "vis_1",
          message: "Continue",
          resumeMessageId: "msg_1",
          actionResults: [{ callId: "call_1", ok: true, result: "{}" }],
        },
      },
    ];

    for (const testCase of cases) {
      // Public route (/v1/chat)
      const publicCtx = createExecutionContext();
      const publicRes = await app.fetch(
        new Request("https://engine.example/v1/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://site.example",
          },
          body: JSON.stringify(testCase.body),
        }),
        env,
        publicCtx,
      );
      await waitOnExecutionContext(publicCtx);

      expect(publicRes.status, `public ${testCase.name}`).toBe(200);
      expect(publicRes.headers.get("access-control-allow-origin")).toBe("https://site.example");
      expect(parseSseBody(await publicRes.text())).toEqual([
        { type: "error", message: "This answer can no longer be continued." },
      ]);

      // Admin preview route (/api/admin/chat)
      const adminCtx = createExecutionContext();
      const adminRes = await app.fetch(
        new Request("https://engine.example/api/admin/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://engine.example",
          },
          body: JSON.stringify(testCase.body),
        }),
        env,
        adminCtx,
      );
      await waitOnExecutionContext(adminCtx);

      expect(adminRes.status, `admin ${testCase.name}`).toBe(200);
      expect(parseSseBody(await adminRes.text())).toEqual([
        { type: "error", message: "Resuming actions is not supported yet." },
      ]);
    }

    expect(embedSpy).not.toHaveBeenCalled();
    expect(streamSpy).not.toHaveBeenCalled();
    const convCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM conversations").first<{
      n: number;
    }>();
    expect(convCount?.n).toBe(0);
  });
});
