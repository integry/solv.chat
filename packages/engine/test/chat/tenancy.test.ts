import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { defaultVersionConfig, parseChatEventLine } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { LlmProvider, LlmRequest } from "../../src/providers/types.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";

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

describe("chat/tenancy", () => {
  const tenantA = forPrincipal(env.DB, {
    orgId: TEST_ORG_ID,
    userId: "usr_a",
    role: "owner",
  });
  const tenantB = forPrincipal(env.DB, {
    orgId: ORG_B,
    userId: "usr_b",
    role: "owner",
  });
  const embedder = fakeEmbedder();
  let retriever = memoryRetriever();

  beforeEach(async () => {
    retriever = memoryRetriever();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id = ?1").bind(ORG_B),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);

    // Seed Org A
    await tenantA.assistants.create({
      id: "ast_a",
      name: "Bot A",
      publicKey: "pk_org_a",
      allowedOrigins: ["https://a.example"],
      createdAt: 1000,
    });
    const draftA = await tenantA.versions.createDraft({
      id: "ver_a1",
      assistantId: "ast_a",
      config: defaultVersionConfig(),
      createdAt: 1000,
    });
    await tenantA.versions.publishDraft("ast_a", draftA.id, "ver_a2", 2000);
    await tenantA.sources.create({
      id: "src_a",
      assistantId: "ast_a",
      kind: "push",
      label: "CLI",
      settings: {},
      createdAt: 1000,
    });
    await tenantA.documents.upsert({
      id: "doc_a",
      sourceId: "src_a",
      externalId: "secret-a",
      url: "https://a.example/secret-a",
      title: "Secret A",
      contentHash: "hash_a",
      updatedAt: 1000,
    });
    await tenantA.documents.replaceChunks("doc_a", [
      { id: "chk_a", ordinal: 0, text: "ORG_A_CONFIDENTIAL", headingPath: "A" },
    ]);

    // Seed Org B
    await tenantB.assistants.create({
      id: "ast_b",
      name: "Bot B",
      publicKey: "pk_org_b",
      allowedOrigins: ["https://b.example"],
      createdAt: 1000,
    });
    const draftB = await tenantB.versions.createDraft({
      id: "ver_b1",
      assistantId: "ast_b",
      config: defaultVersionConfig(),
      createdAt: 1000,
    });
    await tenantB.versions.publishDraft("ast_b", draftB.id, "ver_b2", 2000);
    await tenantB.sources.create({
      id: "src_b",
      assistantId: "ast_b",
      kind: "push",
      label: "CLI",
      settings: {},
      createdAt: 1000,
    });
    await tenantB.documents.upsert({
      id: "doc_b",
      sourceId: "src_b",
      externalId: "secret-b",
      url: "https://b.example/secret-b",
      title: "Secret B",
      contentHash: "hash_b",
      updatedAt: 1000,
    });
    await tenantB.documents.replaceChunks("doc_b", [
      { id: "chk_b", ordinal: 0, text: "ORG_B_CONFIDENTIAL", headingPath: "B" },
    ]);
    await tenantB.conversations.create({
      id: "cnv_b_existing",
      assistantId: "ast_b",
      visitorId: "vis_b",
      startedAt: 1000,
      pageUrl: "https://b.example",
    });
    await tenantB.messages.create({
      id: "msg_b_secret",
      conversationId: "cnv_b_existing",
      role: "user",
      content: "ORG_B_PRIVATE_QUESTION",
      citations: [],
      toolCalls: null,
      tokensIn: 0,
      tokensOut: 0,
      answered: true,
      createdAt: 1000,
    });

    const [vec] = await embedder.embed(["shared question"]);
    await retriever.upsert([
      { chunkId: "chk_a", vector: vec ?? [], orgId: TEST_ORG_ID, assistantId: "ast_a" },
      { chunkId: "chk_b", vector: vec ?? [], orgId: ORG_B, assistantId: "ast_b" },
    ]);
  });

  it("prevents org A public key from retrieving org B chunks or reading org B messages, and vice versa", async () => {
    const prompts: LlmRequest[] = [];
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.balanced.id,
      async *stream(req) {
        prompts.push(req);
        yield { kind: "text", text: "ok" };
        yield { kind: "usage", tokensIn: 10, tokensOut: 2 };
      },
    };

    const app = createApp(fakeSeams(), {
      chat: { embedder, retriever, provider },
    });

    // Org A tries to pass Org B's conversationId while querying pk_org_a
    const ctxA = createExecutionContext();
    const resA = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://a.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_org_a",
          visitorId: "vis_1",
          conversationId: "cnv_b_existing",
          message: "shared question",
        }),
      }),
      env,
      ctxA,
    );
    await waitOnExecutionContext(ctxA);
    const eventsA = parseSseBody(await resA.text());
    expect(eventsA.some((e) => e.type === "citation" && e.url.includes("b.example"))).toBe(false);
    expect(JSON.stringify(prompts[0])).toContain("ORG_A_CONFIDENTIAL");
    expect(JSON.stringify(prompts[0])).not.toContain("ORG_B_CONFIDENTIAL");
    expect(JSON.stringify(prompts[0])).not.toContain("ORG_B_PRIVATE_QUESTION");

    // Org B queries pk_org_b — never sees Org A's chunks
    const ctxB = createExecutionContext();
    const resB = await app.fetch(
      new Request("https://engine.example/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://b.example" },
        body: JSON.stringify({
          protocol: 1,
          assistant: "pk_org_b",
          visitorId: "vis_2",
          message: "shared question",
        }),
      }),
      env,
      ctxB,
    );
    await waitOnExecutionContext(ctxB);
    const eventsB = parseSseBody(await resB.text());
    expect(eventsB.some((e) => e.type === "citation" && e.url.includes("a.example"))).toBe(false);
    expect(JSON.stringify(prompts[1])).toContain("ORG_B_CONFIDENTIAL");
    expect(JSON.stringify(prompts[1])).not.toContain("ORG_A_CONFIDENTIAL");
  });
});
