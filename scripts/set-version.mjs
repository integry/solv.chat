import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PUBLISHABLE_PACKAGES = [
  "packages/core",
  "packages/widget",
  "packages/admin",
  "packages/cli",
  "packages/engine",
];

// Standard SemVer 2.0.0 prefixed with "v".
const SEMVER_TAG_RE =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function matchReleaseTag(tag) {
  const match = typeof tag === "string" ? SEMVER_TAG_RE.exec(tag) : null;
  if (!match) {
    throw new Error(`Invalid release tag "${String(tag)}": expected v<semver> (e.g. v1.2.3)`);
  }
  return match;
}

export function parseReleaseTag(tag) {
  matchReleaseTag(tag);
  return tag.slice(1);
}

export function getDistTag(tag) {
  const match = matchReleaseTag(tag);
  return match[4] !== undefined ? "next" : "latest";
}

export function applyVersionToManifest(manifest, version, internalNames) {
  const next = { ...manifest, version };
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (!deps || typeof deps !== "object") continue;
    const updatedDeps = { ...deps };
    for (const depName of Object.keys(updatedDeps)) {
      if (internalNames.has(depName)) {
        updatedDeps[depName] = version;
      }
    }
    next[field] = updatedDeps;
  }
  return next;
}

export function setPublishableVersions(rootDir, tag, packageDirs = PUBLISHABLE_PACKAGES) {
  const version = parseReleaseTag(tag);
  const manifests = packageDirs.map((relDir) => {
    const pkgPath = path.join(rootDir, relDir, "package.json");
    const manifest = JSON.parse(readFileSync(pkgPath, "utf8"));
    return { relDir, pkgPath, manifest };
  });

  const internalNames = new Set(manifests.map((m) => m.manifest.name));
  const updatedFiles = [];

  for (const { pkgPath, manifest } of manifests) {
    const next = applyVersionToManifest(manifest, version, internalNames);
    writeFileSync(pkgPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    updatedFiles.push(pkgPath);
  }

  return { version, updatedFiles };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.argv[2];
  try {
    const { version, updatedFiles } = setPublishableVersions(process.cwd(), tag);
    console.log(`Set version ${version} in ${updatedFiles.length} packages.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
