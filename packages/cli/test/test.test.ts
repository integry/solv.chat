import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";

describe("solv test", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "solv-cli-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prints each test with its reason and exits 0 when all pass", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const calls: Array<{ url: string; method: string; auth?: string | undefined }> = [];

    const code = await runCli(
      ["test", "--endpoint", "https://chat.example.com/", "--assistant", "ast_123"],
      {
        env: { SOLV_INGEST_KEY: "ik_secret_value" },
        log: (line) => logs.push(line),
        errorLog: (line) => errors.push(line),
        fetchImpl: async (input, init) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const headers = (init?.headers ?? {}) as Record<string, string>;
          calls.push({ url, method: init?.method ?? "GET", auth: headers.Authorization });
          return Response.json({
            passed: true,
            results: [
              {
                testId: "tst_1",
                question: "Do you ship to Spain?",
                outcome: "passed",
                reason: 'Said "three days".',
              },
              {
                testId: "tst_2",
                question: "Where is pricing?",
                outcome: "passed",
                reason: "Cited https://docs.example.com/pricing.",
              },
            ],
          });
        },
      },
    );

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(calls).toEqual([
      {
        url: "https://chat.example.com/v1/ingest/ast_123/test-runs",
        method: "POST",
        auth: "Bearer ik_secret_value",
      },
    ]);
    const output = logs.join("\n");
    expect(output).toContain("PASS  Do you ship to Spain?");
    expect(output).toContain('Said "three days".');
    expect(output).toContain("PASS  Where is pricing?");
    expect(output).toContain("2 passed, 0 failed, 0 not run.");
    expect(output).not.toContain("ik_secret_value");
  });

  it("exits 1 and names the test and reason when one fails", async () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const code = await runCli(
      ["test", "--endpoint", "https://chat.example.com", "--assistant", "ast_123"],
      {
        env: { SOLV_INGEST_KEY: "ik_secret_value" },
        log: (line) => logs.push(line),
        errorLog: (line) => errors.push(line),
        fetchImpl: async () =>
          Response.json({
            passed: false,
            results: [
              {
                testId: "tst_1",
                question: "Do you ship to Spain?",
                outcome: "failed",
                reason: 'Did not say "three days".',
              },
            ],
          }),
      },
    );

    expect(code).toBe(1);
    const output = logs.join("\n");
    expect(output).toContain("FAIL  Do you ship to Spain?");
    expect(output).toContain('Did not say "three days".');
    expect(output).toContain("0 passed, 1 failed, 0 not run.");
    expect([...logs, ...errors].join("\n")).not.toContain("ik_secret_value");
  });

  it("exits 1 when a test did not run and prints it distinctly from a failure", async () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const code = await runCli(
      ["test", "--endpoint", "https://chat.example.com", "--assistant", "ast_123"],
      {
        env: { SOLV_INGEST_KEY: "ik_secret_value" },
        log: (line) => logs.push(line),
        errorLog: (line) => errors.push(line),
        fetchImpl: async () =>
          Response.json({
            passed: false,
            stopped: "The run took too long and stopped early.",
            results: [
              {
                testId: "tst_1",
                question: "First question?",
                outcome: "passed",
                reason: 'Said "yes".',
              },
              {
                testId: "tst_2",
                question: "Second question?",
                outcome: "not_run",
                reason: "The run took too long and stopped early.",
              },
            ],
          }),
      },
    );

    expect(code).toBe(1);
    const output = logs.join("\n");
    expect(output).toContain("SKIP  Second question?");
    expect(output).not.toContain("FAIL  Second question?");
    expect(output).toContain("1 passed, 0 failed, 1 not run.");
    expect(errors.join("\n")).toContain("did not run");
  });

  it("supports --dry-run without sending requests and shows removal warning for a file", async () => {
    const configPath = join(root, "solv.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        tests: [
          {
            question: "What is the refund window?",
            expectation: { kind: "contains", phrase: "30 days" },
          },
        ],
      }),
      "utf8",
    );

    const logs: string[] = [];
    let fetched = false;
    const code = await runCli(
      [
        "test",
        configPath,
        "--dry-run",
        "--endpoint",
        "https://chat.example.com",
        "--assistant",
        "ast_123",
      ],
      {
        env: {},
        log: (line) => logs.push(line),
        fetchImpl: async () => {
          fetched = true;
          return Response.json({});
        },
      },
    );

    expect(code).toBe(0);
    expect(fetched).toBe(false);
    const output = logs.join("\n");
    expect(output).toContain("What is the refund window?");
    expect(output).toContain("removed");
  });

  it("applies declared tests before running and prints what was removed", async () => {
    const configPath = join(root, "solv.config.json");
    const declaredTests = [
      { question: "Do you offer SSO?", expectation: { kind: "contains", phrase: "SAML" } },
    ];
    await writeFile(configPath, JSON.stringify({ tests: declaredTests }), "utf8");

    const logs: string[] = [];
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const code = await runCli(
      ["test", configPath, "--endpoint", "https://chat.example.com", "--assistant", "ast_123"],
      {
        env: { SOLV_INGEST_KEY: "ik_secret_value" },
        log: (line) => logs.push(line),
        fetchImpl: async (input, init) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const method = init?.method ?? "GET";
          const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
          calls.push({ url, method, ...(body !== undefined ? { body } : {}) });
          if (url.endsWith("/tests")) {
            return Response.json({ created: 1, removed: 3 });
          }
          return Response.json({
            passed: true,
            results: [
              {
                testId: "tst_1",
                question: "Do you offer SSO?",
                outcome: "passed",
                reason: 'Said "SAML".',
              },
            ],
          });
        },
      },
    );

    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      url: "https://chat.example.com/v1/ingest/ast_123/tests",
      method: "PUT",
      body: { tests: declaredTests },
    });
    expect(calls[1]?.url).toBe("https://chat.example.com/v1/ingest/ast_123/test-runs");
    expect(calls[1]?.method).toBe("POST");

    const output = logs.join("\n");
    expect(output).toContain("will be removed");
    expect(output).toContain("Applied 1 tests");
    expect(output).toContain("3 removed");
  });

  it("fails before any request when SOLV_INGEST_KEY is missing", async () => {
    const errors: string[] = [];
    let fetched = false;

    const code = await runCli(
      ["test", "--endpoint", "https://chat.example.com", "--assistant", "ast_123"],
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
      status: 429,
      payload: { error: "Ingest limit exceeded." },
      expected: "Ingest limit exceeded.",
    },
    {
      status: 400,
      payload: {
        error: "Bad request",
        errors: ["tests[0].question: must be 1 to 500 characters"],
      },
      expected: "tests[0].question: must be 1 to 500 characters",
    },
  ])(
    "produces a plain message on $status without leaking the credential",
    async ({ status, payload, expected }) => {
      const secretKey = "ik_never_echo_this_secret";
      const errors: string[] = [];

      const code = await runCli(
        ["test", "--endpoint", "https://chat.example.com", "--assistant", "ast_123"],
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

  it("rejects extra positional arguments before making any request", async () => {
    const errors: string[] = [];
    let fetched = false;

    const code = await runCli(
      [
        "test",
        "first.config.json",
        "second.config.json",
        "--endpoint",
        "https://chat.example.com",
        "--assistant",
        "ast_123",
      ],
      {
        env: { SOLV_INGEST_KEY: "ik_secret" },
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
