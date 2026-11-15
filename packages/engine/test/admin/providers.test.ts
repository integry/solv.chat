import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, AppOptions, Env } from "../../src/app.js";
import { createApp } from "../../src/app.js";
import { secretKeys } from "../../src/seams/open/secretKeys.js";
import { sealSecret } from "../../src/security/secretBox.js";
import { directoryResolveOrg, fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

const ORG_A = TEST_ORG_ID;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const SECRET_KEY = "test-secret-key-for-provider-settings";
const TEST_KEY_CANARY = "sk-test-canary-never-leak-998877";

function appFor(
  orgId: string,
  runtimeEnv: Partial<Env> = {},
  options?: AppOptions,
  managedKeys = false,
): { app: App; testEnv: Env } {
  const testEnv: Env = {
    ...env,
    SOLV_SECRET_KEY: SECRET_KEY,
    ...runtimeEnv,
  };
  const baseKeys = secretKeys(testEnv, testEnv.DB);
  const seams = fakeSeams({
    auth: {
      async authenticate() {
        return { orgId, userId: "owner", role: "owner" };
      },
      resolveOrg: directoryResolveOrg,
    },
    keys: managedKeys
      ? {
          managed: true,
          modelKey: baseKeys.modelKey,
          embeddingKey: baseKeys.embeddingKey,
        }
      : baseKeys,
  });
  return { app: createApp(seams, options), testEnv };
}

async function call(
  app: App,
  testEnv: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD" && !headers.has("origin")) {
    headers.set("origin", "https://example.com");
  }
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`https://example.com${path}`, { ...init, method, headers }),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("admin provider settings & keys", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM rate_counters"),
      env.DB.prepare("DELETE FROM org_provider_keys"),
      env.DB.prepare("DELETE FROM org_provider_settings"),
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

  it("resolves precedence (stored > environment > default) and falls back on removal", async () => {
    // 1. Built-in defaults when neither stored nor env is set
    const { app: appA, testEnv: envDefaults } = appFor(ORG_A, {
      SOLV_LLM_PROVIDER: undefined,
      SOLV_LLM_TIER: undefined,
      SOLV_LLM_MODEL: undefined,
      SOLV_EMBEDDINGS_PROVIDER: undefined,
      SOLV_ANTHROPIC_KEY: undefined,
      SOLV_OPENAI_KEY: undefined,
      SOLV_OPENROUTER_KEY: undefined,
    });
    const resDefault = await call(appA, envDefaults, "/api/admin/providers");
    expect(resDefault.status).toBe(200);
    const bodyDefault = (await resDefault.json()) as {
      settings: Record<string, { value: unknown; source: string }>;
      keys: Record<string, { source: string; updatedAt: number | null; unreadable: boolean }>;
      configError: string | null;
    };
    expect(bodyDefault.settings.llmProvider).toEqual({ value: "anthropic", source: "none" });
    expect(bodyDefault.settings.llmTier).toEqual({ value: "fast", source: "none" });
    expect(bodyDefault.settings.llmModel).toEqual({ value: null, source: "none" });
    expect(bodyDefault.settings.embeddingsProvider).toEqual({ value: "openai", source: "none" });
    expect(bodyDefault.keys.anthropic.source).toBe("none");
    expect(bodyDefault.configError).toContain("Settings → Providers");
    expect(bodyDefault.configError).toContain("SOLV_ANTHROPIC_KEY");

    // 2. Environment variables take effect when nothing is stored
    const { app: appEnv, testEnv: envVars } = appFor(ORG_A, {
      SOLV_LLM_PROVIDER: "openai",
      SOLV_LLM_TIER: "balanced",
      SOLV_LLM_MODEL: "vendor/from-env",
      SOLV_EMBEDDINGS_PROVIDER: "openrouter",
      SOLV_OPENAI_KEY: "sk-env-openai",
    });
    const resEnv = await call(appEnv, envVars, "/api/admin/providers");
    const bodyEnv = (await resEnv.json()) as typeof bodyDefault;
    expect(bodyEnv.settings.llmProvider).toEqual({ value: "openai", source: "environment" });
    expect(bodyEnv.settings.llmTier).toEqual({ value: "balanced", source: "environment" });
    expect(bodyEnv.settings.llmModel).toEqual({ value: "vendor/from-env", source: "environment" });
    expect(bodyEnv.settings.embeddingsProvider).toEqual({
      value: "openrouter",
      source: "environment",
    });
    expect(bodyEnv.keys.openai.source).toBe("environment");
    expect(bodyEnv.configError).toBeNull();

    // 3. Stored settings beat environment variables
    const resPut = await call(appEnv, envVars, "/api/admin/providers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        llmProvider: "openrouter",
        llmModel: "vendor/stored-model",
        embeddingsProvider: "openai",
      }),
    });
    expect(resPut.status).toBe(200);
    const bodyStored = (await resPut.json()) as typeof bodyDefault;
    expect(bodyStored.settings.llmProvider).toEqual({ value: "openrouter", source: "stored" });
    expect(bodyStored.settings.llmModel).toEqual({
      value: "vendor/stored-model",
      source: "stored",
    });
    expect(bodyStored.settings.embeddingsProvider).toEqual({ value: "openai", source: "stored" });
    expect(bodyStored.configError).toContain("SOLV_OPENROUTER_KEY");

    // 4. Clearing stored settings falls back to environment
    const resReset = await call(appEnv, envVars, "/api/admin/providers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        llmProvider: null,
        llmModel: null,
        embeddingsProvider: null,
      }),
    });
    expect(resReset.status).toBe(200);
    const bodyReset = (await resReset.json()) as typeof bodyDefault;
    expect(bodyReset.settings.llmProvider).toEqual({ value: "openai", source: "environment" });
    expect(bodyReset.settings.llmModel).toEqual({ value: "vendor/from-env", source: "environment" });
    expect(bodyReset.settings.embeddingsProvider).toEqual({
      value: "openrouter",
      source: "environment",
    });
  });

  it("never returns or logs a key across any endpoint", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      const { app, testEnv } = appFor(ORG_A, {}, { fetch: fetchMock as unknown as typeof fetch });

      const putRes = await call(app, testEnv, "/api/admin/providers/keys/anthropic", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: TEST_KEY_CANARY }),
      });
      expect(putRes.status).toBe(200);
      expect(await putRes.text()).not.toContain(TEST_KEY_CANARY);

      const getRes = await call(app, testEnv, "/api/admin/providers");
      expect(getRes.status).toBe(200);
      expect(await getRes.text()).not.toContain(TEST_KEY_CANARY);

      const testRes = await call(app, testEnv, "/api/admin/providers/keys/anthropic/test", {
        method: "POST",
      });
      expect(testRes.status).toBe(200);
      expect(await testRes.text()).not.toContain(TEST_KEY_CANARY);

      const delRes = await call(app, testEnv, "/api/admin/providers/keys/anthropic", {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);
      expect(await delRes.text()).not.toContain(TEST_KEY_CANARY);

      for (const spy of [logSpy, warnSpy, errorSpy]) {
        const allArgs = spy.mock.calls.flat().map((x) => JSON.stringify(x));
        for (const line of allArgs) {
          expect(line).not.toContain(TEST_KEY_CANARY);
        }
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("refuses storing a key when SOLV_SECRET_KEY is missing", async () => {
    const { app, testEnv } = appFor(ORG_A, { SOLV_SECRET_KEY: undefined });
    const res = await call(app, testEnv, "/api/admin/providers/keys/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: TEST_KEY_CANARY }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("SOLV_SECRET_KEY");
  });

  it("reports unreadable stored key without falling back to Worker secret", async () => {
    // Seal with an old secret key
    const oldCiphertext = await sealSecret("old-secret-key", "sk-stored-old");
    await env.DB.prepare(
      "INSERT INTO org_provider_keys (org_id, provider, secret_ciphertext, updated_at) VALUES (?1, 'anthropic', ?2, ?3)",
    )
      .bind(ORG_A, oldCiphertext, Date.now())
      .run();

    // Even with SOLV_ANTHROPIC_KEY set in env, it must NOT silently fall back!
    const { app, testEnv } = appFor(ORG_A, {
      SOLV_SECRET_KEY: "new-rotated-secret-key",
      SOLV_ANTHROPIC_KEY: "sk-env-fallback-must-not-be-used",
      SOLV_OPENAI_KEY: "sk-env-openai",
      SOLV_LLM_PROVIDER: "anthropic",
    });

    const res = await call(app, testEnv, "/api/admin/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: { anthropic: { source: string; unreadable: boolean } };
      configError: string | null;
    };
    expect(body.keys.anthropic.source).toBe("stored");
    expect(body.keys.anthropic.unreadable).toBe(true);
    expect(body.configError).toContain("Anthropic");
    expect(body.configError).toContain("Settings → Providers");

    // Answering must fail rather than using the env secret
    const astId = newId("ast");
    const verId = newId("ver");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at) VALUES (?1, ?2, 'Bot', 'pk_test1234', '[\"https://example.com\"]', ?3)",
      ).bind(astId, ORG_A, Date.now()),
      env.DB.prepare(
        `INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at)
         VALUES (?1, ?2, ?3, 'published', '{"behaviour":{"systemPrompt":"Hi","fallbackText":"No"},"widget":{"title":"Bot"},"limits":{"dailyCostCapMicros":1000000}}', ?4, ?4)`,
      ).bind(verId, ORG_A, astId, Date.now()),
    ]);

    const chatRes = await call(app, testEnv, "/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: 1,
        assistant: "pk_test1234",
        visitorId: "vis_test",
        message: "Hello?",
      }),
    });
    expect(chatRes.status).toBe(200);
    const sseText = await chatRes.text();
    expect(sseText).toContain("event: error");
    expect(sseText).toContain("Something went wrong");
  });

  it("isolates settings and keys per org", async () => {
    const { app: appA, testEnv: envA } = appFor(ORG_A);
    const { app: appB, testEnv: envB } = appFor(ORG_B);

    await call(appA, envA, "/api/admin/providers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ llmProvider: "openrouter", llmModel: "org-a/model" }),
    });
    await call(appA, envA, "/api/admin/providers/keys/openrouter", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "sk-org-a-only" }),
    });

    const resB = await call(appB, envB, "/api/admin/providers");
    const bodyB = (await resB.json()) as {
      settings: { llmProvider: { value: string; source: string }; llmModel: { value: string | null } };
      keys: { openrouter: { source: string } };
    };
    expect(bodyB.settings.llmProvider.value).toBe("anthropic");
    expect(bodyB.settings.llmProvider.source).not.toBe("stored");
    expect(bodyB.settings.llmModel.value).toBeNull();
    expect(bodyB.keys.openrouter.source).toBe("none");
  });

  it("uses stored provider and stored key on chat requests", async () => {
    const seenHeaders: Array<{ url: string; auth: string | null; xApiKey: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      seenHeaders.push({
        url,
        auth: headers.get("authorization"),
        xApiKey: headers.get("x-api-key"),
      });
      if (url.includes("/embeddings")) {
        return Response.json({
          data: [{ embedding: new Array(1536).fill(0.01) }],
          usage: { total_tokens: 3 },
        });
      }
      // OpenRouter SSE response
      const sse =
        'data: {"choices":[{"delta":{"content":"Hello from stored key"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":4,"cost":0.0001}}\n\n' +
        "data: [DONE]\n\n";
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const { app, testEnv } = appFor(
      ORG_A,
      {
        SOLV_LLM_PROVIDER: "anthropic",
        SOLV_ANTHROPIC_KEY: "sk-env-anthropic",
        SOLV_OPENAI_KEY: "sk-env-openai",
      },
      {
        fetch: fetchMock as unknown as typeof fetch,
        chat: {
          fetch: fetchMock as unknown as typeof fetch,
          retriever: {
            async query() {
              return [{ chunkId: "chk_1", score: 0.9 }];
            },
            async upsert() {},
            async remove() {},
          },
        },
      },
    );

    // Store OpenRouter provider + model + OpenRouter key, and OpenAI key for embeddings
    await call(app, testEnv, "/api/admin/providers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        llmProvider: "openrouter",
        llmModel: "vendor/stored-chat",
        embeddingsProvider: "openrouter",
      }),
    });
    await call(app, testEnv, "/api/admin/providers/keys/openrouter", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "sk-stored-openrouter-123" }),
    });

    // Seed assistant + published version + one chunk so retrieval hits and calls the LLM
    const astId = newId("ast");
    const verId = newId("ver");
    const srcId = newId("src");
    const docId = newId("doc");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at) VALUES (?1, ?2, 'Bot', 'pk_stored_chat', '[\"https://example.com\"]', ?3)",
      ).bind(astId, ORG_A, Date.now()),
      env.DB.prepare(
        `INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at)
         VALUES (?1, ?2, ?3, 'published', '{"behaviour":{"systemPrompt":"Hi","fallbackText":"No"},"widget":{"title":"Bot"},"limits":{"dailyCostCapMicros":1000000}}', ?4, ?4)`,
      ).bind(verId, ORG_A, astId, Date.now()),
      env.DB.prepare(
        "INSERT INTO sources (id, org_id, assistant_id, kind, label, created_at) VALUES (?1, ?2, ?3, 'entry', 'Docs', ?4)",
      ).bind(srcId, ORG_A, astId, Date.now()),
      env.DB.prepare(
        "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, 'ext1', 'https://example.com/docs', 'Docs', 'h1', ?4)",
      ).bind(docId, ORG_A, srcId, Date.now()),
      env.DB.prepare(
        "INSERT INTO chunks (id, org_id, document_id, ordinal, text, heading_path) VALUES ('chk_1', ?1, ?2, 0, 'Helpful documentation.', '')",
      ).bind(ORG_A, docId),
    ]);

    const chatRes = await call(app, testEnv, "/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: 1,
        assistant: "pk_stored_chat",
        visitorId: "vis_test",
        message: "What is this?",
      }),
    });
    expect(chatRes.status).toBe(200);
    const sseText = await chatRes.text();
    expect(sseText).toContain("Hello from stored key");

    const embedCall = seenHeaders.find((c) => c.url.includes("openrouter.ai/api/v1/embeddings"));
    expect(embedCall?.auth).toBe("Bearer sk-stored-openrouter-123");
    const chatCall = seenHeaders.find((c) => c.url.includes("openrouter.ai/api/v1/chat/completions"));
    expect(chatCall?.auth).toBe("Bearer sk-stored-openrouter-123");
  });

  it("tests keys with categories, never forwards provider body, and enforces rate limit", async () => {
    let mode: "ok" | "unauth" | "rate" | "throw" = "ok";
    const fetchMock = vi.fn(async () => {
      if (mode === "throw") throw new Error("network down");
      const status = mode === "ok" ? 200 : mode === "unauth" ? 401 : 429;
      return new Response("SENSITIVE_PROVIDER_BODY_DO_NOT_ECHO", { status });
    });

    const { app, testEnv } = appFor(
      ORG_A,
      { SOLV_OPENAI_KEY: "sk-openai-test" },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    const okRes = await call(app, testEnv, "/api/admin/providers/keys/openai/test", {
      method: "POST",
    });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toMatchObject({ ok: true, category: "ok" });

    mode = "unauth";
    const unauthRes = await call(app, testEnv, "/api/admin/providers/keys/openai/test", {
      method: "POST",
    });
    const unauthText = await unauthRes.text();
    expect(unauthText).not.toContain("SENSITIVE_PROVIDER_BODY_DO_NOT_ECHO");
    expect(JSON.parse(unauthText)).toMatchObject({ ok: false, category: "unauthorised" });

    mode = "throw";
    const unreachRes = await call(app, testEnv, "/api/admin/providers/keys/openai/test", {
      method: "POST",
    });
    expect(await unreachRes.json()).toMatchObject({ ok: false, category: "unreachable" });

    // Exhaust the 10/min rate limit (we already made 3 calls)
    mode = "ok";
    for (let i = 0; i < 7; i++) {
      const r = await call(app, testEnv, "/api/admin/providers/keys/openai/test", {
        method: "POST",
      });
      expect(r.status).toBe(200);
    }
    const limitedRes = await call(app, testEnv, "/api/admin/providers/keys/openai/test", {
      method: "POST",
    });
    expect(limitedRes.status).toBe(429);
  });

  it("hides and refuses key operations when keys are managed", async () => {
    const { app, testEnv } = appFor(ORG_A, {}, undefined, true);
    const getRes = await call(app, testEnv, "/api/admin/providers");
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { keysManaged: boolean };
    expect(body.keysManaged).toBe(true);

    const putKeyRes = await call(app, testEnv, "/api/admin/providers/keys/anthropic", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: TEST_KEY_CANARY }),
    });
    expect(putKeyRes.status).toBe(404);
  });
});
