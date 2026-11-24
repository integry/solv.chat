import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CLI_COMMANDS } from "@solvchat/cli";
import { CHAT_PROTOCOL_VERSION } from "@solvchat/core";
import { afterAll, describe, expect, it } from "vitest";
import { adminOperations, matchAdminOperation } from "../../src/admin/router.js";
import { createApp } from "../../src/app.js";
import { normalizeQuestionText } from "../../src/db/messages.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import { cliCoverage, operatorTools } from "../../src/operator/tools.js";
import { passwordAuth } from "../../src/seams/open/passwordAuth.js";
import { secretKeys } from "../../src/seams/open/secretKeys.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { fakeMcpServer } from "../fakes/fakeMcpServer.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { fakeSeams, TEST_ORG_ID } from "../helpers/app.js";
import { capturingQueue } from "../helpers/pipeline.js";

const ORIGIN = "https://operator-parity.example";
const ADMIN = "/api/admin";
const SITE = "https://docs.example.com";
const SITEMAP = `${SITE}/sitemap.xml`;
const PAGE = `${SITE}/start`;
const TOOL_URL = "https://tools.example.com/mcp";
const OWNER = { orgId: TEST_ORG_ID, userId: "owner", role: "owner" } as const;
const FIXTURE_SECRET = "fixture-operator-parity-key";
const SHIPPING_TOPIC = "top_00000000000000000001";
const ORDERS_TOPIC = "top_00000000000000000002";

const exclusions = {
  "POST /api/admin/login": "Interactive sign-in establishes a browser session.",
  "POST /api/admin/logout": "Interactive sign-out clears the browser session.",
  "GET /admin/*": "Static assets and the admin application shell.",
  "HEAD /admin/*": "Static asset metadata.",
};

const checked = new Set<string>();

async function withOperatorClient<T>(
  run: (fixture: Awaited<ReturnType<typeof operatorFixture>>) => Promise<T>,
): Promise<T> {
  const fixture = await operatorFixture();
  try {
    return await run(fixture);
  } finally {
    await fixture.client.close();
  }
}

async function operatorFixture() {
  const queue = capturingQueue();
  const testEnv = {
    ...env,
    SOLV_SECRET_KEY: FIXTURE_SECRET,
    INGEST_QUEUE: queue as unknown as Queue,
  };
  const auth = passwordAuth(testEnv, env.DB).operator;
  const external = fakeMcpServer({
    tools: [{ name: "lookup", description: "Look up an item", inputSchema: { type: "object" } }],
  });
  const app = createApp(
    fakeSeams({
      auth: { operator: auth },
      keys: secretKeys(testEnv, env.DB),
      pages: {
        async fetchPage(url) {
          return {
            kind: "page",
            notModified: false,
            finalUrl: url,
            status: 200,
            etag: null,
            lastModified: null,
            title: "Start",
            markdown: "# Start\nDocumentation.",
          };
        },
      },
    }),
    {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.href === TOOL_URL) return external.fetchImpl(input, init);
        if (url.href === SITEMAP)
          return new Response(
            `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${PAGE}</loc></url></urlset>`,
            { headers: { "content-type": "application/xml" } },
          );
        if (url.hostname === "api.openai.com") return Response.json({});
        throw new Error("Unexpected fixture URL");
      },
      chat: {
        embedder: fakeEmbedder(),
        retriever: memoryRetriever(),
        provider: {
          name: "anthropic",
          model: ANTHROPIC_MODELS.fast.id,
          async *stream() {
            yield { kind: "text", text: "Fixture answer." };
          },
        },
      },
    },
  );

  const worker: typeof fetch = async (input, init) => {
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request(input, init), testEnv, ctx);
    const body = response.body ? await response.arrayBuffer() : null;
    await waitOnExecutionContext(ctx);
    return new Response(body, { status: response.status, headers: response.headers });
  };
  const http = (path: string, method = "GET", body?: unknown, token?: string) =>
    worker(ORIGIN + path, {
      method,
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function json(path: string, method?: string, body?: unknown, key?: string) {
    const response = await http(path, method, body, key);
    const data = await response.json<Record<string, unknown>>();
    expect(response.ok, `${method ?? "GET"} ${path}: ${JSON.stringify(data)}`).toBe(true);
    return data;
  }

  const full = await (
    await http(`${ADMIN}/operator-tokens`, "POST", { name: "Parity suite", scope: "full" })
  ).json<{ token: string }>();
  const client = new Client({ name: "operator parity", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: worker,
      requestInit: { headers: { authorization: `Bearer ${full.token}` } },
    }),
  );
  async function call<T = Record<string, unknown>>(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
    checked.add(name);
    return result.structuredContent as T;
  }

  async function equivalent(
    name: string,
    path: string,
    args?: Record<string, unknown>,
    method = "GET",
    body?: unknown,
  ) {
    expect(await call(name, args), name).toEqual(await json(ADMIN + path, method, body));
  }

  async function createFixtureAssistant() {
    const { assistant, ingestKey } = (await json(`${ADMIN}/assistants`, "POST", {
      name: "Parity",
      allowedOrigins: [SITE],
    })) as { assistant: { id: string; publicKey: string }; ingestKey: string };
    return {
      assistant,
      assistantId: assistant.id,
      a: { assistantId: assistant.id },
      path: `/assistants/${assistant.id}`,
      ingestPath: `/v1/ingest/${assistant.id}`,
      ingestKey,
    };
  }

  return { client, external, http, json, call, equivalent, createFixtureAssistant };
}

