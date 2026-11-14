import { env } from "cloudflare:test";
import { defaultVersionConfig } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { forIngestScope, forPrincipal, type Tenant } from "../../src/db/tenant.js";

const ORG_A = "org_00000000000000000000";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";

describe("db/tenant isolation", () => {
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

  it("isolates assistants across orgs", async () => {
    await tenantA.assistants.create({
      id: "ast_a",
      name: "A",
      publicKey: "pk_a",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantB.assistants.create({
      id: "ast_b",
      name: "B",
      publicKey: "pk_b",
      allowedOrigins: [],
      createdAt: 1000,
    });

    expect((await tenantA.assistants.list()).map((a) => a.id)).toEqual(["ast_a"]);
    expect(await tenantA.assistants.get("ast_b")).toBeNull();
    expect(await tenantA.assistants.getByPublicKey("pk_b")).toBeNull();
    expect(await tenantA.assistants.update("ast_b", { name: "Hacked", allowedOrigins: [] })).toBe(
      false,
    );
    expect(await tenantA.assistants.remove("ast_b")).toBe(false);
    expect(await tenantB.assistants.get("ast_b")).not.toBeNull();
  });

  it("isolates versions across orgs", async () => {
    await tenantA.assistants.create({
      id: "ast_a",
      name: "A",
      publicKey: "pk_a",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantB.assistants.create({
      id: "ast_b",
      name: "B",
      publicKey: "pk_b",
      allowedOrigins: [],
      createdAt: 1000,
    });
    const cfg = defaultVersionConfig();
    await tenantA.versions.createDraft({
      id: "ver_a",
      assistantId: "ast_a",
      config: cfg,
      createdAt: 1000,
    });
    await tenantB.versions.createDraft({
      id: "ver_b",
      assistantId: "ast_b",
      config: cfg,
      createdAt: 1000,
    });

    expect((await tenantA.versions.history("ast_a")).map((v) => v.id)).toEqual(["ver_a"]);
    expect(await tenantA.versions.history("ast_b")).toEqual([]);
    expect(await tenantA.versions.get("ver_b")).toBeNull();
    expect(await tenantA.versions.draft("ast_b")).toBeNull();
    expect(await tenantA.versions.updateDraft("ast_b", cfg)).toBe(false);
    expect(await tenantA.versions.remove("ver_b")).toBe(false);
    expect(await tenantB.versions.get("ver_b")).not.toBeNull();
  });

  it("isolates sources across orgs", async () => {
    await tenantA.assistants.create({
      id: "ast_a",
      name: "A",
      publicKey: "pk_a",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantB.assistants.create({
      id: "ast_b",
      name: "B",
      publicKey: "pk_b",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantA.sources.create({
      id: "src_a",
      assistantId: "ast_a",
      kind: "push",
      label: "Docs A",
      settings: {},
      createdAt: 1000,
    });
    await tenantB.sources.create({
      id: "src_b",
      assistantId: "ast_b",
      kind: "push",
      label: "Docs B",
      settings: {},
      createdAt: 1000,
    });

    expect((await tenantA.sources.list("ast_a")).map((s) => s.id)).toEqual(["src_a"]);
    expect(await tenantA.sources.list("ast_b")).toEqual([]);
    expect(await tenantA.sources.get("src_b")).toBeNull();
    expect(await tenantA.sources.update("src_b", { label: "Hacked", settings: {} })).toBe(false);
    expect(await tenantA.sources.remove("src_b")).toBe(false);
    expect(await tenantB.sources.get("src_b")).not.toBeNull();
  });

  it("isolates documents and chunks across orgs", async () => {
    await tenantA.assistants.create({
      id: "ast_a",
      name: "A",
      publicKey: "pk_a",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantB.assistants.create({
      id: "ast_b",
      name: "B",
      publicKey: "pk_b",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantA.sources.create({
      id: "src_a",
      assistantId: "ast_a",
      kind: "push",
      label: "Docs A",
      settings: {},
      createdAt: 1000,
    });
    await tenantB.sources.create({
      id: "src_b",
      assistantId: "ast_b",
      kind: "push",
      label: "Docs B",
      settings: {},
      createdAt: 1000,
    });
    await tenantA.documents.upsert({
      id: "doc_a",
      sourceId: "src_a",
      externalId: "intro",
      url: "https://a.test/intro",
      title: "Intro A",
      contentHash: "ha",
      updatedAt: 1000,
    });
    await tenantB.documents.upsert({
      id: "doc_b",
      sourceId: "src_b",
      externalId: "intro",
      url: "https://b.test/intro",
      title: "Intro B",
      contentHash: "hb",
      updatedAt: 1000,
    });
    await tenantA.documents.replaceChunks("doc_a", [
      { id: "chk_a", ordinal: 0, text: "A", headingPath: "Intro" },
    ]);
    await tenantB.documents.replaceChunks("doc_b", [
      { id: "chk_b", ordinal: 0, text: "B", headingPath: "Intro" },
    ]);

    expect((await tenantA.documents.listBySource("src_a")).map((d) => d.id)).toEqual(["doc_a"]);
    expect(await tenantA.documents.listBySource("src_b")).toEqual([]);
    expect(await tenantA.documents.get("doc_b")).toBeNull();
    expect(await tenantA.documents.listChunks("doc_b")).toEqual([]);
    expect(await tenantA.documents.updateMetadata("doc_b", "Hacked", "https://bad.test")).toBe(
      false,
    );
    expect(await tenantA.documents.remove("doc_b")).toBe(false);
    expect(await tenantB.documents.get("doc_b")).not.toBeNull();
  });

  it("isolates conversations across orgs", async () => {
    await tenantA.assistants.create({
      id: "ast_a",
      name: "A",
      publicKey: "pk_a",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantB.assistants.create({
      id: "ast_b",
      name: "B",
      publicKey: "pk_b",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantA.conversations.create({
      id: "cnv_a",
      assistantId: "ast_a",
      visitorId: "vis_1",
      startedAt: 1000,
      pageUrl: "https://a.test",
    });
    await tenantB.conversations.create({
      id: "cnv_b",
      assistantId: "ast_b",
      visitorId: "vis_1",
      startedAt: 1000,
      pageUrl: "https://b.test",
    });

    expect((await tenantA.conversations.list("ast_a")).map((c) => c.id)).toEqual(["cnv_a"]);
    expect(await tenantA.conversations.list("ast_b")).toEqual([]);
    expect(await tenantA.conversations.get("cnv_b")).toBeNull();
    expect(await tenantA.conversations.updatePageUrl("cnv_b", "https://hacked.test")).toBe(false);
    expect(await tenantA.conversations.remove("cnv_b")).toBe(false);
    expect(await tenantB.conversations.get("cnv_b")).not.toBeNull();
  });

  it("isolates messages across orgs", async () => {
    await tenantA.assistants.create({
      id: "ast_a",
      name: "A",
      publicKey: "pk_a",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantB.assistants.create({
      id: "ast_b",
      name: "B",
      publicKey: "pk_b",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantA.conversations.create({
      id: "cnv_a",
      assistantId: "ast_a",
      visitorId: "vis_1",
      startedAt: 1000,
      pageUrl: "https://a.test",
    });
    await tenantB.conversations.create({
      id: "cnv_b",
      assistantId: "ast_b",
      visitorId: "vis_1",
      startedAt: 1000,
      pageUrl: "https://b.test",
    });
    await tenantA.messages.create({
      id: "msg_a",
      conversationId: "cnv_a",
      role: "assistant",
      content: "A",
      citations: [],
      toolCalls: null,
      tokensIn: 1,
      tokensOut: 1,
      answered: false,
      createdAt: 1000,
    });
    await tenantB.messages.create({
      id: "msg_b",
      conversationId: "cnv_b",
      role: "assistant",
      content: "B",
      citations: [],
      toolCalls: null,
      tokensIn: 1,
      tokensOut: 1,
      answered: false,
      createdAt: 1000,
    });

    expect((await tenantA.messages.list("cnv_a")).map((m) => m.id)).toEqual(["msg_a"]);
    expect(await tenantA.messages.list("cnv_b")).toEqual([]);
    expect(await tenantA.messages.unanswered("ast_b")).toEqual([]);
    expect(await tenantA.messages.get("msg_b")).toBeNull();
    expect(await tenantA.messages.markAnswered("msg_b", true)).toBe(false);
    expect(await tenantA.messages.remove("msg_b")).toBe(false);
    expect(await tenantB.messages.get("msg_b")).not.toBeNull();
  });

  it("isolates feedback across orgs", async () => {
    await tenantA.assistants.create({
      id: "ast_a",
      name: "A",
      publicKey: "pk_a",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantB.assistants.create({
      id: "ast_b",
      name: "B",
      publicKey: "pk_b",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantA.conversations.create({
      id: "cnv_a",
      assistantId: "ast_a",
      visitorId: "vis_1",
      startedAt: 1000,
      pageUrl: "https://a.test",
    });
    await tenantB.conversations.create({
      id: "cnv_b",
      assistantId: "ast_b",
      visitorId: "vis_1",
      startedAt: 1000,
      pageUrl: "https://b.test",
    });
    await tenantA.messages.create({
      id: "msg_a",
      conversationId: "cnv_a",
      role: "assistant",
      content: "A",
      citations: [],
      toolCalls: null,
      tokensIn: 1,
      tokensOut: 1,
      answered: true,
      createdAt: 1000,
    });
    await tenantB.messages.create({
      id: "msg_b",
      conversationId: "cnv_b",
      role: "assistant",
      content: "B",
      citations: [],
      toolCalls: null,
      tokensIn: 1,
      tokensOut: 1,
      answered: true,
      createdAt: 1000,
    });
    await tenantA.feedback.upsert({
      id: "fb_a",
      messageId: "msg_a",
      visitorId: "vis_1",
      value: "up",
      note: "good",
      createdAt: 1000,
    });
    await tenantB.feedback.upsert({
      id: "fb_b",
      messageId: "msg_b",
      visitorId: "vis_1",
      value: "down",
      note: "bad",
      createdAt: 1000,
    });

    expect((await tenantA.feedback.listForMessage("msg_a")).map((f) => f.id)).toEqual(["fb_a"]);
    expect(await tenantA.feedback.listForMessage("msg_b")).toEqual([]);
    expect(await tenantA.feedback.get("fb_b")).toBeNull();
    expect(await tenantA.feedback.updateNote("fb_b", "Hacked")).toBe(false);
    expect(await tenantA.feedback.remove("fb_b")).toBe(false);
    expect(await tenantB.feedback.get("fb_b")).not.toBeNull();
  });

  it("isolates mcp servers and tools across orgs", async () => {
    await tenantA.assistants.create({
      id: "ast_a",
      name: "A",
      publicKey: "pk_a",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantB.assistants.create({
      id: "ast_b",
      name: "B",
      publicKey: "pk_b",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantA.mcp.createServer({
      id: "mcp_a",
      assistantId: "ast_a",
      label: "A",
      url: "https://a.test/mcp",
      authKind: "none",
      secretCiphertext: null,
      enabled: true,
      createdAt: 1000,
    });
    await tenantB.mcp.createServer({
      id: "mcp_b",
      assistantId: "ast_b",
      label: "B",
      url: "https://b.test/mcp",
      authKind: "static_header",
      secretCiphertext: "enc_secret",
      enabled: true,
      createdAt: 1000,
    });
    await tenantA.mcp.upsertTool({
      id: "tool_a",
      serverId: "mcp_a",
      name: "search",
      description: "Search A",
      inputSchema: {},
    });
    await tenantB.mcp.upsertTool({
      id: "tool_b",
      serverId: "mcp_b",
      name: "search",
      description: "Search B",
      inputSchema: {},
    });

    expect((await tenantA.mcp.listServers("ast_a")).map((s) => s.id)).toEqual(["mcp_a"]);
    expect(await tenantA.mcp.listServers("ast_b")).toEqual([]);
    expect(await tenantA.mcp.getServer("mcp_b")).toBeNull();
    expect(await tenantA.mcp.listTools("mcp_b")).toEqual([]);
    expect(
      await tenantA.mcp.updateServer("mcp_b", {
        label: "Hacked",
        url: "https://bad.test",
        enabled: false,
      }),
    ).toBe(false);
    expect(await tenantA.mcp.setToolAllowed("tool_b", true)).toBe(false);
    expect(await tenantA.mcp.removeServer("mcp_b")).toBe(false);
    expect(await tenantB.mcp.getServer("mcp_b")).toMatchObject({ id: "mcp_b", hasSecret: true });
  });

  it("isolates tests and test runs across orgs", async () => {
    await tenantA.assistants.create({
      id: "ast_a",
      name: "A",
      publicKey: "pk_a",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantB.assistants.create({
      id: "ast_b",
      name: "B",
      publicKey: "pk_b",
      allowedOrigins: [],
      createdAt: 1000,
    });
    const cfg = defaultVersionConfig();
    await tenantA.versions.createDraft({
      id: "ver_a",
      assistantId: "ast_a",
      config: cfg,
      createdAt: 1000,
    });
    await tenantB.versions.createDraft({
      id: "ver_b",
      assistantId: "ast_b",
      config: cfg,
      createdAt: 1000,
    });

    await tenantA.tests.create({
      id: "tst_a",
      assistantId: "ast_a",
      question: "How?",
      expectation: { kind: "must_contain", value: "Yes" },
      createdAt: 1000,
    });
    await tenantB.tests.create({
      id: "tst_b",
      assistantId: "ast_b",
      question: "Why?",
      expectation: { kind: "must_decline" },
      createdAt: 1000,
    });
    await tenantA.tests.createRun({
      id: "run_a",
      versionId: "ver_a",
      startedAt: 1000,
      results: [],
      passed: true,
    });
    await tenantB.tests.createRun({
      id: "run_b",
      versionId: "ver_b",
      startedAt: 1000,
      results: [],
      passed: false,
    });

    expect((await tenantA.tests.list("ast_a")).map((t) => t.id)).toEqual(["tst_a"]);
    expect(await tenantA.tests.list("ast_b")).toEqual([]);
    expect(await tenantA.tests.get("tst_b")).toBeNull();
    expect(await tenantA.tests.listRuns("ver_b")).toEqual([]);
    expect(await tenantA.tests.updateQuestion("tst_b", "Hacked")).toBe(false);
    expect(await tenantA.tests.remove("tst_b")).toBe(false);
    expect(await tenantB.tests.get("tst_b")).not.toBeNull();
  });

  it("scopes ingest tenants via forIngestScope", async () => {
    await tenantA.assistants.create({
      id: "ast_a",
      name: "A",
      publicKey: "pk_a",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantB.assistants.create({
      id: "ast_b",
      name: "B",
      publicKey: "pk_b",
      allowedOrigins: [],
      createdAt: 1000,
    });

    const ingestA = forIngestScope(env.DB, { orgId: ORG_A, assistantId: "ast_a" });
    expect((await ingestA.assistants.list()).map((a) => a.id)).toEqual(["ast_a"]);
    expect(await ingestA.assistants.get("ast_b")).toBeNull();
  });

  it("removes a server along with its discovered tools without affecting other tenants", async () => {
    await tenantA.assistants.create({
      id: "ast_a",
      name: "A",
      publicKey: "pk_a",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantB.assistants.create({
      id: "ast_b",
      name: "B",
      publicKey: "pk_b",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await tenantA.mcp.createServer({
      id: "mcp_a",
      assistantId: "ast_a",
      label: "A",
      url: "https://a.test/mcp",
      authKind: "none",
      secretCiphertext: null,
      enabled: true,
      createdAt: 1000,
    });
    await tenantB.mcp.createServer({
      id: "mcp_b",
      assistantId: "ast_b",
      label: "B",
      url: "https://b.test/mcp",
      authKind: "none",
      secretCiphertext: null,
      enabled: true,
      createdAt: 1000,
    });
    await tenantA.mcp.upsertTool({
      id: "tool_a",
      serverId: "mcp_a",
      name: "search",
      description: "Search A",
      inputSchema: {},
    });
    await tenantB.mcp.upsertTool({
      id: "tool_b",
      serverId: "mcp_b",
      name: "search",
      description: "Search B",
      inputSchema: {},
    });

    expect(await tenantA.mcp.removeServer("mcp_b")).toBe(false);
    expect(await tenantB.mcp.getServer("mcp_b")).not.toBeNull();
    expect((await tenantB.mcp.listTools("mcp_b")).map((t) => t.id)).toEqual(["tool_b"]);

    expect(await tenantA.mcp.removeServer("mcp_a")).toBe(true);
    expect(await tenantA.mcp.getServer("mcp_a")).toBeNull();
    expect(await tenantA.mcp.listTools("mcp_a")).toEqual([]);
  });

  it("rejects child inserts referencing another tenant's parent", async () => {
    await tenantB.assistants.create({
      id: "ast_b",
      name: "B",
      publicKey: "pk_b",
      allowedOrigins: [],
      createdAt: 1000,
    });
    const cfg = defaultVersionConfig();

    // A cannot occupy B's draft slot or insert via batch statement.
    await expect(
      tenantA.versions.createDraft({
        id: "ver_a_hijack",
        assistantId: "ast_b",
        config: cfg,
        createdAt: 1000,
      }),
    ).rejects.toThrow();
    await expect(
      tenantA.versions.batch([
        tenantA.versions.statements.insertDraft({
          id: "ver_a_batch",
          assistantId: "ast_b",
          config: cfg,
          createdAt: 1000,
        }),
      ]),
    ).rejects.toThrow();

    // B can still create its own draft unblocked.
    await tenantB.versions.createDraft({
      id: "ver_b",
      assistantId: "ast_b",
      config: cfg,
      createdAt: 1001,
    });
    expect((await tenantB.versions.draft("ast_b"))?.id).toBe("ver_b");

    await tenantB.sources.create({
      id: "src_b",
      assistantId: "ast_b",
      kind: "push",
      label: "Docs B",
      settings: {},
      createdAt: 1000,
    });
    await tenantB.documents.upsert({
      id: "doc_b",
      sourceId: "src_b",
      externalId: "intro",
      url: "https://b.test/intro",
      title: "Intro B",
      contentHash: "hb",
      updatedAt: 1000,
    });
    await tenantB.documents.replaceChunks("doc_b", [
      { id: "chk_b", ordinal: 0, text: "B", headingPath: "Intro" },
    ]);
    await tenantB.conversations.create({
      id: "cnv_b",
      assistantId: "ast_b",
      visitorId: "vis_1",
      startedAt: 1000,
      pageUrl: "https://b.test",
    });
    await tenantB.messages.create({
      id: "msg_b",
      conversationId: "cnv_b",
      role: "assistant",
      content: "B",
      citations: [],
      toolCalls: null,
      tokensIn: 1,
      tokensOut: 1,
      answered: true,
      createdAt: 1000,
    });
    await tenantB.mcp.createServer({
      id: "mcp_b",
      assistantId: "ast_b",
      label: "B",
      url: "https://b.test/mcp",
      authKind: "none",
      secretCiphertext: null,
      enabled: true,
      createdAt: 1000,
    });

    await expect(
      tenantA.sources.create({
        id: "src_a_hijack",
        assistantId: "ast_b",
        kind: "push",
        label: "Hijack",
        settings: {},
        createdAt: 1000,
      }),
    ).rejects.toThrow();

    await expect(
      tenantA.documents.upsert({
        id: "doc_a_hijack",
        sourceId: "src_b",
        externalId: "hijack",
        url: "https://a.test/hijack",
        title: "Hijack",
        contentHash: "ha",
        updatedAt: 1000,
      }),
    ).rejects.toThrow();

    await expect(
      tenantA.documents.replaceChunks("doc_b", [
        { id: "chk_a_hijack", ordinal: 0, text: "Hijack", headingPath: "" },
      ]),
    ).rejects.toThrow();
    expect((await tenantB.documents.listChunks("doc_b")).map((c) => c.id)).toEqual(["chk_b"]);

    await expect(
      tenantA.conversations.create({
        id: "cnv_a_hijack",
        assistantId: "ast_b",
        visitorId: "vis_a",
        startedAt: 1000,
        pageUrl: "https://a.test",
      }),
    ).rejects.toThrow();

    await expect(
      tenantA.messages.create({
        id: "msg_a_hijack",
        conversationId: "cnv_b",
        role: "user",
        content: "Hijack",
        citations: [],
        toolCalls: null,
        tokensIn: 1,
        tokensOut: 0,
        answered: true,
        createdAt: 1000,
      }),
    ).rejects.toThrow();

    await expect(
      tenantA.feedback.upsert({
        id: "fb_a_hijack",
        messageId: "msg_b",
        visitorId: "vis_a",
        value: "down",
        note: "hijack",
        createdAt: 1000,
      }),
    ).rejects.toThrow();

    await expect(
      tenantA.mcp.createServer({
        id: "mcp_a_hijack",
        assistantId: "ast_b",
        label: "Hijack",
        url: "https://a.test/mcp",
        authKind: "none",
        secretCiphertext: null,
        enabled: true,
        createdAt: 1000,
      }),
    ).rejects.toThrow();

    await expect(
      tenantA.mcp.upsertTool({
        id: "tool_a_hijack",
        serverId: "mcp_b",
        name: "hijack",
        description: "Hijack",
        inputSchema: {},
      }),
    ).rejects.toThrow();

    await expect(
      tenantA.tests.create({
        id: "tst_a_hijack",
        assistantId: "ast_b",
        question: "Hijack?",
        expectation: { kind: "must_decline" },
        createdAt: 1000,
      }),
    ).rejects.toThrow();

    await expect(
      tenantA.tests.createRun({
        id: "run_a_hijack",
        versionId: "ver_b",
        startedAt: 1000,
        results: [],
        passed: false,
      }),
    ).rejects.toThrow();
  });
});
