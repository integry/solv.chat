// Repeated blocks: text that repeats across a large share of one source's
// pages is page chrome, however the page marks it up (issue #127). #123 left
// chrome out by tag and by link density (`extractHtml`); a site built from
// plain `div`s, or chrome that is prose (a cookie notice, a newsletter
// pitch, an address), passes both. This file is the part that needs no
// database: how a page is cut into blocks, what each block's hash is, and
// which blocks a page loses given the source's repeated hashes. Counting
// and keeping pages in step is `repeatedSource.ts`.
import { sha256Hex } from "../util/crypto.js";
import { type FenceState, isFenceClose, parseFenceOpen } from "./chunk.js";

/**
 * A source with fewer indexed pages than this is never cleaned: with a
 * handful of pages, text shared by most of them is as likely the site's
 * subject as its chrome (the issue's "say under 5").
 */
export const REPEATED_MIN_SOURCE_PAGES = 5;
/**
 * A block is repeated only when it is on at least this many pages, so two
 * pages that share a paragraph (a page and its print version, a pair of
 * translations) never trigger it. With the share below, it only matters at
 * 5 pages, where half would be 2.5 pages.
 */
export const REPEATED_MIN_PAGES = 3;
/**
 * ...and on at least this percentage of the source's indexed pages. Chrome
 * comes from the site's template, so it is on (nearly) every page: in the
 * #123 site, the footer and "related" lists were on all of them, and a
 * cookie notice, newsletter pitch or address block is rendered by the same
 * template. Content that is reused on purpose (a "requires the Pro plan"
 * note, a shared prerequisite) is on the pages it is about, a minority; and
 * that note's meaning depends on the page it is on, so dropping it would
 * lose a fact. Half keeps every block that is on fewer than half the pages,
 * at the cost of missing chrome that only one section of a site carries (a
 * blog's sidebar text in a sitemap that is mostly documentation). Ours;
 * there is no dataset behind it beyond the #123 site.
 */
export const REPEATED_MIN_PERCENT = 50;
/**
 * A repeated block longer than this share of its page's text is kept: it
 * is most of what the page says (a contact page that is the footer's
 * address), so the page is about it.
 */
export const REPEATED_MAX_PAGE_SHARE = 0.5;

/** How many of a source's pages a block must be on, or null when the source is too small. */
export function repeatedThreshold(pages: number): number | null {
  if (pages < REPEATED_MIN_SOURCE_PAGES) return null;
  return Math.max(REPEATED_MIN_PAGES, Math.ceil((pages * REPEATED_MIN_PERCENT) / 100));
}

/** A paragraph, list or code block, or a heading line, as the stored Markdown has it. */
export interface PageBlock {
  text: string;
  heading: boolean;
}

/**
 * A unit that is hashed: one non-heading block (`b`), or a heading with the
 * blocks up to the next heading (`h`). A heading is never hashed alone, so
 * "Overview" over a different body on each page is not repeated; only the
 * heading together with the same body is.
 */
export interface PageUnit {
  hash: string;
  kind: "b" | "h";
  /** Indexes into `PageBlocks.blocks`: the block, or the heading and then its body. */
  blocks: number[];
}

export interface PageBlocks {
  blocks: PageBlock[];
  units: PageUnit[];
  /** The distinct hashes of `units`, sorted: what is stored for the page. */
  hashes: string[];
}

const HEADING = /^#{1,6}\s+/;

/**
 * Splits Markdown into the blocks the HTML conversion writes (paragraphs and
 * lists separated by blank lines) and its heading lines. A fenced code block
 * is one block whatever blank lines it holds, as the chunker reads it.
 */
