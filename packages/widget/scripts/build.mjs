import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");

rmSync(distDir, { recursive: true, force: true });

await build({
  entryPoints: [path.join(root, "src/widget.ts")],
  outfile: path.join(distDir, "widget.js"),
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2022"],
  legalComments: "none",
});

const boot = await build({
  entryPoints: [path.join(root, "src/boot.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2022"],
  legalComments: "none",
  tsconfigRaw: { compilerOptions: { alwaysStrict: false } },
  write: false,
});
writeFileSync(path.join(distDir, "boot.js"), boot.outputFiles[0].text.trimEnd());

execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});
