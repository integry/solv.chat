import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";

describe("solv CLI", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "solv-cli-main-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("--help lists only push and apply and names env vars without values", async () => {
    const logs: string[] = [];
    const code = await runCli(["--help"], {
      log: (line) => logs.push(line),
      env: { SOLV_INGEST_KEY: "super-secret-value" },
    });

    expect(code).toBe(0);
    const help = logs.join("\n");
    expect(help).toContain("push");
    expect(help).toContain("apply");
    expect(help).toContain("SOLV_INGEST_KEY");
    expect(help).toContain("SOLV_ADMIN_TOKEN");
    expect(help).toContain("SOLV_SESSION");
    expect(help).not.toContain("super-secret-value");
    expect(help).not.toMatch(/\btest\b/);
  });

  it("fails with a message naming SOLV_INGEST_KEY when missing", async () => {
    await writeFile(join(root, "doc.md"), "# Doc\n\nText\n", "utf8");
    const errors: string[] = [];
    let fetched = false;

    const code = await runCli(
      [
        "push",
        root,
        "--endpoint",
        "https://chat.example.com",
        "--assistant",
        "ast_123",
        "--base-url",
        "https://docs.example.com",
      ],
      {
        env: {},
        errorLog: (line) => errors.push(line),
        fetchImpl: async () => {
          fetched = true;
          return Response.json({});
        },
      },
    );

    expect(code).toBe(1);
    expect(fetched).toBe(false);
    expect(errors.join("\n")).toContain("SOLV_INGEST_KEY");
  });

  it.each([
    {
      status: 401,
      payload: { error: "Unauthorized." },
      expected: "401",
    },
    {
      status: 413,
      payload: { error: "batch exceeds 100 documents" },
      expected: "batch exceeds 100 documents",
    },
    {
      status: 400,
      payload: {
        error: "Bad request",
        errors: ["externalId: must be 1 to 200 characters"],
      },
      expected: "externalId: must be 1 to 200 characters",
    },
  ])(
    "exits non-zero with a plain message on $status without echoing the key",
    async ({ status, payload, expected }) => {
      await writeFile(join(root, "doc.md"), "# Doc\n\nText\n", "utf8");
      const secretKey = "ing_never_echo_this_secret";
      const errors: string[] = [];

      const code = await runCli(
        [
          "push",
          root,
          "--endpoint",
          "https://chat.example.com",
          "--assistant",
          "ast_123",
          "--base-url",
          "https://docs.example.com",
        ],
        {
          env: { SOLV_INGEST_KEY: secretKey },
          errorLog: (line) => errors.push(line),
          fetchImpl: async () => Response.json(payload, { status }),
        },
      );

      expect(code).toBe(1);
      const output = errors.join("\n");
      expect(output).toContain(expected);
      expect(output).not.toContain(secretKey);
    },
  );

  it("rejects extra positional arguments on push --prune without making requests", async () => {
    const errors: string[] = [];
    let fetched = false;

    const code = await runCli(
      [
        "push",
        "docs-a",
        "docs-b",
        "--prune",
        "--endpoint",
        "https://chat.example.com",
        "--assistant",
        "ast_123",
        "--base-url",
        "https://docs.example.com",
      ],
      {
        env: { SOLV_INGEST_KEY: "ing_secret" },
        errorLog: (line) => errors.push(line),
        fetchImpl: async () => {
          fetched = true;
          return Response.json({});
        },
      },
    );

    expect(code).toBe(1);
    expect(fetched).toBe(false);
    expect(errors.join("\n")).toContain("docs-b");
  });

  it("rejects extra positional arguments on apply without making requests", async () => {
    const errors: string[] = [];
    let fetched = false;

    const code = await runCli(
      [
        "apply",
        "first.config.json",
        "second.config.json",
        "--endpoint",
        "https://chat.example.com",
        "--assistant",
        "ast_123",
      ],
      {
        env: { SOLV_ADMIN_TOKEN: "tok_secret" },
        errorLog: (line) => errors.push(line),
        fetchImpl: async () => {
          fetched = true;
          return Response.json({});
        },
      },
    );

    expect(code).toBe(1);
    expect(fetched).toBe(false);
    expect(errors.join("\n")).toContain("second.config.json");
  });
});
