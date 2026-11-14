import { env } from "cloudflare:test";
import { defaultVersionConfig } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { forPrincipal, type Tenant } from "../../src/db/tenant.js";

const ORG_A = "org_00000000000000000000";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";

describe("db/cascading parent deletions", () => {
  const tenantA: Tenant = forPrincipal(env.DB, {
    orgId: ORG_A,
    userId: "usr_a",
    role: "owner",
  });
  const tenantB: Tenant = forPrincipal(env.DB, {
    orgId: ORG_B,
    userId: "usr_b",
    role: "owner",
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM test_runs"),
      env.DB.prepare("DELETE FROM tests"),
      env.DB.prepare("DELETE FROM mcp_tools"),
      env.DB.prepare("DELETE FROM mcp_servers"),
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  async function seedDocumentWithChunks(tenant: Tenant, suffix: string) {
    await tenant.assistants.create({
      id: `ast_${suffix}`,
      name: `Assistant ${suffix}`,
      publicKey: `pk_${suffix}`,
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenant.sources.create({
      id: `src_${suffix}`,
      assistantId: `ast_${suffix}`,
      kind: "push",
      label: `Docs ${suffix}`,
      settings: {},
      createdAt: 1000,
    });
    await tenant.documents.upsert({
      id: `doc_${suffix}`,
      sourceId: `src_${suffix}`,
      externalId: `ext_${suffix}`,
      url: `https://${suffix}.test/doc`,
      title: `Doc ${suffix}`,
      contentHash: `hash_${suffix}`,
      updatedAt: 1000,
    });
    await tenant.documents.replaceChunks(`doc_${suffix}`, [
      { id: `chk_${suffix}_1`, ordinal: 0, text: "Chunk 1", headingPath: "Intro" },
      { id: `chk_${suffix}_2`, ordinal: 1, text: "Chunk 2", headingPath: "Body" },
    ]);
  }

  it("deletes populated document and its chunks via remove while preserving other tenant", async () => {
    await seedDocumentWithChunks(tenantA, "a");
    await seedDocumentWithChunks(tenantB, "b");

    expect(await tenantA.documents.remove("doc_a")).toBe(true);
    expect(await tenantA.documents.get("doc_a")).toBeNull();
    expect(await tenantA.documents.listChunks("doc_a")).toEqual([]);

    expect(await tenantB.documents.get("doc_b")).not.toBeNull();
    expect((await tenantB.documents.listChunks("doc_b")).map((c) => c.id)).toEqual([
      "chk_b_1",
      "chk_b_2",
    ]);
  });

  it("deletes populated document and its chunks via removeByExternalId while preserving other tenant", async () => {
    await seedDocumentWithChunks(tenantA, "a");
    await seedDocumentWithChunks(tenantB, "b");

    expect(await tenantA.documents.removeByExternalId("src_a", "ext_a")).toBe(true);
    expect(await tenantA.documents.get("doc_a")).toBeNull();
    expect(await tenantA.documents.listChunks("doc_a")).toEqual([]);

    expect(await tenantB.documents.get("doc_b")).not.toBeNull();
    expect((await tenantB.documents.listChunks("doc_b")).map((c) => c.id)).toEqual([
      "chk_b_1",
      "chk_b_2",
    ]);
  });

  it("deletes populated source with documents and chunks while preserving other tenant", async () => {
    await seedDocumentWithChunks(tenantA, "a");
    await seedDocumentWithChunks(tenantB, "b");

    expect(await tenantA.sources.remove("src_a")).toBe(true);
    expect(await tenantA.sources.get("src_a")).toBeNull();
    expect(await tenantA.documents.get("doc_a")).toBeNull();
    expect(await tenantA.documents.listChunks("doc_a")).toEqual([]);

    expect(await tenantB.sources.get("src_b")).not.toBeNull();
    expect(await tenantB.documents.get("doc_b")).not.toBeNull();
    expect((await tenantB.documents.listChunks("doc_b")).map((c) => c.id)).toEqual([
      "chk_b_1",
      "chk_b_2",
    ]);
  });

  it("deletes populated message and its feedback while preserving other tenant", async () => {
    for (const [tenant, suffix] of [
      [tenantA, "a"],
      [tenantB, "b"],
    ] as const) {
      await tenant.assistants.create({
        id: `ast_${suffix}`,
        name: `Assistant ${suffix}`,
        publicKey: `pk_${suffix}`,
        allowedOrigins: [],
        createdAt: 1000,
      });
      await tenant.conversations.create({
        id: `cnv_${suffix}`,
        assistantId: `ast_${suffix}`,
        visitorId: `vis_${suffix}`,
        startedAt: 1000,
        pageUrl: `https://${suffix}.test`,
      });
      await tenant.messages.create({
        id: `msg_${suffix}`,
        conversationId: `cnv_${suffix}`,
        role: "assistant",
        content: "Answer",
        citations: [],
        toolCalls: null,
        tokensIn: 5,
        tokensOut: 10,
        answered: true,
        createdAt: 1000,
      });
      await tenant.feedback.upsert({
        id: `fb_${suffix}`,
        messageId: `msg_${suffix}`,
        visitorId: `vis_${suffix}`,
        value: "up",
        note: "Helpful",
        createdAt: 1000,
      });
    }

    expect(await tenantA.messages.remove("msg_a")).toBe(true);
    expect(await tenantA.messages.get("msg_a")).toBeNull();
    expect(await tenantA.feedback.listForMessage("msg_a")).toEqual([]);

    expect(await tenantB.messages.get("msg_b")).not.toBeNull();
    expect((await tenantB.feedback.listForMessage("msg_b")).map((f) => f.id)).toEqual(["fb_b"]);
  });

  it("deletes populated conversation with messages and feedback while preserving other tenant", async () => {
    for (const [tenant, suffix] of [
      [tenantA, "a"],
      [tenantB, "b"],
    ] as const) {
      await tenant.assistants.create({
        id: `ast_${suffix}`,
        name: `Assistant ${suffix}`,
        publicKey: `pk_${suffix}`,
        allowedOrigins: [],
        createdAt: 1000,
      });
      await tenant.conversations.create({
        id: `cnv_${suffix}`,
        assistantId: `ast_${suffix}`,
        visitorId: `vis_${suffix}`,
        startedAt: 1000,
        pageUrl: `https://${suffix}.test`,
      });
      await tenant.messages.create({
        id: `msg_${suffix}`,
        conversationId: `cnv_${suffix}`,
        role: "assistant",
        content: "Answer",
        citations: [],
        toolCalls: null,
        tokensIn: 5,
        tokensOut: 10,
        answered: true,
        createdAt: 1000,
      });
      await tenant.feedback.upsert({
        id: `fb_${suffix}`,
        messageId: `msg_${suffix}`,
        visitorId: `vis_${suffix}`,
        value: "down",
        note: "Unclear",
        createdAt: 1000,
      });
    }

    expect(await tenantA.conversations.remove("cnv_a")).toBe(true);
    expect(await tenantA.conversations.get("cnv_a")).toBeNull();
    expect(await tenantA.messages.list("cnv_a")).toEqual([]);
    expect(await tenantA.feedback.get("fb_a")).toBeNull();

    expect(await tenantB.conversations.get("cnv_b")).not.toBeNull();
    expect((await tenantB.messages.list("cnv_b")).map((m) => m.id)).toEqual(["msg_b"]);
    expect(await tenantB.feedback.get("fb_b")).not.toBeNull();
  });

  it("deletes populated version and its test runs while preserving other tenant", async () => {
    const cfg = defaultVersionConfig();
    for (const [tenant, suffix] of [
      [tenantA, "a"],
      [tenantB, "b"],
    ] as const) {
      await tenant.assistants.create({
        id: `ast_${suffix}`,
        name: `Assistant ${suffix}`,
        publicKey: `pk_${suffix}`,
        allowedOrigins: [],
        createdAt: 1000,
      });
      await tenant.versions.createDraft({
        id: `ver_${suffix}`,
        assistantId: `ast_${suffix}`,
        config: cfg,
        createdAt: 1000,
      });
      await tenant.tests.createRun({
        id: `run_${suffix}`,
        versionId: `ver_${suffix}`,
        startedAt: 1000,
        results: [{ testId: `tst_${suffix}`, passed: true }],
        passed: true,
      });
    }

    expect(await tenantA.versions.remove("ver_a")).toBe(true);
    expect(await tenantA.versions.get("ver_a")).toBeNull();
    expect(await tenantA.tests.listRuns("ver_a")).toEqual([]);

    expect(await tenantB.versions.get("ver_b")).not.toBeNull();
    expect((await tenantB.tests.listRuns("ver_b")).map((r) => r.id)).toEqual(["run_b"]);
  });

  it("deletes populated assistant and all dependent records while preserving other tenant", async () => {
    const cfg = defaultVersionConfig();
    for (const [tenant, suffix] of [
      [tenantA, "a"],
      [tenantB, "b"],
    ] as const) {
      await seedDocumentWithChunks(tenant, suffix);
      await tenant.versions.createDraft({
        id: `ver_${suffix}`,
        assistantId: `ast_${suffix}`,
        config: cfg,
        createdAt: 1000,
      });
      await tenant.tests.create({
        id: `tst_${suffix}`,
        assistantId: `ast_${suffix}`,
        question: "How does it work?",
        expectation: { kind: "must_decline" },
        createdAt: 1000,
      });
      await tenant.tests.createRun({
        id: `run_${suffix}`,
        versionId: `ver_${suffix}`,
        startedAt: 1000,
        results: [],
        passed: true,
      });
      await tenant.conversations.create({
        id: `cnv_${suffix}`,
        assistantId: `ast_${suffix}`,
        visitorId: `vis_${suffix}`,
        startedAt: 1000,
        pageUrl: `https://${suffix}.test`,
      });
      await tenant.messages.create({
        id: `msg_${suffix}`,
        conversationId: `cnv_${suffix}`,
        role: "assistant",
        content: "Answer",
        citations: [],
        toolCalls: null,
        tokensIn: 5,
        tokensOut: 10,
        answered: true,
        createdAt: 1000,
      });
      await tenant.feedback.upsert({
        id: `fb_${suffix}`,
        messageId: `msg_${suffix}`,
        visitorId: `vis_${suffix}`,
        value: "up",
        note: "Great",
        createdAt: 1000,
      });
      await tenant.mcp.createServer({
        id: `mcp_${suffix}`,
        assistantId: `ast_${suffix}`,
        label: `MCP ${suffix}`,
        url: `https://${suffix}.test/mcp`,
        authKind: "none",
        secretCiphertext: null,
        enabled: true,
        createdAt: 1000,
      });
      await tenant.mcp.upsertTool({
        id: `tool_${suffix}`,
        serverId: `mcp_${suffix}`,
        name: "search",
        description: "Search",
        inputSchema: {},
      });
    }

    expect(await tenantA.assistants.remove("ast_a")).toBe(true);
    expect(await tenantA.assistants.get("ast_a")).toBeNull();
    expect(await tenantA.versions.get("ver_a")).toBeNull();
    expect(await tenantA.tests.listRuns("ver_a")).toEqual([]);
    expect(await tenantA.tests.list("ast_a")).toEqual([]);
    expect(await tenantA.sources.list("ast_a")).toEqual([]);
    expect(await tenantA.documents.get("doc_a")).toBeNull();
    expect(await tenantA.documents.listChunks("doc_a")).toEqual([]);
    expect(await tenantA.conversations.list("ast_a")).toEqual([]);
    expect(await tenantA.messages.get("msg_a")).toBeNull();
    expect(await tenantA.feedback.get("fb_a")).toBeNull();
    expect(await tenantA.mcp.listServers("ast_a")).toEqual([]);
    expect(await tenantA.mcp.listTools("mcp_a")).toEqual([]);

    expect(await tenantB.assistants.get("ast_b")).not.toBeNull();
    expect(await tenantB.versions.get("ver_b")).not.toBeNull();
    expect((await tenantB.tests.listRuns("ver_b")).map((r) => r.id)).toEqual(["run_b"]);
    expect((await tenantB.tests.list("ast_b")).map((t) => t.id)).toEqual(["tst_b"]);
    expect((await tenantB.sources.list("ast_b")).map((s) => s.id)).toEqual(["src_b"]);
    expect(await tenantB.documents.get("doc_b")).not.toBeNull();
    expect((await tenantB.documents.listChunks("doc_b")).map((c) => c.id)).toEqual([
      "chk_b_1",
      "chk_b_2",
    ]);
    expect((await tenantB.conversations.list("ast_b")).map((c) => c.id)).toEqual(["cnv_b"]);
    expect(await tenantB.messages.get("msg_b")).not.toBeNull();
    expect(await tenantB.feedback.get("fb_b")).not.toBeNull();
    expect((await tenantB.mcp.listServers("ast_b")).map((s) => s.id)).toEqual(["mcp_b"]);
    expect((await tenantB.mcp.listTools("mcp_b")).map((t) => t.id)).toEqual(["tool_b"]);
  });
});
