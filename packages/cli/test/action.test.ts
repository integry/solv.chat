import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/args.js";

const actionDir = join(dirname(fileURLToPath(import.meta.url)), "..", "action");
const FAKE_KEY = "test-ingest-key-not-real";

/**
 * Runs action/run.sh as the composite step does, with `node` and `npm`
 * replaced by stubs that record their arguments. The script is copied into a
 * fake checkout that already has node_modules and a built CLI, so it skips
 * `npm ci`.
 */
async function setup(root: string) {
  const repo = join(root, "repo");
  const action = join(repo, "packages", "cli", "action");
  await mkdir(action, { recursive: true });
  await mkdir(join(repo, "node_modules"));
  await mkdir(join(repo, "packages", "cli", "dist"));
  await writeFile(join(repo, "packages", "cli", "dist", "index.js"), "");
  await copyFile(join(actionDir, "run.sh"), join(action, "run.sh"));

  const bin = join(root, "bin");
  await mkdir(bin);
  // One record per call: each argument followed by NUL, then a record separator.
  const record = `#!/usr/bin/env bash\n{ printf '%s\\0' "$(basename "$0")" "$@"; printf '\\036'; } >> "$CALL_LOG"\n`;
  for (const name of ["node", "npm"]) {
    await writeFile(join(bin, name), record);
    await chmod(join(bin, name), 0o755);
  }
  return { repo, action, bin, log: join(root, "calls.log") };
}

