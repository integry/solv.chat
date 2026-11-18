import { describe, expect, it } from "vitest";
import { PUSH_HELP, parseCliArgs } from "../src/args.js";
import { globToRegExp, selectPaths } from "../src/glob.js";
import { CliError } from "../src/http.js";

const base = ["push", "--endpoint", "https://chat.example.com", "--assistant", "ast_1"];

function pushOptions(args: string[]) {
  const parsed = parseCliArgs([...base, ...args], {});
  if (parsed.kind !== "push") throw new Error(`expected push, got ${parsed.kind}`);
  return parsed.options;
}

function pushError(args: string[]): string {
  try {
    parseCliArgs([...base, ...args], {});
  } catch (err) {
    if (err instanceof CliError) return err.message;
    throw err;
  }
  throw new Error("expected a CliError");
}

describe("solv push options", () => {
  it("collects repeatable --include, --exclude and --file, and --source", () => {
    const options = pushOptions([
      "docs",
      "--base-url",
      "https://acme.dev/docs",
      "--include",
      "guides/**",
      "--include",
      "*.mdx",
      "--exclude",
      "**/_*",
      "--file",
      "README.md=https://acme.dev/",
      "--file",
      "CHANGELOG.md=https://acme.dev/changelog?tab=all",
      "--source",
      "  docs ",
    ]);
    expect(options).toMatchObject({
      dir: "docs",
      include: ["guides/**", "*.mdx"],
      exclude: ["**/_*"],
      files: [
        { path: "README.md", url: "https://acme.dev/" },
        { path: "CHANGELOG.md", url: "https://acme.dev/changelog?tab=all" },
      ],
      source: "docs",
    });
  });

  it("leaves the new options out when they are not given", () => {
    const options = pushOptions(["docs", "--base-url", "https://acme.dev"]);
    expect(options).not.toHaveProperty("include");
    expect(options).not.toHaveProperty("exclude");
    expect(options).not.toHaveProperty("files");
    expect(options).not.toHaveProperty("source");
  });

  it("allows --file without a folder or --base-url", () => {
    const options = pushOptions(["--file", "a=b/README.md=https://x.dev/?a=b"]);
    expect(options.files).toEqual([{ path: "a=b/README.md", url: "https://x.dev/?a=b" }]);
    expect(options.dir).toBeUndefined();
  });

  it.each([
    [["--file", "README.md"], "--file must be <path>=<url>"],
    [["--file", "README.md=/relative"], "--file must be <path>=<url>"],
    [["--file", "=https://x.dev/"], "--file must be <path>=<url>"],
    [["--json", "b.json", "--file", "R.md=https://x.dev/"], "not both"],
    [
      ["--file", "R.md=https://x.dev/", "--include", "*.md"],
      "--include and --exclude select files in a content directory",
    ],
    [["--json", "b.json", "--exclude", "*.md"], "--include and --exclude select files"],
    [["docs", "--source", "a", "--source-id", "src_1"], "--source or --source-id, not both"],
    [["docs", "--source", "   "], "--source must be 1 to 80 characters"],
    [["docs", "--source", "x".repeat(81)], "--source must be 1 to 80 characters"],
  ])("rejects %j", (args, message) => {
    expect(pushError(args)).toContain(message);
  });

  it("documents every new option in --help", () => {
    for (const flag of ["--include", "--exclude", "--file", "--source ", ".mdx", "Docusaurus"]) {
      expect(PUSH_HELP).toContain(flag);
    }
  });
});

describe("globs", () => {
  const paths = [
    "intro.md",
    "guides/index.md",
    "guides/deep/a.mdx",
    "_partials/_x.md",
    "guides/_hidden.md",
    "blog/2024.md",
  ];

  it.each([
    ["*.md", ["intro.md"]],
    [
      "**/*.md",
      ["intro.md", "guides/index.md", "_partials/_x.md", "guides/_hidden.md", "blog/2024.md"],
    ],
    ["guides/**", ["guides/index.md", "guides/deep/a.mdx", "guides/_hidden.md"]],
    ["**/_*", ["_partials/_x.md", "guides/_hidden.md"]],
    ["**/_*/**", ["_partials/_x.md"]],
    ["guides/*.{md,mdx}", ["guides/index.md", "guides/_hidden.md"]],
    ["?ntro.md", ["intro.md"]],
    ["blog/[0-9]*.md", ["blog/2024.md"]],
    ["blog/[!0-9]*.md", []],
    ["./intro.md", ["intro.md"]],
    ["guides/deep/a.mdx", ["guides/deep/a.mdx"]],
  ])("%s", (pattern, expected) => {
    expect(paths.filter((path) => globToRegExp(pattern).test(path))).toEqual(expected);
  });

  it("treats regular-expression characters literally", () => {
    expect(globToRegExp("a+b(1).md").test("a+b(1).md")).toBe(true);
    expect(globToRegExp("a.md").test("aXmd")).toBe(false);
  });

  it("selects with includes, then removes excludes", () => {
    expect(selectPaths(paths, [], [])).toEqual(paths);
    expect(selectPaths(paths, ["guides/**", "*.md"], ["**/_*"])).toEqual([
      "intro.md",
      "guides/index.md",
      "guides/deep/a.mdx",
    ]);
  });
});
