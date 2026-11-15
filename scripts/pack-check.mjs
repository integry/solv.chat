import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

  if (typeof manifest.exports === "string") {
    required.push(normalizeRelPath(manifest.exports));
  } else if (manifest.exports && typeof manifest.exports === "object") {
    for (const target of Object.values(manifest.exports)) {
      if (typeof target === "string") {
        required.push(normalizeRelPath(target));
      } else if (target && typeof target === "object") {
        for (const key of ["types", "default", "import"]) {
          if (typeof target[key] === "string") {
            required.push(normalizeRelPath(target[key]));
          }
        }
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

function collectFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFilesRecursive(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function checkAdminBundleSync(enginePkgDir) {
  const adminDistDir = path.resolve(enginePkgDir, "../admin/dist");
  if (!existsSync(adminDistDir)) return [];

  const indexHtmlPath = path.join(adminDistDir, "index.html");
  if (!existsSync(indexHtmlPath)) {
    return ["missing packages/admin/dist/index.html to verify engine adminBundle.js"];
  }

  const bundleUrl = pathToFileURL(path.join(enginePkgDir, "dist/adminBundle.js")).href;
  const raw = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import(process.argv[1]).then((m) => process.stdout.write(JSON.stringify({ ADMIN_HTML: m.ADMIN_HTML, ADMIN_ASSETS: m.ADMIN_ASSETS })))",
      bundleUrl,
    ],
    { encoding: "utf8" },
  );
  const { ADMIN_HTML, ADMIN_ASSETS } = JSON.parse(raw);

  const expectedHtml = readFileSync(indexHtmlPath, "utf8");
  if (ADMIN_HTML !== expectedHtml) {
    return [
      "engine dist/adminBundle.js is out of sync with packages/admin/dist (rebuild @solvchat/engine)",
    ];
  }

  const distFiles = collectFilesRecursive(adminDistDir).filter((f) => f !== indexHtmlPath);
  const expectedKeys = new Set();

  for (const file of distFiles) {
    const rel = path.relative(adminDistDir, file).split(path.sep).join("/");
    const key = `/admin/${rel}`;
    expectedKeys.add(key);
    const asset = ADMIN_ASSETS?.[key];
    if (!asset || typeof asset.body !== "string") {
      return [
        "engine dist/adminBundle.js is out of sync with packages/admin/dist (rebuild @solvchat/engine)",
      ];
    }
    const actualBuf =
      asset.encoding === "base64"
        ? Buffer.from(asset.body, "base64")
        : Buffer.from(asset.body, "utf8");
    const expectedBuf = readFileSync(file);
    if (!actualBuf.equals(expectedBuf)) {
      return [
        "engine dist/adminBundle.js is out of sync with packages/admin/dist (rebuild @solvchat/engine)",
      ];
    }
  }

  const actualKeys = Object.keys(ADMIN_ASSETS ?? {});
  if (actualKeys.length !== expectedKeys.size || actualKeys.some((k) => !expectedKeys.has(k))) {
    return [
      "engine dist/adminBundle.js is out of sync with packages/admin/dist (rebuild @solvchat/engine)",
    ];
  }

  return [];
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

  if (manifest.name === "@solvchat/admin") {
    if (!fileSet.has("dist/index.html")) {
      errors.push("missing required file: dist/index.html");
    }
    if (!files.some((f) => f.startsWith("dist/assets/") && f.endsWith(".js"))) {
      errors.push("missing required prebuilt asset: dist/assets/*.js");
    }
    if (!files.some((f) => f.startsWith("dist/assets/") && f.endsWith(".css"))) {
      errors.push("missing required prebuilt asset: dist/assets/*.css");
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
    if (fileSet.has("dist/adminBundle.js")) {
      errors.push(...checkAdminBundleSync(pkgDir));
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
