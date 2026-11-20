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
  onTag: (tag: string, end: number) => void,
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
    onTag(html.slice(open + 1, close), close + 1);
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
const BLOCK_CLOSE = new Set(["p", "div", "section", "article", "blockquote", "ul", "ol"]);
// A list is a block of its own, so a list of links can be told apart from
// the paragraph before it (see `dropLinkBlocks`).
const LIST_OPEN = new Set(["ul", "ol"]);

function tagName(tag: string): string {
  const match = /^\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
  return match?.[1]?.toLowerCase() ?? "";
}

function trimTrailingBlanks(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return line.slice(0, end);
}

// --- Implied end tags ----------------------------------------------------
//
// HTML lets a page leave out the end tag of a list item, a paragraph, a
// table cell and a few others; the element ends where the next one starts
// or where its parent ends. The steps below match an element to its own end
// tag, so on a page that leaves them out one `<li>` would run on to the next
// `</li>` anywhere later in the page (issue #128). `closeImpliedEndTags`
// writes those end tags in first.
//
// The rules are the HTML Standard's, section 13.1.2.4 "Optional tags":
// Source: https://html.spec.whatwg.org/multipage/syntax.html#optional-tags — checked 2026-11-20
//   - li: ends at the next li, or when its parent has no more content.
//   - dt: ends at the next dt or dd. dd: at the next dd or dt, or its parent's end.
//   - p: ends at the next address, article, aside, blockquote, details,
//     dialog, div, dl, fieldset, figcaption, figure, footer, form, h1-h6,
//     header, hgroup, hr, main, menu, nav, ol, p, pre, search, section,
//     table or ul, or its parent's end.
//   - rt, rp: end at the next rt or rp, or their parent's end.
//   - optgroup: ends at the next optgroup or hr, or its parent's end.
//   - option: ends at the next option, optgroup or hr, or its parent's end.
//   - thead: ends at the next tbody or tfoot. tbody: at the next tbody or
//     tfoot, or its parent's end. tfoot: at its parent's end.
//   - tr: ends at the next tr, or its parent's end.
//   - td, th: end at the next td or th, or their parent's end.
// "Its parent's end" is the parent's end tag (`</ul>` ends the open `li`),
// and the end of the page for what is still open there.

/** Elements whose end tag may be left out, and the start tags that end each one. */
const ENDED_BY = new Map<string, Set<string>>([
  ["li", new Set(["li"])],
  ["dt", new Set(["dt", "dd"])],
  ["dd", new Set(["dt", "dd"])],
  [
    "p",
    new Set([
      "address",
      "article",
      "aside",
      "blockquote",
      "details",
      "dialog",
      "div",
      "dl",
      "fieldset",
      "figcaption",
      "figure",
      "footer",
      "form",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "header",
      "hgroup",
      "hr",
      "main",
      "menu",
      "nav",
      "ol",
      "p",
      "pre",
      "search",
      "section",
      "table",
      "ul",
    ]),
  ],
  ["rt", new Set(["rt", "rp"])],
  ["rp", new Set(["rt", "rp"])],
  ["optgroup", new Set(["optgroup", "hr"])],
  ["option", new Set(["option", "optgroup", "hr"])],
  ["thead", new Set(["tbody", "tfoot"])],
  ["tbody", new Set(["tbody", "tfoot"])],
  ["tfoot", new Set<string>()],
  ["tr", new Set(["tr"])],
  ["td", new Set(["td", "th"])],
  ["th", new Set(["td", "th"])],
]);
/**
 * Of those, the ones that also end when their parent has no more content.
 * A start tag that ends an element ends these first when they are open
 * inside it: in `<li><p>One<li>Two` the paragraph is the last thing in the
 * first item, and that item is followed by another.
 */
const ENDED_BY_PARENT = new Set([
  "li",
  "dd",
  "p",
  "rt",
  "rp",
  "optgroup",
  "option",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
]);
/** Open elements beyond this are not tracked; no real page comes near it. */
const MAX_OPEN_ELEMENTS = 1024;

/**
 * Writes in the end tags a page left out where HTML implies them (see
 * above). A page that closes its elements comes back unchanged: only end
 * tags are added, and only for an element that is still open where a later
 * tag ends it. One pass, with the open elements on a bounded stack.
 */
