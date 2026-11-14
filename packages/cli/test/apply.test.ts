import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultVersionConfig } from "@solvchat/core";
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
});
