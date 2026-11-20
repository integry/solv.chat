import { MIN_CHUNK_CHARS } from "../../src/ingest/chunk.js";

/**
 * A document under 1 MiB whose deep, repeated heading paths defeat packing.
 * Each leaf holds `MIN_CHUNK_CHARS` of text, so no leaf is merged into
 * another as too small.
 */
export function deepLeafDocument(): string {
  const deep = [1, 2, 3, 4, 5].map((level) => `${"#".repeat(level)} ${"h".repeat(190)}${level}`);
  let markdown = `${deep.join("\n\n")}\n\n`;
  let i = 0;
  const body = "w".repeat(MIN_CHUNK_CHARS);
  for (;;) {
    const leaf = `###### Leaf ${i}\n\n${body}${i}\n\n`;
    if (markdown.length + leaf.length > 1024 * 1024 - 100) break;
    markdown += leaf;
    i++;
  }
  return markdown;
}
