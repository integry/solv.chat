import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultVersionConfig, MAX_TESTS_PER_RUN } from "@solvchat/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply } from "../src/apply.js";

describe("solv apply", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "solv-cli-apply-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("posts parsed config and prints a diff against the current draft", async () => {
    const configPath = join(root, "solv.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        behaviour: { greeting: "Welcome to Acme!" },
        widget: { accentColor: "#111111" },
      }),
      "utf8",
    );

    const current = defaultVersionConfig();
    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        method,
        headers,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      if (method === "GET") {
        return Response.json({ config: current });
      }
      return Response.json({ config: JSON.parse(String(init?.body)) });
    };

    const logs: string[] = [];
    await apply(
      {
        file: configPath,
        endpoint: "https://chat.example.com",
        assistant: "ast_123",
        ingestKey: "ik_secret_key",
      },
      { fetchImpl, log: (line) => logs.push(line) },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://chat.example.com/v1/ingest/ast_123/config");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.Authorization).toBe("Bearer ik_secret_key");
    expect(calls[0]?.headers.Cookie).toBeUndefined();
    expect(calls[1]?.url).toBe("https://chat.example.com/v1/ingest/ast_123/config");
    expect(calls[1]?.method).toBe("PUT");
    expect(calls[1]?.headers.Authorization).toBe("Bearer ik_secret_key");
    expect(calls[1]?.headers.Origin).toBeUndefined();

    const diffOutput = logs.join("\n");
    expect(diffOutput).toContain('- behaviour.greeting: "Hello. Ask me anything about this site."');
    expect(diffOutput).toContain('+ behaviour.greeting: "Welcome to Acme!"');
    expect(diffOutput).toContain('- widget.accentColor: "#2563eb"');
    expect(diffOutput).toContain('+ widget.accentColor: "#111111"');
    expect(logs.at(-1)).toMatch(/draft/i);
    expect(logs.at(-1)).toMatch(/admin/i);
  });

  it("sends the original partial config and diffs against customized draft settings", async () => {
    const configPath = join(root, "solv.config.json");
    const partial = { behaviour: { greeting: "Welcome" } };
    await writeFile(configPath, JSON.stringify(partial), "utf8");

    const customizedDraft = {
      ...defaultVersionConfig(),
      behaviour: {
        ...defaultVersionConfig().behaviour,
        persona: "Be concise.",
      },
      widget: {
        title: "Custom Support",
        accentColor: "#00aa00",
        position: "left" as const,
      },
      limits: { dailyCostCapMicros: 500_000 },
      allowedTools: ["search_docs"],
    };

    const putBodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({ config: customizedDraft });
      }
      putBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ config: customizedDraft });
    };

    const logs: string[] = [];
    await apply(
      {
        file: configPath,
        endpoint: "https://chat.example.com",
        assistant: "ast_123",
        ingestKey: "ik_secret",
      },
      { fetchImpl, log: (line) => logs.push(line) },
    );

    expect(putBodies).toEqual([partial]);
    const diffOutput = logs.join("\n");
    expect(diffOutput).toContain('- behaviour.greeting: "Hello. Ask me anything about this site."');
    expect(diffOutput).toContain('+ behaviour.greeting: "Welcome"');
    expect(diffOutput).not.toContain("limits.dailyCostCapMicros");
    expect(diffOutput).not.toContain("widget.accentColor");
    expect(diffOutput).not.toContain("allowedTools");
    expect(diffOutput).not.toContain("behaviour.persona");
  });

  it("fails with the field name from packages/core and posts nothing on invalid config", async () => {
    const configPath = join(root, "solv.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        widget: { accentColor: "not-a-hex-color" },
      }),
      "utf8",
    );

    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return Response.json({});
    };

    const logs: string[] = [];
    await expect(
      apply(
        {
          file: configPath,
          endpoint: "https://chat.example.com",
          assistant: "ast_123",
          ingestKey: "ik_secret",
        },
        { fetchImpl, log: (line) => logs.push(line) },
      ),
    ).rejects.toThrow(/widget\.accentColor/);

    expect(called).toBe(false);
    expect(logs.join("\n")).toContain("widget.accentColor");
  });

  it("syncs declared tests and strips the tests key from the config PUT", async () => {
    const configPath = join(root, "solv.config.json");
    const declaredTests = [
      { question: "Where do you ship?", expectation: { kind: "contains", phrase: "worldwide" } },
    ];
    await writeFile(
      configPath,
      JSON.stringify({
        behaviour: { greeting: "Hello from CI" },
        tests: declaredTests,
      }),
      "utf8",
    );

    const current = defaultVersionConfig();
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, ...(body !== undefined ? { body } : {}) });
      if (url.endsWith("/config") && method === "GET") {
        return Response.json({ config: current });
      }
      if (url.endsWith("/config") && method === "PUT") {
        return Response.json({ config: { ...current, ...body } });
      }
      return Response.json({ created: 1, removed: 2 });
    };

    const logs: string[] = [];
    await apply(
      {
        file: configPath,
        endpoint: "https://chat.example.com",
        assistant: "ast_123",
        ingestKey: "ik_secret",
      },
      { fetchImpl, log: (line) => logs.push(line) },
    );

    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toBe("https://chat.example.com/v1/ingest/ast_123/config");
    expect(calls[1]?.method).toBe("PUT");
    expect(calls[1]?.body).toEqual({ behaviour: { greeting: "Hello from CI" } });
    expect(calls[1]?.body).not.toHaveProperty("tests");

    expect(calls[2]?.url).toBe("https://chat.example.com/v1/ingest/ast_123/tests");
    expect(calls[2]?.method).toBe("PUT");
    expect(calls[2]?.body).toEqual({ tests: declaredTests });

    const output = logs.join("\n");
    expect(output).toContain("removed");
    expect(output).toContain("Tests: 1 declared, 2 removed.");
  });

  it("leaves stored tests untouched when solv.config.json has no tests key", async () => {
    const configPath = join(root, "solv.config.json");
    await writeFile(configPath, JSON.stringify({ behaviour: { greeting: "Only config" } }), "utf8");

    const current = defaultVersionConfig();
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({ config: current });
      }
      return Response.json({ config: current });
    };

    await apply(
      {
        file: configPath,
        endpoint: "https://chat.example.com",
        assistant: "ast_123",
        ingestKey: "ik_secret",
      },
      { fetchImpl, log: () => {} },
    );

    expect(urls.every((u) => u.endsWith("/config"))).toBe(true);
  });

  it.each([
    {
      name: "an empty question",
      tests: [{ question: "", expectation: { kind: "declines" } }],
      expected: "tests[0].question",
    },
    {
      name: "an invalid expectation",
      tests: [{ question: "Do you ship?", expectation: { kind: "unknown" } }],
      expected: "tests[0].expectation.kind",
    },
    {
      name: `more than ${MAX_TESTS_PER_RUN} tests`,
      tests: Array.from({ length: MAX_TESTS_PER_RUN + 1 }, (_, i) => ({
        question: `Question ${i + 1}?`,
        expectation: { kind: "declines" },
      })),
      expected: String(MAX_TESTS_PER_RUN),
    },
  ])("rejects $name before sending any config or test mutation", async ({ tests, expected }) => {
    const configPath = join(root, "solv.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        behaviour: { greeting: "Valid change" },
        tests,
      }),
      "utf8",
    );

    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return Response.json({});
    };

    const logs: string[] = [];
    await expect(
      apply(
        {
          file: configPath,
          endpoint: "https://chat.example.com",
          assistant: "ast_123",
          ingestKey: "ik_secret",
        },
        { fetchImpl, log: (line) => logs.push(line) },
      ),
    ).rejects.toThrow(expected);

    expect(called).toBe(false);
    expect(logs.join("\n")).toContain(expected);
  });

  /**
   * A stand-in for the engine's ingest routes, with the same rules for
   * `mcp-servers`: an address must exist, the ingest key can turn the setting
   * off but not on, a dry run changes nothing, and servers are shown by origin.
   */
  function fakeEngine(initial: Array<[string, boolean]>) {
    const stored = new Map(initial);
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, ...(body === undefined ? {} : { body }) });
      if (url.endsWith("/mcp-servers")) {
        const request = body as {
          servers: Array<{ url: string; sendConversationContext: boolean }>;
          dryRun?: boolean;
        };
        const errors: string[] = [];
        request.servers.forEach((s, i) => {
          if (!stored.has(s.url)) errors.push(`mcpServers[${i}].url: no tool server`);
          else if (s.sendConversationContext && !stored.get(s.url)) {
            errors.push(
              `mcpServers[${i}]: turn on "Send conversation context" for Orders (${new URL(s.url).origin}) on the Tools screen in the admin. The ingest key can turn it off but not on.`,
            );
          }
        });
        if (errors.length > 0) return Response.json({ errors }, { status: 400 });
        let changed = 0;
        for (const s of request.servers) {
          if (stored.get(s.url) !== s.sendConversationContext) changed += 1;
          if (!request.dryRun) stored.set(s.url, s.sendConversationContext);
        }
        return Response.json({
          servers: [...stored].map(([u, on]) => ({
            label: "Orders",
            origin: new URL(u).origin,
            sendConversationContext: on,
          })),
          changed,
          dryRun: request.dryRun === true,
        });
      }
      if (method === "GET") return Response.json({ config: defaultVersionConfig() });
      return Response.json({});
    };
    return { stored, calls, fetchImpl };
  }

  const options = (file: string) => ({
    file,
    endpoint: "https://chat.example.com",
    assistant: "ast_123",
    ingestKey: "ik_secret_key",
  });

  it("checks mcpServers first, then sets the setting and keeps it out of the config PUT", async () => {
    const configPath = join(root, "solv.config.json");
    const serverUrl = "https://tools.example.com/mcp?token=url_secret";
    await writeFile(
      configPath,
      JSON.stringify({
        behaviour: { greeting: "Welcome" },
        mcpServers: [{ url: serverUrl, sendConversationContext: false }],
      }),
      "utf8",
    );
    const engine = fakeEngine([[serverUrl, true]]);

    const logs: string[] = [];
    await apply(options(configPath), {
      fetchImpl: engine.fetchImpl,
      log: (line) => logs.push(line),
    });

    // The dry run comes before any write.
    expect(engine.calls.map((c) => `${c.method} ${c.url.split("/").at(-1)}`)).toEqual([
      "GET config",
      "PUT mcp-servers",
      "PUT config",
      "PUT mcp-servers",
    ]);
    expect(engine.calls[1]?.body).toEqual({
      servers: [{ url: serverUrl, sendConversationContext: false }],
      dryRun: true,
    });
    expect(engine.calls[2]?.body).toEqual({ behaviour: { greeting: "Welcome" } });
    expect(engine.calls[3]?.body).toEqual({
      servers: [{ url: serverUrl, sendConversationContext: false }],
    });
    expect(engine.stored.get(serverUrl)).toBe(false);
    expect(logs).toContain(
      "Tool server Orders (https://tools.example.com): send conversation context off.",
    );
    expect(logs).toContain("Tool servers: 1 changed.");
    expect(logs.join("\n")).not.toContain("url_secret");

    // Applying the same file again changes nothing.
    logs.length = 0;
    await apply(options(configPath), {
      fetchImpl: engine.fetchImpl,
      log: (line) => logs.push(line),
    });
    expect(logs).toContain("Tool servers: 0 changed.");
  });

  it("asks for on where a server is already on without failing", async () => {
    const configPath = join(root, "solv.config.json");
    const serverUrl = "https://tools.example.com/mcp";
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: [{ url: serverUrl, sendConversationContext: true }] }),
      "utf8",
    );
    const engine = fakeEngine([[serverUrl, true]]);
    const logs: string[] = [];
    await apply(options(configPath), {
      fetchImpl: engine.fetchImpl,
      log: (line) => logs.push(line),
    });
    expect(logs).toContain(
      "Tool server Orders (https://tools.example.com): send conversation context on.",
    );
    expect(logs).toContain("Tool servers: 0 changed.");
  });

  it("writes nothing and names the server when on is asked for where it is off", async () => {
    const configPath = join(root, "solv.config.json");
    const offUrl = "https://tools.example.com/mcp";
    const onUrl = "https://other.example.com/mcp";
    await writeFile(
      configPath,
      JSON.stringify({
        behaviour: { greeting: "Welcome" },
        tests: [{ question: "What is Acme?", expectation: { kind: "declines" } }],
        mcpServers: [
          { url: onUrl, sendConversationContext: false },
          { url: offUrl, sendConversationContext: true },
        ],
      }),
      "utf8",
    );
    const engine = fakeEngine([
      [offUrl, false],
      [onUrl, true],
    ]);
    const logs: string[] = [];
    await expect(
      apply(options(configPath), {
        fetchImpl: engine.fetchImpl,
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow(/mcpServers\[1\]: turn on "Send conversation context" for Orders/);

    // Only the read and the dry run: no config, tests or server write.
    expect(engine.calls.map((c) => `${c.method} ${c.url.split("/").at(-1)}`)).toEqual([
      "GET config",
      "PUT mcp-servers",
    ]);
    expect(engine.calls[1]?.body).toMatchObject({ dryRun: true });
    expect(engine.stored.get(onUrl)).toBe(true);
    expect(engine.stored.get(offUrl)).toBe(false);
    expect(logs).toContain(
      'mcpServers[1]: turn on "Send conversation context" for Orders (https://tools.example.com) on the Tools screen in the admin. The ingest key can turn it off but not on.',
    );
    expect(logs).toContain("Nothing was changed: not the draft, the tests or any tool server.");
  });

  it("writes nothing when an mcpServers address has no server", async () => {
    const configPath = join(root, "solv.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        behaviour: { greeting: "Welcome" },
        mcpServers: [{ url: "https://missing.example.com/mcp", sendConversationContext: false }],
      }),
      "utf8",
    );
    const engine = fakeEngine([]);
    await expect(
      apply(options(configPath), { fetchImpl: engine.fetchImpl, log: () => {} }),
    ).rejects.toThrow(/mcpServers\[0\]\.url/);
    expect(
      engine.calls.filter((c) => c.method === "PUT" && !c.url.endsWith("/mcp-servers")),
    ).toEqual([]);
  });

  it("refuses an invalid mcpServers entry before sending anything", async () => {
    const configPath = join(root, "solv.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: [{ url: "http://tools.example.com/mcp", sendConversationContext: "yes" }],
      }),
      "utf8",
    );
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return Response.json({});
    };
    const logs: string[] = [];
    await expect(
      apply(
        {
          file: configPath,
          endpoint: "https://chat.example.com",
          assistant: "ast_123",
          ingestKey: "ik_secret_key",
        },
        { fetchImpl, log: (line) => logs.push(line) },
      ),
    ).rejects.toThrow(/mcpServers\[0\]\.url/);
    expect(calls).toEqual([]);
  });
});