describe("admin and CLI tool parity", () => {
  it("maps every routable admin API operation and CLI command to a unique tool", () => {
    const names = operatorTools.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    const routes = new Set<string>();
    for (const operation of adminOperations) {
      const route = `${operation.method} ${ADMIN}${operation.path}`;
      expect(routes.has(route), route).toBe(false);
      routes.add(route);
      const path = operation.path.replace(/:[\w]+/g, "fixture");
      expect(matchAdminOperation(operation.method, ADMIN + path)?.operation).toBe(operation);
      expect(names, route).toContain(operation.name);
    }
    for (const route of Object.keys(exclusions)) expect(routes.has(route)).toBe(false);
    expect(Object.keys(cliCoverage).sort()).toEqual([...CLI_COMMANDS].sort());
    for (const [command, tools] of Object.entries(cliCoverage)) {
      for (const tool of tools) expect(names, command).toContain(tool);
    }
  });

  it(
    "keeps assistant, draft, publish, rollback and access management in parity",
    () =>
      withOperatorClient(async ({ client, call, equivalent, json, http }) => {
        const visible: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          visible.push(...page.tools.map(({ name }) => name));
          cursor = page.nextCursor;
        } while (cursor);
        expect(visible).toEqual(operatorTools.map(({ name }) => name));

        const { assistant, ingestKey } = await call<{
          assistant: { id: string; publicKey: string };
          ingestKey: string;
        }>("create_assistant", { body: { name: "Parity", allowedOrigins: [SITE] } });
        const assistantId = assistant.id;
        const a = { assistantId };
        const path = `/assistants/${assistantId}`;
        const ingestPath = `/v1/ingest/${assistantId}`;
        expect(await json(ADMIN + path)).toMatchObject({ assistant });
        await equivalent("list_assistants", "/assistants");
        await equivalent("get_assistant", path, a);
        await call("update_assistant", {
          ...a,
          body: { name: "Updated assistant", allowedOrigins: [SITE] },
        });
        expect(await json(ADMIN + path)).toMatchObject({
          assistant: { name: "Updated assistant" },
        });
        const rotated = await call<{ ingestKey: string }>("rotate_ingest_key", a);
        expect((await http(`${ingestPath}/config`, "GET", undefined, ingestKey)).status).toBe(401);
        expect(
          (await http(`${ingestPath}/config`, "GET", undefined, rotated.ingestKey)).status,
        ).toBe(200);
        await equivalent("get_install_snippet", `${path}/install`, a);
        await equivalent("get_draft", `${path}/draft`, a);
        const before = await call<{ version: { id: string; config: unknown } }>("publish_draft", a);
        expect(await json(`${ADMIN + path}/versions`)).toMatchObject({
          versions: expect.arrayContaining([{ ...before.version, state: "published" }]),
        });
        await call("update_draft", {
          ...a,
          body: { behaviour: { fallbackText: "No answer in this draft." } },
        });
        expect(await json(`${ADMIN + path}/draft`)).toMatchObject({
          draft: { config: { behaviour: { fallbackText: "No answer in this draft." } } },
        });
        await json(`${ADMIN + path}/publish`, "POST", {});
        await call("rollback_version", { ...a, versionId: before.version.id });
        expect(await json(`${ADMIN + path}/versions`)).toMatchObject({
          versions: expect.arrayContaining([
            expect.objectContaining({
              state: "published",
              config: before.version.config,
            }),
          ]),
        });
        await equivalent("list_versions", `${path}/versions`, a);

        const personal = await call<{ id: string; token: string }>("create_personal_token", {
          body: { name: "Audit", scope: "read" },
        });
        expect(await json(`${ADMIN}/operator-tokens`)).toMatchObject({
          access: expect.arrayContaining([
            expect.objectContaining({ id: personal.id, name: "Audit" }),
          ]),
        });
        const access = await call<{ access: Array<{ id: string; lastUsedAt: number | null }> }>(
          "list_operator_access",
        );
        const current = (await json(`${ADMIN}/operator-tokens`)) as {
          access: typeof access.access;
        };
        const removeTimes = (rows: typeof access.access) =>
          rows.map(({ lastUsedAt: _, ...item }) => item);
        expect(removeTimes(access.access)).toEqual(removeTimes(current.access));
        await call("revoke_operator_access", { tokenId: personal.id });
        expect(JSON.stringify(await json(`${ADMIN}/operator-tokens`))).not.toContain(personal.id);
      }),
    20_000,
  );

  it(
    "keeps source, document, sitemap, and push operations in parity",
    () =>
      withOperatorClient(async ({ call, equivalent, json, http, createFixtureAssistant }) => {
        const { a, path, ingestPath, ingestKey } = await createFixtureAssistant();

        const createdSource = await call<{ source: { id: string } }>("create_source", {
          ...a,
          body: { kind: "entry", label: "Answers" },
        });
        const sourceId = createdSource.source.id;
        const s = { sourceId };
        const sourcePath = `/sources/${sourceId}`;
        await call("update_source", { ...s, body: { label: "Written answers" } });
        expect(await json(`${ADMIN + path}/sources`)).toMatchObject({
          sources: expect.arrayContaining([
            expect.objectContaining({ id: sourceId, label: "Written answers" }),
          ]),
        });
        const { documentId } = await call<{ documentId: string }>("create_source_entry", {
          ...s,
          body: { question: "Can it ship?", answer: "Yes, it can." },
        });
        const d = { ...s, documentId };
        const docPath = `${sourcePath}/documents/${documentId}`;
        expect(await json(ADMIN + docPath)).toMatchObject({
          markdown: expect.stringContaining("Yes, it can."),
        });
        await call("update_entry", {
          ...d,
          body: { question: "Can it ship today?", answer: "On weekdays." },
        });
        expect(await json(ADMIN + docPath)).toMatchObject({
          markdown: expect.stringContaining("On weekdays."),
        });
        await equivalent("list_documents", `${sourcePath}/documents?limit=1&offset=0`, {
          ...s,
          limit: 1,
          offset: 0,
        });
        await equivalent("get_document", docPath, d);
        await call("delete_document", d);
        expect((await http(ADMIN + docPath)).status).toBe(404);
        const entry = await call<{ documentId: string; sourceId: string }>("create_entry", {
          ...a,
          body: { question: "Where is the guide?", answer: "Read Getting Started." },
        });
        expect(
          await json(`${ADMIN}/sources/${entry.sourceId}/documents/${entry.documentId}`),
        ).toMatchObject({ markdown: expect.stringContaining("Read Getting Started.") });
        await call("delete_source", s);
        expect((await http(`${ADMIN + sourcePath}/documents`)).status).toBe(404);

        await equivalent(
          "preview_sitemap",
          `${path}/sitemap-preview`,
          { ...a, body: { url: SITEMAP } },
          "POST",
          { url: SITEMAP },
        );
        const imported = await call<{ source: { id: string } }>("import_sitemap", {
          ...a,
          body: { sitemapUrl: SITEMAP, label: "Manual", urls: [PAGE] },
        });
        const sitemapPath = `/sources/${imported.source.id}`;
        expect(await json(`${ADMIN + sitemapPath}/documents`)).toMatchObject({
          documents: [expect.objectContaining({ url: PAGE })],
        });
        await equivalent("get_repeated_blocks", `${sitemapPath}/repeated-blocks`, {
          sourceId: imported.source.id,
        });
        const sync = await call("start_sync", { sourceId: imported.source.id });
        expect(await json(`${ADMIN + sitemapPath}/sync`)).toEqual(sync);
        await equivalent("get_sync_status", `${sitemapPath}/sync`, {
          sourceId: imported.source.id,
        });
        await equivalent("list_sources", `${path}/sources`, a);
        await equivalent("get_content_status", `${path}/content-status`, a);
        await equivalent("get_reindex_status", `${path}/reindex`, a);
        expect(await call("start_reindex", a)).toMatchObject({ queued: 0, remaining: 0 });
        expect(await json(`${ADMIN + path}/reindex`)).toEqual({ outdated: 0 });

        const pushDoc = (externalId: string) => ({
          externalId,
          title: externalId,
          url: `${SITE}/${externalId}`,
          markdown: `# ${externalId}\nText`,
        });
        await json(
          `${ingestPath}/documents`,
          "PUT",
          { source: "Repository", documents: [pushDoc("previous")] },
          ingestKey,
        );
        expect(
          await call("push_documents", {
            ...a,
            source: "Repository",
            prune: true,
            documents: [pushDoc("first"), pushDoc("second")],
          }),
        ).toMatchObject({ written: 2, deleted: 1 });
        const pushSources = (await json(`${ADMIN + path}/sources`)) as {
          sources: { id: string; label: string }[];
        };
        const pushed = pushSources.sources.find(({ label }) => label === "Repository");
        expect(pushed).toBeDefined();
        const pushedPath = `${ADMIN}/sources/${pushed?.id}/documents`;
        const externalIds = async () =>
          ((await json(pushedPath)) as { documents: Array<{ externalId: string }> }).documents
            .map(({ externalId }) => externalId)
            .sort();
        expect(await externalIds()).toEqual(["first", "second"]);
        await call("prune_pushed_documents", { ...a, source: "Repository", keep: ["first"] });
        expect(await externalIds()).toEqual(["first"]);
        await call("delete_pushed_documents", {
          ...a,
          source: "Repository",
          externalIds: ["first"],
        });
        expect(await externalIds()).toEqual([]);
      }),
    20_000,
  );

  it(
    "keeps tool server, provider, test and config-as-code operations in parity",
    () =>
      withOperatorClient(
        async ({ client, call, equivalent, json, external, createFixtureAssistant }) => {
          const { a, path, ingestPath, ingestKey } = await createFixtureAssistant();

          const added = await call<{ server: { id: string } }>("add_tool_server", {
            ...a,
            body: {
              label: "Lookup",
              url: TOOL_URL,
              authKind: "static_header",
              headerName: "X-Test-Key",
              headerValue: "fixture-tool-key",
              sendConversationContext: true,
            },
          });
          expect(JSON.stringify(added)).not.toContain("fixture-tool-key");
          const serverId = added.server.id;
          const m = { serverId };
          const serverPath = `/mcp-servers/${serverId}`;
          await equivalent("list_tool_servers", `${path}/mcp-servers`, a);
          await call("update_tool_server", {
            ...m,
            body: { label: "Updated lookup", headerValue: "fixture-new-key" },
          });
          expect(await json(`${ADMIN + path}/mcp-servers`)).toMatchObject({
            servers: [expect.objectContaining({ label: "Updated lookup" })],
          });
          external.calls.length = 0;
          const refreshed = await call<{ tools: Array<{ id: string }> }>("refresh_tools", m);
          expect(
            external.calls.some(({ headers }) => headers.get("x-test-key") === "fixture-new-key"),
          ).toBe(true);
          expect(await json(`${ADMIN + serverPath}/tools`)).toEqual(refreshed);
          await equivalent("list_tools", `${serverPath}/tools`, m);
          await call("set_tool_allowed", {
            ...m,
            toolId: refreshed.tools[0]?.id,
            body: { allowed: true },
          });
          expect(await json(`${ADMIN + serverPath}/tools`)).toMatchObject({
            tools: [expect.objectContaining({ allowed: true })],
          });

          await equivalent("get_provider_settings", "/providers");
          await call("update_provider_settings", { body: { reviewAnswers: false } });
          expect(await json(`${ADMIN}/providers`)).toMatchObject({
            settings: { reviewAnswers: { value: false } },
          });
          const stored = await call("set_provider_key", {
            provider: "openai",
            body: { key: "fixture-provider-key" },
          });
          expect(JSON.stringify(stored)).not.toContain("fixture-provider-key");
          expect(await json(`${ADMIN}/providers`)).toMatchObject({
            keys: { openai: { source: "stored" } },
          });
          await equivalent(
            "test_provider_key",
            "/providers/keys/openai/test",
            { provider: "openai" },
            "POST",
          );
          await call("remove_provider_key", { provider: "openai" });
          expect(await json(`${ADMIN}/providers`)).toMatchObject({
            keys: { openai: { source: "none" } },
          });

          const expectation = { kind: "declines" };
          const createdTest = await call<{ test: { id: string } }>("create_test", {
            ...a,
            body: { question: "Unknown question?", expectation },
          });
          expect(await json(`${ADMIN + path}/tests`)).toMatchObject({ tests: [createdTest.test] });
          await call("update_test", {
            testId: createdTest.test.id,
            body: { question: "Still unknown?" },
          });
          await equivalent("list_tests", `${path}/tests`, a);
          expect(await json(`${ADMIN + path}/tests`)).toMatchObject({
            tests: [expect.objectContaining({ question: "Still unknown?" })],
          });
          const run = await call<{ runId: string }>("run_tests", a);
          expect(await json(`${ADMIN + path}/test-runs`)).toMatchObject({
            runs: [expect.objectContaining({ id: run.runId })],
          });
          await equivalent("list_test_runs", `${path}/test-runs`, a);
          await call("delete_test", { testId: createdTest.test.id });
          expect(await json(`${ADMIN + path}/tests`)).toEqual({ tests: [] });

          const draftBefore = await json(`${ADMIN + path}/draft`);
          const invalid = await client.callTool({
            name: "apply_config",
            arguments: {
              ...a,
              config: {
                behaviour: { fallbackText: "Should not be written." },
                tests: [{ question: "Never stored?", expectation }],
                mcpServers: [
                  { url: "https://missing.example/mcp", sendConversationContext: false },
                ],
              },
            },
          });
          expect(invalid.isError).toBe(true);
          expect(await json(`${ADMIN + path}/draft`)).toEqual(draftBefore);
          expect(await json(`${ADMIN + path}/tests`)).toEqual({ tests: [] });
          await call("apply_config", {
            ...a,
            config: {
              behaviour: { fallbackText: "Applied by the operator." },
              tests: [{ question: "Applied test?", expectation }],
              mcpServers: [{ url: TOOL_URL, sendConversationContext: false }],
            },
          });
          expect(await json(`${ingestPath}/config`, "GET", undefined, ingestKey)).toMatchObject({
            config: { behaviour: { fallbackText: "Applied by the operator." } },
          });
          expect(await json(`${ADMIN + path}/tests`)).toMatchObject({
            tests: [expect.objectContaining({ question: "Applied test?" })],
          });
          expect(await json(`${ADMIN + path}/mcp-servers`)).toMatchObject({
            servers: [expect.objectContaining({ sendConversationContext: false })],
          });
          const declaredRun = await call<{ runId: string }>("run_declared_tests", {
            ...a,
            tests: [{ question: "Declared test?", expectation }],
          });
          expect(await json(`${ADMIN + path}/tests`)).toMatchObject({
            tests: [expect.objectContaining({ question: "Declared test?" })],
          });
          expect(await json(`${ADMIN + path}/test-runs`)).toMatchObject({
            runs: expect.arrayContaining([expect.objectContaining({ id: declaredRun.runId })]),
          });
          await call("remove_tool_server", m);
          expect(await json(`${ADMIN + path}/mcp-servers`)).toEqual({ servers: [] });
        },
      ),
    20_000,
  );

  it(
    "keeps preview, report, conversation, gap and topic operations in parity",
    () =>
      withOperatorClient(async ({ call, equivalent, json, http, createFixtureAssistant }) => {
        const { assistant, assistantId, a, path } = await createFixtureAssistant();

        const previewBody = {
          assistant: assistant.publicKey,
          message: "Preview question?",
          visitorId: "preview-operator",
        };
        const preview = await call<{
          answer: string;
          events: Array<{ type: string; messageId?: string; id?: string }>;
        }>("preview_answer", { body: previewBody });
        const browserPreview = await http(`${ADMIN}/chat`, "POST", {
          ...previewBody,
          protocol: CHAT_PROTOCOL_VERSION,
        });
        expect(await browserPreview.text()).toContain(preview.answer);
        const done = preview.events.find(({ type }) => type === "done");
        const traceId = done?.messageId ?? done?.id;
        expect(traceId).toBeDefined();
        await equivalent("get_preview_trace", `${path}/preview-traces/${traceId}`, {
          ...a,
          traceId,
        });

        const { conversationId, questionId, replyId, question } =
          await seedConversation(assistantId);
        const c = { conversationId };
        const convo = `/conversations/${conversationId}`;
        await equivalent("get_overview", `${path}/overview`, a);
        await equivalent("get_report", `${path}/report?days=7`, { ...a, days: 7 });
        await equivalent("list_conversations", `${path}/conversations?filter=unanswered&limit=1`, {
          ...a,
          filter: "unanswered",
          limit: 1,
        });
        await equivalent("get_conversation", convo, c);
        expect(await json(ADMIN + convo)).toMatchObject({
          turns: expect.arrayContaining([
            expect.objectContaining({ feedback: [expect.objectContaining({ value: "down" })] }),
          ]),
        });
        await equivalent("get_answer_trace", `${convo}/messages/${replyId}/trace`, {
          ...c,
          messageId: replyId,
        });
        await equivalent("list_gaps", `${path}/gaps?status=open`, { ...a, status: "open" });
        await call("dismiss_gap", { ...a, body: { question } });
        const dismissed = await json(`${ADMIN + path}/gaps?status=open`);
        expect(JSON.stringify(dismissed)).not.toContain(question);
        await call("restore_gap", { ...a, body: { question } });
        expect(JSON.stringify(await json(`${ADMIN + path}/gaps?status=open`))).toContain(question);
        const answer = await call<{ documentId: string }>("write_answer", {
          ...a,
          body: {
            question,
            answer: "International shipping is available.",
            fromMessageId: questionId,
          },
        });
        expect(JSON.stringify(await json(ADMIN + convo))).toContain(answer.documentId);
        await equivalent("list_topics", `${path}/topics`, a);
        await call("rename_topic", { ...a, topicId: SHIPPING_TOPIC, body: { name: "Delivery" } });
        expect(JSON.stringify(await json(`${ADMIN + path}/topics`))).toContain("Delivery");
        await call("merge_topic", {
          ...a,
          topicId: SHIPPING_TOPIC,
          body: { into: ORDERS_TOPIC },
        });
        expect(JSON.stringify(await json(`${ADMIN + path}/topics`))).not.toContain("Delivery");
        await call("delete_topic", { ...a, topicId: ORDERS_TOPIC });
        expect(JSON.stringify(await json(`${ADMIN + path}/topics`))).not.toContain(ORDERS_TOPIC);
      }),
    20_000,
  );

  afterAll(() => {
    expect([...checked].sort()).toEqual(operatorTools.map(({ name }) => name).sort());
  });

  it("uses the same hosted authorization decisions for a principal on both surfaces", async () => {
    const app = createApp(
      fakeSeams({
        auth: {
          authorizeAdmin: (_principal, name) => name !== "list_assistants",
          operator: {
            authenticate: async () => ({ principal: OWNER, scope: "full" }),
            metadataUrl: () => `${ORIGIN}/metadata`,
          },
        },
      }),
    );
    const request = (path: string, init?: RequestInit) =>
      app.fetch(new Request(ORIGIN + path, init), env, createExecutionContext());
    expect((await request(`${ADMIN}/assistants`)).status).toBe(403);
    const response = await request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_assistants" },
      }),
    });
    expect(await response.json()).toMatchObject({ result: { isError: true } });
  });
});

