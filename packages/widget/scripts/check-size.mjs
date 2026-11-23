import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const MAX_GZIP_BYTES = 30 * 1024; // 30 720 bytes

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(root, "dist/widget.js");
const raw = readFileSync(bundlePath);
const gzipped = gzipSync(raw, { level: 9 });

console.log(
  `@solvchat/widget: ${raw.byteLength} B raw, ${gzipped.byteLength} B gzipped (limit ${MAX_GZIP_BYTES} B)`,
);

if (gzipped.byteLength > MAX_GZIP_BYTES) {
  console.error(
    `Error: widget bundle exceeds 30 kB gzipped limit (${gzipped.byteLength} > ${MAX_GZIP_BYTES} bytes)`,
  );
  process.exit(1);
}

const boot = readFileSync(path.join(root, "dist/boot.js"));
if (boot.byteLength >= 1024) {
  throw new Error(`Widget boot script is ${boot.byteLength} bytes. It must be under 1024 bytes.`);
}
const docs = readFileSync(path.resolve(root, "../../docs/self-hosting.md"), "utf8");
const hash = createHash("sha256").update(boot).digest("base64");
if (
  !docs.includes(`<script data-key="pk_...">${boot.toString("utf8")}</script>`) ||
  !docs.includes(`'sha256-${hash}'`)
) {
  throw new Error("Update the inline boot script and CSP hash in docs/self-hosting.md.");
}
