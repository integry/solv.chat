import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkAllPackages, checkPackagePack } from "./pack-check.mjs";
import { parseReleaseTag, setPublishableVersions } from "./set-version.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function createValidPackageFixture(dir: string): void {
  writeJson(path.join(dir, "package.json"), {
    name: "@solvchat/fixture",
    version: "1.0.0",
    license: "Apache-2.0",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    files: ["dist"],
  });
  writeFileSync(path.join(dir, "LICENSE"), "Apache-2.0\n", "utf8");
  mkdirSync(path.join(dir, "dist"), { recursive: true });
  writeFileSync(path.join(dir, "dist/index.js"), "export const x = 1;\n", "utf8");
  writeFileSync(path.join(dir, "dist/index.d.ts"), "export declare const x: number;\n", "utf8");
  writeJson(path.join(dir, "dist/index.js.map"), {
    version: 3,
    file: "index.js",
    sources: ["../src/index.ts"],
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("set-version", () => {
  it("parses valid v<semver> tags", () => {
    expect(parseReleaseTag("v1.2.3")).toBe("1.2.3");
    expect(parseReleaseTag("v0.1.0-beta.1")).toBe("0.1.0-beta.1");
    expect(parseReleaseTag("v2.0.0+build.5")).toBe("2.0.0+build.5");
  });

  it("rejects invalid tags", () => {
    for (const bad of ["", "1.2.3", "v1.2", "v01.2.3", "v1.2.3 ", "latest", undefined]) {
      expect(() => parseReleaseTag(bad as string)).toThrow(/Invalid release tag/);
    }
  });

  it("sets version and pins internal dependencies across all publishable packages", () => {
    const root = makeTempDir("solv-ver-");
    writeJson(path.join(root, "packages/core/package.json"), {
      name: "@solvchat/core",
      version: "0.0.0",
    });
    writeJson(path.join(root, "packages/widget/package.json"), {
      name: "@solvchat/widget",
      version: "0.0.0",
      devDependencies: {
        "@solvchat/core": "^0.0.0",
        esbuild: "^0.25.0",
      },
    });
    writeJson(path.join(root, "packages/cli/package.json"), {
      name: "@solvchat/cli",
      version: "0.0.0",
      dependencies: {
        "@solvchat/core": "workspace:*",
      },
    });
    writeJson(path.join(root, "packages/engine/package.json"), {
      name: "@solvchat/engine",
      version: "0.0.0",
      dependencies: {
        "@solvchat/core": "*",
      },
    });

    const result = setPublishableVersions(root, "v1.4.2");
    expect(result.version).toBe("1.4.2");
    expect(result.updatedFiles).toHaveLength(4);

    const core = JSON.parse(readFileSync(path.join(root, "packages/core/package.json"), "utf8"));
    const widget = JSON.parse(
      readFileSync(path.join(root, "packages/widget/package.json"), "utf8"),
    );
    const cli = JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"), "utf8"));
    const engine = JSON.parse(
      readFileSync(path.join(root, "packages/engine/package.json"), "utf8"),
    );

    expect(core.version).toBe("1.4.2");
    expect(widget.version).toBe("1.4.2");
    expect(widget.devDependencies["@solvchat/core"]).toBe("1.4.2");
    expect(widget.devDependencies.esbuild).toBe("^0.25.0");
    expect(cli.version).toBe("1.4.2");
    expect(cli.dependencies["@solvchat/core"]).toBe("1.4.2");
    expect(engine.version).toBe("1.4.2");
    expect(engine.dependencies["@solvchat/core"]).toBe("1.4.2");
  });
});

describe("pack-check", () => {
  beforeAll(() => {
    if (!existsSync(path.join(REPO_ROOT, "packages/engine/dist/index.js"))) {
      execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
    }
  }, 60_000);

  it("passes on all real publishable packages", () => {
    const { ok, results, failures } = checkAllPackages(REPO_ROOT);
    expect(failures).toEqual([]);
    expect(ok).toBe(true);
    expect(results.map((r) => r.name)).toEqual([
      "@solvchat/core",
      "@solvchat/widget",
      "@solvchat/cli",
      "@solvchat/engine",
    ]);
  });

  it("passes on a valid fixture package", () => {
    const dir = makeTempDir("solv-pack-ok-");
    createValidPackageFixture(dir);
    const res = checkPackagePack(dir);
    expect(res.errors).toEqual([]);
  });

  it("fails when a required file is missing", () => {
    const dir = makeTempDir("solv-pack-missing-");
    createValidPackageFixture(dir);
    rmSync(path.join(dir, "LICENSE"));
    rmSync(path.join(dir, "dist/index.d.ts"));

    const res = checkPackagePack(dir);
    expect(res.errors).toContain("missing required file: LICENSE");
    expect(res.errors).toContain("missing required file: dist/index.d.ts");
  });

  it("fails when forbidden files or out-of-package source maps are present", () => {
    const dir = makeTempDir("solv-pack-forbidden-");
    createValidPackageFixture(dir);

    writeJson(path.join(dir, "package.json"), {
      name: "@solvchat/fixture",
      version: "1.0.0",
      license: "Apache-2.0",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      files: ["dist", ".env.local", "wrangler.deploy.jsonc"],
    });
    writeFileSync(path.join(dir, ".env.local"), "SECRET=1\n", "utf8");
    writeFileSync(path.join(dir, "wrangler.deploy.jsonc"), "{}\n", "utf8");
    writeFileSync(path.join(dir, "dist/index.test.js"), "test();\n", "utf8");
    writeJson(path.join(dir, "dist/bad.js.map"), {
      version: 3,
      file: "bad.js",
      sources: ["../../outside/src/bad.ts"],
    });

    const res = checkPackagePack(dir);
    expect(res.errors).toContain("forbidden environment file: .env.local");
    expect(res.errors).toContain("forbidden deploy config: wrangler.deploy.jsonc");
    expect(res.errors).toContain("forbidden test file: dist/index.test.js");
    expect(res.errors).toContain(
      "source map dist/bad.js.map points outside package: ../../outside/src/bad.ts",
    );
  });
});
