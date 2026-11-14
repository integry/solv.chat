import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { defaultVersionConfig, parseChatEventLine } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { MAX_TURNS } from "../../src/chat/prompt.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { LlmProvider, LlmRequest } from "../../src/providers/types.js";
import { usageDaily } from "../../src/seams/open/usageDaily.js";
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

describe("chat/persistence", () => {
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
      publicKey: "pk_pers_1",
      allowedOrigins: ["https://site.example"],
      createdAt: 1000,
    });
    const draft = await tenant.versions.createDraft({
      id: "ver_1",
      assistantId: "ast_1",
      config: defaultVersionConfig(),
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
      externalId: "docs/billing",
      url: "https://site.example/docs/billing",
      title: "Billing",
      contentHash: "hash_1",
      updatedAt: 1000,
    });
    await tenant.documents.replaceChunks("doc_1", [
      { id: "chk_1", ordinal: 0, text: "Invoices are sent monthly.", headingPath: "Billing" },
    ]);

    const [vec] = await embedder.embed(["How does billing work?"]);
    await retriever.upsert([
      {
        chunkId: "chk_1",
        vector: vec ?? [],
        orgId: TEST_ORG_ID,
        assistantId: "ast_1",
      },
    ]);
  });

  it("persists conversation, two messages, citations, token counts, and usage_daily with non-zero cost_micros", async () => {
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.balanced.id,
      async *stream() {
        yield { kind: "text", text: "Invoices are sent monthly." };
        yield { kind: "usage", tokensIn: 1200, tokensOut: 300 };
      },
    };

    const app = createApp(
      fakeSeams({
        usage: usageDaily(env.DB),
      }),
      {
        chat: {
          embedder,
          retriever,
          provider,
          model: ANTHROPIC_MODELS.balanced,
        },
      },
    );

    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_pers_1",
          visitorId: "vis_1",
          message: "How does billing work?",
          pageUrl: "https://site.example/pricing",
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const events = parseSseBody(await res.text());
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type !== "done") return;

    const convs = await tenant.conversations.list("ast_1");
    expect(convs).toHaveLength(1);
    expect(convs[0]?.id).toBe(done.conversationId);
    expect(convs[0]?.pageUrl).toBe("https://site.example/pricing");

    const msgs = await tenant.messages.list(done.conversationId);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content).toBe("How does billing work?");
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[1]?.id).toBe(done.messageId);
    expect(msgs[1]?.citations).toEqual([
      { url: "https://site.example/docs/billing", title: "Billing" },
    ]);
    expect(msgs[1]?.tokensIn).toBe(1200);
    expect(msgs[1]?.tokensOut).toBe(300);

    const usageRow = await env.DB.prepare(
      "SELECT messages, tokens_in, tokens_out, cost_micros FROM usage_daily WHERE org_id = ?1 AND assistant_id = ?2",
    )
      .bind(TEST_ORG_ID, "ast_1")
      .first<{ messages: number; tokens_in: number; tokens_out: number; cost_micros: number }>();
    expect(usageRow).not.toBeNull();
    expect(usageRow?.messages).toBe(1);
    expect(usageRow?.tokens_in).toBe(1200);
    expect(usageRow?.tokens_out).toBe(300);
    expect(usageRow?.cost_micros).toBeGreaterThan(0);
  });

  it("reuses the conversation on subsequent messages and passes prior turns capped at 6", async () => {
    const seenRequests: LlmRequest[] = [];
    let turn = 0;
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.balanced.id,
      async *stream(req) {
        seenRequests.push(req);
        turn += 1;
        yield { kind: "text", text: `reply-${turn}` };
        yield { kind: "usage", tokensIn: 100, tokensOut: 20 };
      },
    };

    const app = createApp(fakeSeams(), {
      chat: { embedder, retriever, provider },
    });

    let conversationId: string | undefined;
    for (let i = 1; i <= 5; i++) {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request("https://engine.example/v1/chat", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://site.example" },
          body: JSON.stringify({
            protocol: 1,
            assistant: "pk_pers_1",
            visitorId: "vis_1",
            conversationId,
            message: `How does billing work?`,
          }),
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      const events = parseSseBody(await res.text());
      const done = events.find((e) => e.type === "done");
      if (done?.type === "done") {
        conversationId = done.conversationId;
      }
    }

    const convs = await tenant.conversations.list("ast_1");
    expect(convs).toHaveLength(1);
    if (!conversationId) throw new Error("expected conversationId");
    const msgs = await tenant.messages.list(conversationId);
    expect(msgs).toHaveLength(10);

    // On the 5th request, there were 8 prior messages; history is capped at MAX_TURNS (6),
    // plus 1 current user message = 7 messages in the LlmRequest.
    const fifthReq = seenRequests[4];
    expect(fifthReq?.messages).toHaveLength(MAX_TURNS + 1);
  });

  it("persists assistant message and usage when the client cancels after the first token", async () => {
    let releaseNextChunk!: () => void;
    const waitForNextChunk = new Promise<void>((resolve) => {
      releaseNextChunk = resolve;
    });

    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.balanced.id,
      async *stream() {
        yield { kind: "text", text: "First " };
        await waitForNextChunk;
        yield { kind: "text", text: "Second." };
        yield { kind: "usage", tokensIn: 900, tokensOut: 150 };
      },
    };

    const app = createApp(
      fakeSeams({
        usage: usageDaily(env.DB),
      }),
      {
        chat: {
          embedder,
          retriever,
          provider,
          model: ANTHROPIC_MODELS.balanced,
        },
      },
    );

    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_pers_1",
          visitorId: "vis_1",
          message: "How does billing work?",
        }),
      }),
      env,
      ctx,
    );

    if (!res.body) throw new Error("expected response body");
    const reader = res.body.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    const firstText = new TextDecoder().decode(firstChunk.value);
    expect(firstText).toContain("First ");

    await reader.cancel();
    releaseNextChunk();
    await waitOnExecutionContext(ctx);

    const convs = await tenant.conversations.list("ast_1");
    expect(convs).toHaveLength(1);
    const convId = convs[0]?.id;
    if (!convId) throw new Error("expected conversation");

    const msgs = await tenant.messages.list(convId);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[1]?.content).toBe("First Second.");
    expect(msgs[1]?.tokensIn).toBe(900);
    expect(msgs[1]?.tokensOut).toBe(150);

    const usageRow = await env.DB.prepare(
      "SELECT messages, tokens_in, tokens_out, cost_micros FROM usage_daily WHERE org_id = ?1 AND assistant_id = ?2",
    )
      .bind(TEST_ORG_ID, "ast_1")
      .first<{ messages: number; tokens_in: number; tokens_out: number; cost_micros: number }>();
    expect(usageRow).not.toBeNull();
    expect(usageRow?.messages).toBe(1);
    expect(usageRow?.tokens_in).toBe(900);
    expect(usageRow?.tokens_out).toBe(150);
    expect(usageRow?.cost_micros).toBeGreaterThan(0);
  });
});
