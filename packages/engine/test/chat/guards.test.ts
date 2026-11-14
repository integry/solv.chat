import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { parseChatEventLine } from "@solvchat/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

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
    expect(authSpy).not.toHaveBeenCalled();
    expect(limitsSpy).not.toHaveBeenCalled();
    expect(keysSpy).not.toHaveBeenCalled();
    expect(usageSpy).not.toHaveBeenCalled();
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

    expect(post.headers.get("access-control-allow-origin")).toBe("https://site.example");
    expect(post.headers.get("access-control-allow-origin")).not.toBe("*");
  });
});