describe("GitHub Action run.sh", () => {
  let root: string;
  let paths: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "solv-action-"));
    paths = await setup(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function run(inputs: Record<string, string>, ingestKey: string = FAKE_KEY) {
    const env: Record<string, string> = {
      PATH: `${paths.bin}:${process.env.PATH ?? ""}`,
      ACTION_PATH: paths.action,
      CALL_LOG: paths.log,
      SOLV_INGEST_KEY: ingestKey,
    };
    for (const [name, value] of Object.entries(inputs)) {
      env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`] = value;
    }
    const result = spawnSync("bash", [join(paths.action, "run.sh")], { env, encoding: "utf8" });
    let raw = "";
    try {
      raw = await readFile(paths.log, "utf8");
    } catch {
      raw = "";
    }
    const solv = join(paths.repo, "packages", "cli", "bin", "solv.js");
    const calls = raw
      .split("\u001e")
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.split("\0").slice(0, -1))
      .map(([tool, ...args]) => {
        if (tool !== "node") return [tool ?? "", ...args];
        expect(args[0]).toBe(solv);
        return args.slice(1);
      });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  }

  const required = { endpoint: "https://chat.example.com", assistant: "ast_1" };

  it("keeps workflows that pass only the original inputs working", async () => {
    const { status, calls } = await run({
      ...required,
      content: "docs",
      "base-url": "https://docs.example.com",
      prune: "true",
      config: "solv.config.json",
      test: "true",
    });

    expect(status).toBe(0);
    expect(calls.map((call) => call[0])).toEqual(["push", "apply", "test"]);
    expect(calls[0]).toEqual([
      "push",
      "--endpoint",
      "https://chat.example.com",
      "--assistant",
      "ast_1",
      "--base-url",
      "https://docs.example.com",
      "--prune",
      "--",
      "docs",
    ]);
    expect(calls[1]).toEqual([
      "apply",
      "solv.config.json",
      "--endpoint",
      "https://chat.example.com",
      "--assistant",
      "ast_1",
    ]);
    expect(calls[2]).toEqual([
      "test",
      "--endpoint",
      "https://chat.example.com",
      "--assistant",
      "ast_1",
    ]);

    const parsed = parseCliArgs(calls[0] ?? [], {});
    expect(parsed).toEqual({
      kind: "push",
      options: {
        dir: "docs",
        endpoint: "https://chat.example.com",
        assistant: "ast_1",
        baseUrl: "https://docs.example.com",
        prune: true,
        dryRun: false,
      },
    });
  });

  it("passes source, include, exclude and files to solv push, one argument per line", async () => {
    const { status, calls } = await run({
      ...required,
      content: "docs",
      "base-url": "https://docs.example.com/docs",
      source: "docs",
      include: "guides/**\n\n  *.mdx  \n",
      exclude: "**/_*\ndrafts/**",
      files:
        "README.md=https://docs.example.com/\nCHANGELOG.md=https://docs.example.com/changelog?tab=all\n",
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "push",
      "--endpoint",
      "https://chat.example.com",
      "--assistant",
      "ast_1",
      "--base-url",
      "https://docs.example.com/docs",
      "--source",
      "docs",
      "--include",
      "guides/**",
      "--include",
      "*.mdx",
      "--exclude",
      "**/_*",
      "--exclude",
      "drafts/**",
      "--file",
      "README.md=https://docs.example.com/",
      "--file",
      "CHANGELOG.md=https://docs.example.com/changelog?tab=all",
      "--",
      "docs",
    ]);

    const parsed = parseCliArgs(calls[0] ?? [], {});
    expect(parsed).toMatchObject({
      kind: "push",
      options: {
        dir: "docs",
        source: "docs",
        include: ["guides/**", "*.mdx"],
        exclude: ["**/_*", "drafts/**"],
        files: [
          { path: "README.md", url: "https://docs.example.com/" },
          { path: "CHANGELOG.md", url: "https://docs.example.com/changelog?tab=all" },
        ],
        prune: false,
      },
    });
  });

  it("does not expand globs, variables or command substitutions in inputs", async () => {
    const { status, calls } = await run({
      ...required,
      content: "docs",
      "base-url": "https://docs.example.com",
      source: `$(touch pwned) \${HOME}`,
      include: "*",
    });

    expect(status).toBe(0);
    expect(calls[0]).toContain(`$(touch pwned) \${HOME}`);
    expect(
      calls[0]?.slice(calls[0].indexOf("--include"), calls[0].indexOf("--include") + 2),
    ).toEqual(["--include", "*"]);
  });

  it("pushes only extra files without a folder or base-url", async () => {
    const { status, calls } = await run({ ...required, files: "README.md=https://x.dev/" });

    expect(status).toBe(0);
    expect(calls).toEqual([
      [
        "push",
        "--endpoint",
        "https://chat.example.com",
        "--assistant",
        "ast_1",
        "--file",
        "README.md=https://x.dev/",
      ],
    ]);
    expect(parseCliArgs(calls[0] ?? [], {})).toMatchObject({
      kind: "push",
      options: { files: [{ path: "README.md", url: "https://x.dev/" }] },
    });
  });

  it.each([
    [{ assistant: "ast_1" }, FAKE_KEY, "endpoint"],
    [{ endpoint: "https://chat.example.com" }, FAKE_KEY, "assistant"],
    [required, "", "SOLV_INGEST_KEY"],
    [{}, "", "endpoint, assistant, SOLV_INGEST_KEY"],
  ])(
    "skips with a notice and success when %j is all that is set (key %j)",
    async (inputs, key, names) => {
      const { status, stdout, stderr, calls } = await run(
        { ...inputs, content: "docs", "base-url": "https://docs.example.com" },
        key,
      );

      expect(status).toBe(0);
      expect(stdout).toContain(`::notice title=solv.chat sync skipped::Not set: ${names}.`);
      expect(calls).toEqual([]);
      expect(stdout + stderr).not.toContain(FAKE_KEY);
    },
  );

  it.each([
    [{}, "Provide at least one of 'content', 'files', 'config', or 'test: true'."],
    [{ content: "docs" }, "'base-url' is required when 'content' is set."],
    [
      { include: "*.md", config: "solv.config.json" },
      "'include' and 'exclude' choose files in 'content'",
    ],
    [
      { exclude: "*.md", files: "README.md=https://x.dev/" },
      "'include' and 'exclude' choose files in 'content'",
    ],
  ])("fails without running anything for %j", async (inputs, message) => {
    const { status, stderr, calls } = await run({ ...required, ...inputs });

    expect(status).toBe(1);
    expect(stderr).toContain(message);
    expect(calls).toEqual([]);
  });

  it("installs and builds the CLI when the checkout has not been built", async () => {
    await rm(join(paths.repo, "node_modules"), { recursive: true });
    const { status, calls } = await run({ ...required, test: "true" });

    expect(status).toBe(0);
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ["npm", "ci"],
      ["npm", "run"],
      ["test", "--endpoint"],
    ]);
  });
});

describe("GitHub Action action.yml", () => {
  async function readAction() {
    return readFile(join(actionDir, "action.yml"), "utf8");
  }

  function inputNames(yml: string): string[] {
    const block = yml.slice(yml.indexOf("\ninputs:\n"), yml.indexOf("\nruns:\n"));
    return [...block.matchAll(/^ {2}([a-z-]+):$/gm)].map((match) => match[1] ?? "");
  }

  it("passes every input to run.sh through its own environment variable", async () => {
    const yml = await readAction();
    const names = inputNames(yml);
    expect(names).toEqual(
      expect.arrayContaining(["source", "include", "exclude", "files", "content", "base-url"]),
    );
    for (const name of names) {
      const variable = `INPUT_${name.toUpperCase().replace(/-/g, "_")}`;
      expect(yml).toContain(`        ${variable}: \${{ inputs.${name} }}\n`);
    }
    expect(yml).toContain('      run: bash "$ACTION_PATH/run.sh"\n');
    expect(yml.slice(yml.indexOf("run:"))).not.toContain("${{");
  });

  it("does not take the ingest key as an input and does not require endpoint or assistant", async () => {
    const yml = await readAction();
    expect(inputNames(yml).some((name) => /key|token|secret/i.test(name))).toBe(false);
    expect(yml).not.toMatch(/required: true/);
  });

  it("documents only inputs the action declares", async () => {
    const names = new Set(inputNames(await readAction()));
    const readme = await readFile(join(actionDir, "README.md"), "utf8");
    const blocks = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      const withAt = block.indexOf(" with:\n");
      expect(withAt).toBeGreaterThan(0);
      const lines = block.slice(withAt).split("\n").slice(1);
      const indent = /^ */.exec(lines[0] ?? "")?.[0].length ?? 0;
      const keys = lines
        .filter((line) => new RegExp(`^ {${indent}}[a-z-]+:`).test(line))
        .map((line) => line.trim().split(":")[0]);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) expect(names).toContain(key);
      expect(block).toContain(`SOLV_INGEST_KEY: \${{ secrets.SOLV_INGEST_KEY }}`);
    }
  });
});