async function seedConversation(assistantId: string) {
  const conversationId = "parity-conversation";
  const questionId = "parity-question";
  const replyId = "parity-reply";
  const question = "Do you ship overseas?";
  const now = Date.now() - 10_000;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url) VALUES (?, ?, ?, 'visitor-1', ?, '')",
    ).bind(conversationId, TEST_ORG_ID, assistantId, now),
    env.DB.prepare(
      "INSERT INTO topics (id, org_id, assistant_id, name, name_key, created_at) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)",
    ).bind(
      SHIPPING_TOPIC,
      TEST_ORG_ID,
      assistantId,
      "Shipping",
      "shipping",
      now,
      ORDERS_TOPIC,
      TEST_ORG_ID,
      assistantId,
      "Orders",
      "orders",
      now,
    ),
    env.DB.prepare(
      "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, created_at, question_key, topic_id) VALUES (?, ?, ?, 'user', ?, '[]', 1, ?, ?, ?)",
    ).bind(
      questionId,
      TEST_ORG_ID,
      conversationId,
      question,
      now,
      normalizeQuestionText(question),
      SHIPPING_TOPIC,
    ),
    env.DB.prepare(
      "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, created_at, reply_to) VALUES (?, ?, ?, 'assistant', 'No answer.', '[]', 0, ?, ?)",
    ).bind(replyId, TEST_ORG_ID, conversationId, now + 1, questionId),
    env.DB.prepare(
      "INSERT INTO feedback (id, org_id, message_id, visitor_id, value, note, created_at) VALUES ('parity-feedback', ?, ?, 'visitor-1', 'down', 'Need details', ?)",
    ).bind(TEST_ORG_ID, replyId, now + 2),
  ]);
  return { conversationId, questionId, replyId, question };
}
