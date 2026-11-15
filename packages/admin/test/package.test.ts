import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const adminDir = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(adminDir, "../..");
const coreDir = path.join(workspaceRoot, "packages/core");
const tscBin = path.join(workspaceRoot, "node_modules/.bin/tsc");

function packTarball(packageDir: string, destination: string): string {
  const stdout = execFileSync("npm", ["pack", "--pack-destination", destination, "--json"], {
    cwd: packageDir,
    encoding: "utf8",
  });
  const parsed = JSON.parse(stdout) as Array<{ filename: string }>;
  const filename = parsed[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack in ${packageDir} did not return a filename`);
  }
  return path.join(destination, filename);
}

function linkWorkspacePackage(consumerNodeModules: string, pkgName: string): void {
  const target = path.join(workspaceRoot, "node_modules", pkgName);
  const linkPath = path.join(consumerNodeModules, pkgName);
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, "dir");
}

describe("@solvchat/admin packed package", () => {
  let tmpDir = "";
  let consumerDir = "";

  beforeAll(() => {
    execFileSync("npm", ["run", "build"], {
      cwd: adminDir,
      stdio: "pipe",
      env: { ...process.env, NODE_ENV: "production" },
    });

    tmpDir = mkdtempSync(path.join(os.tmpdir(), "solvchat-admin-pack-"));
    const coreTgz = packTarball(coreDir, tmpDir);
    const adminTgz = packTarball(adminDir, tmpDir);

    consumerDir = path.join(tmpDir, "consumer");
    mkdirSync(consumerDir, { recursive: true });
    writeFileSync(
      path.join(consumerDir, "package.json"),
      JSON.stringify({ name: "admin-consumer-smoke", private: true, type: "module" }),
    );

    execFileSync(
      "npm",
      ["install", "--offline", "--no-audit", "--no-fund", "--legacy-peer-deps", coreTgz, adminTgz],
      { cwd: consumerDir, stdio: "pipe" },
    );

    const consumerNodeModules = path.join(consumerDir, "node_modules");
    linkWorkspacePackage(consumerNodeModules, "react");
    linkWorkspacePackage(consumerNodeModules, "react-dom");
    linkWorkspacePackage(consumerNodeModules, "@types/react");
    linkWorkspacePackage(consumerNodeModules, "@types/react-dom");
  }, 60_000);

  afterAll(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exports the ESM library entry and enforces mountAdmin validation", () => {
    const script = [
      'import assert from "node:assert/strict";',
      'import * as admin from "@solvchat/admin";',
      'assert.equal(typeof admin.mountAdmin, "function");',
      'assert.equal(typeof admin.App, "function");',
      'assert.equal(typeof admin.ADMIN_API_HELPERS.getJson, "function");',
      'assert.equal(typeof admin.ApiError, "function");',
      'assert.equal(typeof admin.useResource, "function");',
      "assert.throws(",
      "  () => admin.mountAdmin({}, {",
      '    extraNavItems: [{ id: "overview", label: "Clash", path: "/admin/clash" }],',
      "    extraScreens: { overview: () => null },",
      "  }),",
      "  /clashes with a built-in screen id/,",
      ");",
    ].join("\n");

    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: consumerDir,
      stdio: "pipe",
    });
  });

  it("exports the @solvchat/admin/styles.css stylesheet", () => {
    const resolvedUrl = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'console.log(import.meta.resolve("@solvchat/admin/styles.css"))',
      ],
      { cwd: consumerDir, encoding: "utf8" },
    ).trim();

    const resolvedPath = fileURLToPath(resolvedUrl);
    expect(resolvedPath.endsWith(path.join("@solvchat", "admin", "lib", "styles.css"))).toBe(true);
    expect(readFileSync(resolvedPath, "utf8")).toBe(
      readFileSync(path.join(adminDir, "src/styles.css"), "utf8"),
    );
  });

  it("exports TypeScript declarations that type-check a consumer", () => {
    writeFileSync(
      path.join(consumerDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["consumer.tsx"],
      }),
    );

    writeFileSync(
      path.join(consumerDir, "consumer.tsx"),
      [
        "import {",
        "  ADMIN_API_HELPERS,",
        "  type AdminApiHelpers,",
        "  type Assistant,",
        "  type BuiltinScreenId,",
        "  type ExtraNavItem,",
        "  type ExtraScreenProps,",
        "  type MountAdminOptions,",
        "  type ResourceState,",
        "  type SignInProps,",
        "  mountAdmin,",
        '} from "@solvchat/admin";',
        "",
        "const apiCheck: AdminApiHelpers = ADMIN_API_HELPERS;",
        'const hidden: BuiltinScreenId[] = ["providers"];',
        'const nav: ExtraNavItem[] = [{ id: "billing", label: "Billing", path: "/admin/billing", section: "Account" }];',
        "function BillingScreen({ assistant, assistantId, api }: ExtraScreenProps) {",
        '  const state: ResourceState<Assistant | null> = { status: "ready", value: assistant, error: null };',
        "  void api;",
        "  void state;",
        "  return <div>{assistantId}</div>;",
        "}",
        "function CustomSignIn({ onSignedIn }: SignInProps) {",
        '  return <button type="button" onClick={onSignedIn}>Sign in</button>;',
        "}",
        "const options: MountAdminOptions = {",
        "  extraNavItems: nav,",
        "  extraScreens: { billing: BillingScreen },",
        "  signIn: CustomSignIn,",
        "  onSignOut: async () => {},",
        "  hideScreens: hidden,",
        "};",
        "export function mount(root: HTMLElement) {",
        "  void apiCheck;",
        "  return mountAdmin(root, options);",
        "}",
      ].join("\n"),
    );

    try {
      execFileSync(tscBin, ["-p", "tsconfig.json"], {
        cwd: consumerDir,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message: string };
      throw new Error(`${err.message}\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
    }
  });

  it("includes the prebuilt static app in dist/", () => {
    const indexHtml = path.join(consumerDir, "node_modules/@solvchat/admin/dist/index.html");
    expect(existsSync(indexHtml)).toBe(true);
  });
});