export function closeImpliedEndTags(html: string): string {
  const out: string[] = [];
  const open: string[] = [];
  const closeFrom = (at: number) => {
    for (let i = open.length - 1; i >= at; i--) {
      const name = open[i] as string;
      if (ENDED_BY.has(name)) out.push(`</${name}>`);
    }
    open.length = at;
  };
  scanTags(
    html,
    (text) => out.push(text),
    (tag) => {
      const name = tagName(tag);
      if (name === "") {
        out.push(`<${tag}>`);
        return;
      }
      if (tag.startsWith("/")) {
        // A parent's end tag ends what is still open inside it. An end tag
        // with nothing of its name open is left as it is.
        const at = open.lastIndexOf(name);
        if (at !== -1) {
          closeFrom(at + 1);
          open.length = at;
        }
        out.push(`<${tag}>`);
        return;
      }
      // The outermost element this tag ends, reached through elements that
      // end with their parent: `<optgroup>` after `<option>` ends the open
      // option and the optgroup around it.
      let ends = -1;
      for (let i = open.length - 1; i >= 0; i--) {
        const current = open[i] as string;
        if (ENDED_BY.get(current)?.has(name)) ends = i;
        else if (!ENDED_BY_PARENT.has(current)) break;
      }
      if (ends !== -1) closeFrom(ends);
      if (!isSelfClosing(tag, name) && open.length < MAX_OPEN_ELEMENTS) open.push(name);
      out.push(`<${tag}>`);
    },
  );
  closeFrom(0);
  return out.join("");
}

// --- Page chrome ---------------------------------------------------------
//
// Navigation, the site header and footer, sidebars and "related links"
// blocks repeat on every page. Indexed, they are short chunks whose heading
// path is the page's own title, so they match every question about that
// title better than the page's real text does (issue #123). They are left
// out in two steps: landmark regions by markup, then whatever is left that
// is only a list of links, by a rule on its text.

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements that are page chrome wherever they appear. */
const CHROME_ELEMENTS = new Set(["nav", "footer", "menu", "dialog", "template"]);
/**
 * ARIA landmark roles that are page chrome. `main` and the content roles are
 * not; `search` and the menu roles are site furniture like navigation.
 * Source: https://www.w3.org/TR/wai-aria-1.2/#landmark_roles — checked 2026-11-20
 */
const CHROME_ROLES = new Set([
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "menu",
  "menubar",
]);
/**
 * A `header` inside one of these is that content's own header (an article's
 * title and date), not the site's banner, so it is kept: HTML maps `header`
 * to the banner landmark only outside sectioning content and `main`.
 * Source: https://www.w3.org/TR/html-aam-1.0/#el-header — checked 2026-11-20
 * `footer` is dropped everywhere: inside an article it holds tags, share
 * buttons and "related" links, not the article's text.
 */
const SECTIONING = new Set(["article", "section", "main"]);
/**
 * An `aside` inside one of these is part of that article or section (a note,
 * a requirement, a worked example), so it is kept. One in the body or
 * directly in `main` is the page's sidebar and is dropped: HTML maps `aside`
 * to the complementary landmark only when it is scoped to `body` or `main`.
 * Source: https://www.w3.org/TR/html-aam-1.0/#el-aside — checked 2026-11-20
 * (The spec also makes a named `aside` inside an article complementary; it is
 * kept anyway, since a labelled "Note" callout is still the article's text.)
 * An `aside` with a `role` of its own is judged by that role alone.
 */
const ASIDE_SCOPES = new Set(["article", "section"]);
/** Nesting deeper than this is not tracked; no real page comes near it. */
const MAX_TRACKED_DEPTH = 256;

function roleOf(tag: string): string | null {
  const match = /(?:^|\s)role\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/i.exec(tag);
  if (match === null) return null;
  const value = match[1] ?? match[2] ?? match[3] ?? "";
  return value.trim().split(/\s+/)[0]?.toLowerCase() ?? null;
}

function isSelfClosing(tag: string, name: string): boolean {
  return VOID_ELEMENTS.has(name) || tag.endsWith("/");
}

/**
 * Removes landmark chrome: `nav`, `footer` (and menus, dialogs, templates),
 * elements whose `role` is a chrome landmark, an `aside` that is not inside
 * an article or section, and a `header` that is not inside an article,
 * section, `main` or `role="main"`.
 * Content inside any of these goes with it. Nesting-aware and linear:
 * an element is skipped to its own matching close, and one that is never
 * closed is kept rather than swallowing the rest of the page.
 */
