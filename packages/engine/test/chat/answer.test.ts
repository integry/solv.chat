import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { defaultVersionConfig, parseChatEventLine } from "@solvchat/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import { ProviderError } from "../../src/providers/error.js";
import type { LlmProvider, LlmRequest } from "../../src/providers/types.js";
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

describe("chat/answer", () => {
  const tenant = forPrincipal(env.DB, {
    orgId: TEST_ORG_ID,
    userId: "usr_1",
    role: "owner",
  });
  const embedder = fakeEmbedder();
  let retriever = memoryRetriever();

  beforeEach(async () => {
    retriever = memoryRetriever();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_daily"),
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
      name: "Docs Bot",
      publicKey: "pk_ans_1",
      allowedOrigins: ["https://site.example"],
      createdAt: 1000,
    });

    const pubConfig = defaultVersionConfig();
    pubConfig.behaviour.persona = "Published persona";
    pubConfig.behaviour.fallbackText = "Published fallback";
    const draft = await tenant.versions.createDraft({
      id: "ver_1",
      assistantId: "ast_1",
      config: pubConfig,
      createdAt: 1000,
    });
    await tenant.versions.publishDraft("ast_1", draft.id, "ver_2", 2000);

    await tenant.sources.create({
      id: "src_1",
      assistantId: "ast_1",
      kind: "push",
      label: "CLI",
      settings: {},
      createdAt: 1000,
    });
    await tenant.documents.upsert({
      id: "doc_1",
      sourceId: "src_1",
      externalId: "docs/reset",
      url: "https://site.example/docs/reset",
      title: "Reset Password",
      contentHash: "hash_1",
      updatedAt: 1000,
    });
    await tenant.documents.replaceChunks("doc_1", [
      { id: "chk_1", ordinal: 0, text: "Click Forgot Password to reset.", headingPath: "Reset" },
    ]);

    const [vec] = await embedder.embed(["How do I reset my password?"]);
    await retriever.upsert([
      {
        chunkId: "chk_1",
        vector: vec ?? [],
        orgId: TEST_ORG_ID,
        assistantId: "ast_1",
      },
    ]);
  });

  it("streams token* -> citation* -> done incrementally from a seeded retriever", async () => {
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.balanced.id,
      async *stream() {
        yield { kind: "text", text: "Click " };
        await new Promise((r) => setTimeout(r, 15));
        yield { kind: "text", text: "Forgot Password." };
        yield { kind: "usage", tokensIn: 100, tokensOut: 20 };
      },
    };

    const app = createApp(fakeSeams(), {
      chat: { embedder, retriever, provider },
    });

    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "How do I reset my password?",
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    const rawParts: string[] = [];
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      rawParts.push(decoder.decode(value, { stream: true }));
    }
    await waitOnExecutionContext(ctx);

    // Tokens arrived in multiple stream reads rather than buffered into one.
    expect(rawParts.length).toBeGreaterThan(1);

    const events = parseSseBody(rawParts.join(""));
    expect(events.map((e) => e.type)).toEqual(["token", "token", "citation", "done"]);
    expect(events[0]).toEqual({ type: "token", text: "Click " });
    expect(events[1]).toEqual({ type: "token", text: "Forgot Password." });
    expect(events[2]).toEqual({
      type: "citation",
      url: "https://site.example/docs/reset",
      title: "Reset Password",
    });
    expect(events[3]?.type).toBe("done");
  });

  it("streams fallbackText, stores answered = 0, and never calls provider when retriever returns nothing", async () => {
    const streamSpy = vi.fn();
    const emptyRetriever = memoryRetriever();
    const app = createApp(fakeSeams(), {
      chat: {
        embedder,
        retriever: emptyRetriever,
        provider: {
          name: "anthropic",
          model: ANTHROPIC_MODELS.balanced.id,
          async *stream() {
            streamSpy();
            yield { kind: "text", text: "should not run" };
          },
        },
      },
    });

    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "Unanswered question?",
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(streamSpy).not.toHaveBeenCalled();
    const events = parseSseBody(await res.text());
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "token", text: "Published fallback" });
    expect(events[1]?.type).toBe("done");

    const gaps = await tenant.messages.unanswered("ast_1");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.answered).toBe(false);
    expect(gaps[0]?.content).toBe("Published fallback");
  });

  it("emits an error event on mid-stream ProviderError and still persists the visitor message", async () => {
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.balanced.id,
      async *stream() {
        yield { kind: "text", text: "Partial " };
        throw new ProviderError("upstream reset", true, 502);
      },
    };

    const app = createApp(fakeSeams(), {
      chat: { embedder, retriever, provider },
    });

    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "How do I reset my password?",
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const events = parseSseBody(await res.text());
    expect(events.map((e) => e.type)).toEqual(["token", "error"]);

    const convs = await tenant.conversations.list("ast_1");
    expect(convs).toHaveLength(1);
    const conv = convs[0];
    if (!conv) throw new Error("expected conversation");
    const msgs = await tenant.messages.list(conv.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content).toBe("How do I reset my password?");
  });

  it("answers from draft when target='draft' with an owner session, and from published without a session", async () => {
    const draftConfig = defaultVersionConfig();
    draftConfig.behaviour.persona = "Draft-only persona";
    await tenant.versions.updateDraft("ast_1", draftConfig);

    const seenSystems: string[] = [];
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.balanced.id,
      async *stream(req: LlmRequest) {
        seenSystems.push(req.system);
        yield { kind: "text", text: "ok" };
        yield { kind: "usage", tokensIn: 10, tokensOut: 2 };
      },
    };

    // With owner session -> uses draft
    const appWithAuth = createApp(fakeSeams(), {
      chat: { embedder, retriever, provider },
    });
    const ctx1 = createExecutionContext();
    const res1 = await appWithAuth.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "How do I reset my password?",
          target: "draft",
        }),
      }),
      env,
      ctx1,
    );
    await res1.text();
    await waitOnExecutionContext(ctx1);

    // Without session -> ignores target='draft' and uses published
    const appNoAuth = createApp(
      fakeSeams({
        auth: {
          authenticate: async () => null,
          login: async () => Response.json({ ok: true }),
          logout: async () => Response.json({ ok: true }),
        },
      }),
      {
        chat: { embedder, retriever, provider },
      },
    );
    const ctx2 = createExecutionContext();
    const res2 = await appNoAuth.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_ans_1",
          visitorId: "vis_1",
          message: "How do I reset my password?",
          target: "draft",
        }),
      }),
      env,
      ctx2,
    );
    expect(res2.status).toBe(200);
    await res2.text();
    await waitOnExecutionContext(ctx2);

    expect(seenSystems[0]).toContain("Draft-only persona");
    expect(seenSystems[1]).toContain("Published persona");
    expect(seenSystems[1]).not.toContain("Draft-only persona");
  });
});
