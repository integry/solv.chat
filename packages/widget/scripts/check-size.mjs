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
