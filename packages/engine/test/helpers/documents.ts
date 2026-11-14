/** A document under 1 MiB whose deep, repeated heading paths defeat packing. */
export function deepLeafDocument(): string {
  const deep = [1, 2, 3, 4, 5].map((level) => `${"#".repeat(level)} ${"h".repeat(190)}${level}`);
  let markdown = `${deep.join("\n\n")}\n\n`;
  let i = 0;
  while (markdown.length < 1024 * 1024 - 100) {
    markdown += `###### Leaf ${i}\n\nw${i}\n\n`;
    i++;
  }
  return markdown;
}
