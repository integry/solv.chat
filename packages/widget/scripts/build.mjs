import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
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

execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});
