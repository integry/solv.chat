// HTML-to-Markdown extraction for fetched pages. Used by the default page
// fetcher (`plainPageFetcher` in `pageFetcher.ts`), and so by the one-time
// sitemap import.

export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Calls `onTag` for each `<...>` tag and `onText` for the text between them.
 * One left-to-right pass with `indexOf`: the page is up to 1 MiB of
 * owner-chosen HTML, and a regex such as `<[^>]+>` rescans to the end of the
 * input from every `<` that has no `>` after it, which is quadratic. Once no
 * `>` remains, the rest is text, as the regex would have left it.
 */
function scanTags(
  html: string,
  onText: (text: string) => void,
  onTag: (tag: string) => void,
): void {
  let pos = 0;
  while (pos < html.length) {
    const open = html.indexOf("<", pos);
    if (open === -1) break;
    const close = html.indexOf(">", open + 1);
    if (close === -1) break;
    if (close === open + 1) {
      // `<>` is not a tag; the old regex needed one character in between.
      onText(html.slice(pos, close + 1));
      pos = close + 1;
      continue;
    }
    onText(html.slice(pos, open));
    onTag(html.slice(open + 1, close));
    pos = close + 1;
  }
  onText(html.slice(pos));
}

function stripTags(html: string): string {
  const parts: string[] = [];
  scanTags(
    html,
    (text) => parts.push(text),
    () => parts.push(" "),
  );
  return parts.join("").replace(/\s+/g, " ").trim();
}

function isTagBoundary(char: string | undefined): boolean {
  return char === undefined || char === ">" || /\s/.test(char);
}

/**
 * Replaces every `<name ...>inner</name>` with `render(inner)`, matching the
 * first close after each open, as a lazy regex would. Linear: when an open
 * has no close after it, no later open has one either, so the scan stops.
 */
function replaceElements(
  html: string,
  name: string,
  render: (inner: string) => string,
  limit = Number.POSITIVE_INFINITY,
): string {
  const lower = html.toLowerCase();
  const openMarker = `<${name}`;
  const closeMarker = `</${name}>`;
  const out: string[] = [];
  let pos = 0;
  let search = 0;
  let replaced = 0;
  while (replaced < limit) {
    const open = lower.indexOf(openMarker, search);
    if (open === -1) break;
    if (!isTagBoundary(lower[open + openMarker.length])) {
      search = open + openMarker.length;
      continue;
    }
    const openEnd = lower.indexOf(">", open + openMarker.length);
    if (openEnd === -1) break;
    const close = lower.indexOf(closeMarker, openEnd + 1);
    if (close === -1) break;
    out.push(html.slice(pos, open), render(html.slice(openEnd + 1, close)));
    pos = close + closeMarker.length;
    search = pos;
    replaced++;
  }
  out.push(html.slice(pos));
  return out.join("");
}

function firstElementInner(html: string, name: string): string | null {
  let inner: string | null = null;
  replaceElements(
    html,
    name,
    (found) => {
      inner = found;
      return "";
    },
    1,
  );
  return inner;
}

const BLOCK_OPEN = new Set(["p", "div", "section", "article", "br", "tr", "blockquote"]);
const BLOCK_CLOSE = new Set(["p", "div", "section", "article", "blockquote"]);

function tagName(tag: string): string {
  const match = /^\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
  return match?.[1]?.toLowerCase() ?? "";
}

function trimTrailingBlanks(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return line.slice(0, end);
}

/**
 * Converts a fetched page to a title and plain Markdown without backtracking
 * regexes. `markdown` is the empty string when the page has no text.
 */
export function extractHtml(
  html: string,
  fallbackUrl: string,
): { title: string; markdown: string } {
  const titleInner = firstElementInner(html, "title");
  const rawTitle = titleInner ? decodeXmlEntities(stripTags(titleInner)) : "";
  const title = (rawTitle || new URL(fallbackUrl).pathname || fallbackUrl).slice(0, 300);

  let text = html;
  // `title` is the document's title already; left in, its text would also
  // open the body.
  for (const name of ["script", "style", "noscript", "title"]) {
    text = replaceElements(text, name, () => "\n");
  }
  for (let level = 1; level <= 6; level++) {
    text = replaceElements(
      text,
      `h${level}`,
      (inner) => `\n\n${"#".repeat(level)} ${stripTags(inner)}\n\n`,
    );
  }
  text = replaceElements(text, "li", (inner) => `\n- ${stripTags(inner)}`);

  const parts: string[] = [];
  scanTags(
    text,
    (chunk) => parts.push(chunk),
    (tag) => {
      const name = tagName(tag);
      if (tag.startsWith("/")) {
        if (BLOCK_CLOSE.has(name)) parts.push("\n\n");
      } else if (BLOCK_OPEN.has(name) && isTagBoundary(tag[name.length] ?? ">")) {
        parts.push("\n");
      }
    },
  );

  text = decodeXmlEntities(parts.join(""))
    .split("\n")
    .map(trimTrailingBlanks)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, markdown: text };
}

/** As `extractHtml`, with a page that has no text written as its title alone. */
export function htmlToTitleAndMarkdown(
  html: string,
  fallbackUrl: string,
): {
  title: string;
  markdown: string;
} {
  const { title, markdown } = extractHtml(html, fallbackUrl);
  return { title, markdown: markdown || `# ${title}` };
}
