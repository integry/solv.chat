import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PUBLISHABLE_PACKAGES } from "./set-version.mjs";

function normalizeRelPath(p) {
  return p.replace(/^\.\//, "").split(path.sep).join("/");
}

function isForbiddenPath(filePath) {
  const normalized = normalizeRelPath(filePath);
  const base = path.posix.basename(normalized);

  if (/(^|\/)node_modules(\/|$)/.test(normalized)) {
    return `forbidden node_modules entry: ${normalized}`;
  }
  if (base.startsWith(".env") || base === ".dev.vars") {
    return `forbidden environment file: ${normalized}`;
  }
  if (base === "wrangler.deploy.jsonc") {
    return `forbidden deploy config: ${normalized}`;
  }
  if (/(^|\/)(test|tests|__tests__)(\/|$)/.test(normalized)) {
    return `forbidden test directory file: ${normalized}`;
  }
  if (/\.(test|spec)(\.d)?\.[cm]?[jt]sx?(\.map)?$/.test(base)) {
    return `forbidden test file: ${normalized}`;
  }
  return null;
}

function checkSourceMapBounds(pkgDir, mapRelPath) {
  const fullMapPath = path.join(pkgDir, mapRelPath);
  const raw = readFileSync(fullMapPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.sources)) return [];

  const errors = [];
  const mapDir = path.dirname(fullMapPath);
  const sourceRoot = typeof parsed.sourceRoot === "string" ? parsed.sourceRoot : "";
  const resolvedPkgDir = path.resolve(pkgDir);

  for (const src of parsed.sources) {
    if (typeof src !== "string" || src.startsWith("data:")) continue;
    const resolved = path.resolve(mapDir, sourceRoot, src);
    const rel = path.relative(resolvedPkgDir, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      errors.push(`source map ${mapRelPath} points outside package: ${src}`);
    }
  }
  return errors;
}

function collectRequiredEntries(manifest) {
  const required = ["package.json", "LICENSE"];

  if (typeof manifest.main === "string") {
    required.push(normalizeRelPath(manifest.main));
  }
  if (typeof manifest.types === "string") {
    required.push(normalizeRelPath(manifest.types));
  }

  const rootExport = manifest.exports?.["."];
  if (typeof rootExport === "string") {
    required.push(normalizeRelPath(rootExport));
  } else if (rootExport && typeof rootExport === "object") {
    for (const key of ["types", "default", "import"]) {
      if (typeof rootExport[key] === "string") {
        required.push(normalizeRelPath(rootExport[key]));
      }
    }
  }

  if (typeof manifest.bin === "string") {
    required.push(normalizeRelPath(manifest.bin));
  } else if (manifest.bin && typeof manifest.bin === "object") {
    for (const binPath of Object.values(manifest.bin)) {
      if (typeof binPath === "string") {
        required.push(normalizeRelPath(binPath));
      }
    }
  }

  return [...new Set(required)];
}

export function checkPackagePack(pkgDir) {
  const manifest = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: pkgDir,
    encoding: "utf8",
  });
  const packResult = JSON.parse(stdout);
  const entry = Array.isArray(packResult) ? packResult[0] : packResult;
  const files = (entry?.files ?? []).map((f) => normalizeRelPath(f.path));
  const fileSet = new Set(files);
  const errors = [];

  for (const req of collectRequiredEntries(manifest)) {
    if (!fileSet.has(req)) {
      errors.push(`missing required file: ${req}`);
    }
  }

  if (manifest.name === "@solvchat/engine") {
    const hasMigration = files.some((f) => f.startsWith("migrations/") && f.endsWith(".sql"));
    if (!hasMigration) {
      errors.push("missing required migrations/*.sql files");
    }
    for (const assetBundle of ["dist/widgetBundle.js", "dist/adminBundle.js"]) {
      if (!fileSet.has(assetBundle)) {
        errors.push(`missing required asset bundle: ${assetBundle}`);
      }
    }
  }

  for (const f of files) {
    const forbiddenReason = isForbiddenPath(f);
    if (forbiddenReason) {
      errors.push(forbiddenReason);
    }
    if (f.endsWith(".map")) {
      errors.push(...checkSourceMapBounds(pkgDir, f));
    }
  }

  return {
    name: manifest.name,
    version: manifest.version,
    files,
    errors,
  };
}

export function checkAllPackages(rootDir, packageDirs = PUBLISHABLE_PACKAGES) {
  const results = [];
  for (const relDir of packageDirs) {
    results.push(checkPackagePack(path.join(rootDir, relDir)));
  }
  const failures = results.filter((r) => r.errors.length > 0);
  return { ok: failures.length === 0, results, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok, results, failures } = checkAllPackages(process.cwd());
  for (const res of results) {
    if (res.errors.length === 0) {
      console.log(`pack-check ok: ${res.name}@${res.version} (${res.files.length} files)`);
    } else {
      console.error(`pack-check failed: ${res.name}@${res.version}`);
      for (const err of res.errors) {
        console.error(`  - ${err}`);
      }
    }
  }
  if (!ok) {
    console.error(`${failures.length} package(s) failed pack check.`);
    process.exit(1);
  }
}