function stripChrome(html: string): string {
  const lower = html.toLowerCase();
  const lastClose = new Map<string, number>();
  const closesAfter = (name: string, end: number): boolean => {
    let at = lastClose.get(name);
    if (at === undefined) {
      at = lower.lastIndexOf(`</${name}`);
      lastClose.set(name, at);
    }
    return at >= end;
  };
  const out: string[] = [];
  const stack: string[] = [];
  // Parallel to `stack`: whether that element scopes a `header`, and
  // whether it scopes an `aside`.
  const scopes: boolean[] = [];
  const asideScopes: boolean[] = [];
  let sectioning = 0;
  let asideScoped = 0;
  let skip: { name: string; depth: number } | null = null;
  scanTags(
    html,
    (text) => {
      if (skip === null) out.push(text);
    },
    (tag, end) => {
      const name = tagName(tag);
      const closing = tag.startsWith("/");
      if (skip !== null) {
        if (name === skip.name && !isSelfClosing(tag, name)) {
          skip.depth += closing ? -1 : 1;
          if (skip.depth === 0) skip = null;
        }
        return;
      }
      if (name === "") {
        out.push(`<${tag}>`);
        return;
      }
      if (closing) {
        const at = stack.lastIndexOf(name);
        if (at !== -1) {
          for (let i = at; i < stack.length; i++) {
            if (scopes[i]) sectioning--;
            if (asideScopes[i]) asideScoped--;
          }
          stack.length = at;
          scopes.length = at;
          asideScopes.length = at;
        }
        out.push(`<${tag}>`);
        return;
      }
      if (isSelfClosing(tag, name)) {
        out.push(`<${tag}>`);
        return;
      }
      const role = roleOf(tag);
      const chrome =
        CHROME_ELEMENTS.has(name) ||
        (role !== null && CHROME_ROLES.has(role)) ||
        (name === "aside" && !role && asideScoped === 0) ||
        (name === "header" && sectioning === 0);
      if (chrome && closesAfter(name, end)) {
        skip = { name, depth: 1 };
        out.push("\n");
        return;
      }
      if (stack.length < MAX_TRACKED_DEPTH) {
        // `role="main"` scopes a header as `main` does, so the page's own
        // header inside it stays.
        const scope = SECTIONING.has(name) || role === "main";
        const asideScope = ASIDE_SCOPES.has(name);
        stack.push(name);
        scopes.push(scope);
        asideScopes.push(asideScope);
        if (scope) sectioning++;
        if (asideScope) asideScoped++;
      }
      out.push(`<${tag}>`);
    },
  );
  return out.join("");
}

/**
 * The inner HTML of each outermost element `matches` accepts, nesting-aware.
 * An element never closed runs to the end of the input.
 */
function outermostElements(
  html: string,
  matches: (name: string, tag: string) => boolean,
): string[] {
  const found: string[] = [];
  let open: { name: string; depth: number; start: number } | null = null;
  let tagStart = 0;
  scanTags(
    html,
    () => {},
    (tag, end) => {
      tagStart = end - tag.length - 2;
      const name = tagName(tag);
      if (name === "" || isSelfClosing(tag, name)) return;
      const closing = tag.startsWith("/");
      if (open !== null) {
        if (name !== open.name) return;
        open.depth += closing ? -1 : 1;
        if (open.depth === 0) {
          found.push(html.slice(open.start, tagStart));
          open = null;
        }
        return;
      }
      if (!closing && matches(name, tag)) open = { name, depth: 1, start: end };
    },
  );
  if (open !== null) found.push(html.slice((open as { start: number }).start));
  return found;
}

/**
 * Where the page's own content is: its `main` (or `role="main"`) when it has
 * one, else its only `article`. Null when neither is there (or there are
 * several articles, a listing page), and the whole page is used.
 */
function contentRegion(html: string): string | null {
  const [main] = outermostElements(html, (name, tag) => name === "main" || roleOf(tag) === "main");
  if (main !== undefined) return main;
  const articles = outermostElements(html, (name) => name === "article");
  return articles.length === 1 ? (articles[0] as string) : null;
}

// Private-use characters that mark where a link's text starts and ends while
// the page is converted; any already in the page are removed first.
const LINK_OPEN = "\uE000";
const LINK_CLOSE = "\uE001";
// Bracket a list item during conversion; removed from the page first, too.
const ITEM_START = "\uE002";
const ITEM_END = "\uE003";

/** Replaces `<a href>` and `</a>` with the link markers. */
function markLinks(html: string): string {
  const out: string[] = [];
  scanTags(
    html,
    (text) => out.push(text),
    (tag) => {
      const name = tagName(tag);
      if (name === "a" && tag.startsWith("/")) out.push(LINK_CLOSE);
      else if (name === "a" && /(?:^|\s)href\s*=/i.test(tag)) out.push(LINK_OPEN);
      else out.push(`<${tag}>`);
    },
  );
  return out.join("");
}