export function splitBlocks(markdown: string): PageBlock[] {
  const blocks: PageBlock[] = [];
  let current: string[] = [];
  let fence: FenceState | null = null;
  const flush = () => {
    const text = current.join("\n").trim();
    current = [];
    if (text !== "") blocks.push({ text, heading: false });
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (fence !== null) {
      current.push(line);
      if (isFenceClose(line, fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    const opened = parseFenceOpen(line);
    if (opened !== null) {
      flush();
      fence = opened;
      current.push(line);
      continue;
    }
    if (HEADING.test(line)) {
      flush();
      blocks.push({ text: line.trim(), heading: true });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * The text a block is compared on: Unicode NFKC, lower case, whitespace runs
 * as one space. Digits are kept as they are. Folding them would let a
 * footer's "© 2025" match "© 2026", but a site renders its footer the same
 * on every page at one time, so the year is shared already; and it would
 * also make template text that differs only in its numbers ("Price: $10 a
 * month" on one product page, "$20" on the next) one repeated block, losing
 * each page's own figure. A footer whose year changes is counted as two
 * blocks until the source's pages are fetched again.
 */
export function normalizeBlock(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** 64 bits of SHA-256, behind the unit's kind: collisions within one source are not a concern. */
async function unitHash(kind: "b" | "h", normalized: string): Promise<string> {
  return `${kind}${(await sha256Hex(`${kind}\u0000${normalized}`)).slice(0, 16)}`;
}

/** Cuts a page into blocks and hashes its units. */
export async function pageBlocks(markdown: string): Promise<PageBlocks> {
  const blocks = splitBlocks(markdown);
  const units: PageUnit[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as PageBlock;
    if (!block.heading) {
      units.push({ hash: await unitHash("b", normalizeBlock(block.text)), kind: "b", blocks: [i] });
      continue;
    }
    const body: number[] = [];
    for (let j = i + 1; j < blocks.length && !(blocks[j] as PageBlock).heading; j++) body.push(j);
    // A heading straight over another heading has no body of its own.
    if (body.length === 0) continue;
    const normalized = [i, ...body].map((at) => normalizeBlock((blocks[at] as PageBlock).text));
    units.push({
      hash: await unitHash("h", normalized.join("\n")),
      kind: "h",
      blocks: [i, ...body],
    });
  }
  const hashes = [...new Set(units.map((unit) => unit.hash))].sort();
  return { blocks, units, hashes };
}

/**
 * Which of the page's own hashes were repeated: `""` when none, else a hash
 * of them. Stored with the page (`documents.repeated_key`); the page's
 * filtered text depends only on its text and these, so a page whose key
 * still matches the source's repeated blocks needs no rebuild.
 */
export async function repeatedKey(
  page: PageBlocks,
  repeated: ReadonlySet<string>,
): Promise<string> {
  const mine = page.hashes.filter((hash) => repeated.has(hash));
  if (mine.length === 0) return "";
  return (await sha256Hex(mine.join(","))).slice(0, 16);
}

/**
 * The page's Markdown without its repeated blocks, and how many blocks were
 * left out. A block is left out when its hash is repeated, unless it is
 * more than `REPEATED_MAX_PAGE_SHARE` of the page's text; a heading is left
 * out when the heading with its body is repeated and every block of that
 * body is left out. When that would leave no text but headings, nothing is
 * left out: this rule never empties a page. With nothing left out, the
 * Markdown is returned exactly as stored.
 */
export function withoutRepeated(
  markdown: string,
  page: PageBlocks,
  repeated: ReadonlySet<string>,
): { markdown: string; dropped: number } {
  const textChars = page.blocks.reduce((sum, b) => sum + (b.heading ? 0 : b.text.length), 0);
  const drop = new Set<number>();
  for (const unit of page.units) {
    if (unit.kind !== "b" || !repeated.has(unit.hash)) continue;
    const at = unit.blocks[0] as number;
    if ((page.blocks[at] as PageBlock).text.length > textChars * REPEATED_MAX_PAGE_SHARE) continue;
    drop.add(at);
  }
  const textBlocks = page.blocks.filter((b) => !b.heading).length;
  if (drop.size === 0 || drop.size >= textBlocks) return { markdown, dropped: 0 };
  for (const unit of page.units) {
    if (unit.kind !== "h" || !repeated.has(unit.hash)) continue;
    const [heading, ...body] = unit.blocks;
    if (heading !== undefined && body.every((at) => drop.has(at))) drop.add(heading);
  }
  const kept = page.blocks.filter((_, i) => !drop.has(i)).map((b) => b.text);
  return { markdown: kept.join("\n\n"), dropped: drop.size };
}