/**
 * A block with at least this many links, and at most this share of its
 * letters and digits outside them, is a list of links, not content. Two
 * links, so a paragraph that is one link (an email address under "Email")
 * stays. A tenth, so a list whose items each say something besides the link
 * ("Install the CLI, then see the setup guide") stays, while separators,
 * bullets and the odd "or" between links do not save a menu.
 */
export const LINK_BLOCK_MIN_LINKS = 2;
export const LINK_BLOCK_MAX_OUTSIDE_SHARE = 0.1;

const WORD_CHARS = /[\p{L}\p{N}]/gu;

function countWordChars(text: string): number {
  return text.match(WORD_CHARS)?.length ?? 0;
}

/**
 * Drops the blocks (paragraphs and lists, separated by blank lines) that are
 * only links, and removes the link markers. Headings are never dropped: a
 * heading that is a link is usually its own permalink.
 */
function dropLinkBlocks(text: string): string {
  let depth = 0;
  const kept: string[] = [];
  for (const block of text.split(/\n{2,}/)) {
    let inside = 0;
    let outside = 0;
    let links = depth > 0 ? 1 : 0;
    let segment = "";
    const flush = () => {
      const count = countWordChars(segment);
      if (depth > 0) inside += count;
      else outside += count;
      segment = "";
    };
    for (const char of block) {
      if (char === LINK_OPEN) {
        flush();
        depth++;
        links++;
      } else if (char === LINK_CLOSE) {
        flush();
        depth = Math.max(0, depth - 1);
      } else {
        segment += char;
      }
    }
    flush();
    const clean = block.replaceAll(LINK_OPEN, "").replaceAll(LINK_CLOSE, "");
    const heading = /^\s*#{1,6}\s/.test(clean);
    const linkList =
      !heading &&
      links >= LINK_BLOCK_MIN_LINKS &&
      inside > 0 &&
      outside <= (inside + outside) * LINK_BLOCK_MAX_OUTSIDE_SHARE;
    if (!linkList) kept.push(clean);
  }
  return kept.join("\n\n");
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

  // Script and style first: their text may hold anything, tags included.
  let page = html.replace(/[\uE000-\uE003]/g, "");
  // `title` is the document's title already; left in, its text would also
  // open the body.
  for (const name of ["script", "style", "noscript", "title"]) {
    page = replaceElements(page, name, () => "\n");
  }
  // End tags the page left out are written in before anything matches an
  // element to its end. Chrome goes first, so a `main` or `article` inside it (a related-post
  // preview in an `aside`, a `main` in a `template`) is never taken for the
  // page's content. Then the page's own content when it marks it, else the
  // whole page. A `main` that holds no text (a page that fills it by
  // script) falls back to the whole page.
  page = stripChrome(closeImpliedEndTags(page));
  const region = contentRegion(page);
  let markdown = region === null ? "" : toMarkdown(region);
  if (markdown === "") markdown = toMarkdown(page);
  return { title, markdown };
}

function toMarkdown(html: string): string {
  let text = markLinks(html);
  for (let level = 1; level <= 6; level++) {
    text = replaceElements(
      text,
      `h${level}`,
      (inner) => `\n\n${"#".repeat(level)} ${stripTags(inner)}\n\n`,
    );
  }
  // Items are bracketed so the whitespace a page puts between them (its own
  // indentation) does not split one list into blocks of one item each.
  text = replaceElements(text, "li", (inner) => `${ITEM_START}- ${stripTags(inner)}${ITEM_END}`);

  const parts: string[] = [];
  scanTags(
    text,
    (chunk) => parts.push(chunk),
    (tag) => {
      const name = tagName(tag);
      if (tag.startsWith("/")) {
        if (BLOCK_CLOSE.has(name)) parts.push("\n\n");
      } else if (LIST_OPEN.has(name) && isTagBoundary(tag[name.length] ?? ">")) {
        parts.push("\n\n");
      } else if (BLOCK_OPEN.has(name) && isTagBoundary(tag[name.length] ?? ">")) {
        parts.push("\n");
      }
    },
  );

  const normalize = (value: string) =>
    value
      .split("\n")
      .map(trimTrailingBlanks)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  // Blank lines (with spaces on them) are normalised first, so blocks split
  // where a reader sees them.
  const joined = decodeXmlEntities(parts.join(""))
    .replace(/\uE003\s*\uE002/g, "\n")
    .replaceAll(ITEM_START, "\n")
    .replaceAll(ITEM_END, "");
  return normalize(dropLinkBlocks(normalize(joined)));
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
