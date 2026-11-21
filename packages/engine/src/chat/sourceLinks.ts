/**
 * Links in an answer for "Show sources in answers" set to "Link in the text".
 *
 * The model is not asked to copy addresses. Each source in the prompt has a
 * number, and the model links words to a source by that number, as a
 * Markdown reference link: `[the testing guide][2]`. This module turns each
 * such reference into a link to source 2's page, on the stream and in the
 * stored text alike. Numbers rather than copied addresses: a number cannot
 * be mistyped into another page, so a correct reference always links where
 * it should, and it costs a few output characters where an address costs
 * dozens. In the recorded evaluation (`test/fixtures/source-links-eval.json`)
 * both ways linked every answer correctly; numbers spent 64 characters on 16
 * link targets, addresses 459 on 13.
 *
 * Whatever the model writes, a link survives only when it goes to a page the
 * answer was given (`LinkTargets`): a reference to a source with no page (a
 * written answer) or to no source at all, an inline link or autolink to any
 * other address (another site, a made-up page, `mailto:`), a reference to a
 * definition, and an image of any of these are reduced to their text. A link
 * to a page already linked in the same paragraph is reduced too: at most one
 * link per source per paragraph.
 *
 * Code is left alone (an inline span, a fenced or indented block; found as
 * `citationMarkers.ts` finds it), and so is an escaped bracket (`\[`). A bare
 * marker such as `[1]` is left for `markerStripper`, which runs after this.
 *
 * Streaming: a link is never sent half-written. From a "[" (or "![", or an
 * autolink's "<") that could still become a link, the stream is held until
 * the link is complete or cannot be one, and then sent whole, rewritten or
 * as text. At the end of the stream (or a pause, or a cut at the output
 * limit) a link left unfinished is reduced to its text, so no open link is
 * ever stored or sent.
 */

import { escapedAt, proseRanges } from "./citationMarkers.js";

export interface LinkTargets {
  /** Source n's page address (at index n - 1), or null when it has no page. */
  sources: readonly (string | null)[];
  /** Every page a link may go to, by `pageKey`. */
  allowed: ReadonlySet<string>;
}

/** An http(s) address as `URL` parses it, or null. */
function httpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === "https:" || url.protocol === "http:" ? url : null;
}

/** A page's address without its fragment: a link to a section of a page goes to that page. */
export function pageKey(raw: string): string | null {
  const url = httpUrl(raw);
  if (url === null) return null;
  url.hash = "";
  return url.href;
}

/** Addresses written out in a text (`https://…`), without the punctuation after them. */
const URL_IN_TEXT = /https?:\/\/[^\s<>()[\]"'`]+/gu;

/**
 * The pages an answer may link to: the pages of the sources it was given, by
 * number (a written answer has none: its address is in the admin), and any
 * address one of those sources' own text contains. `extra` adds pages from
 * before a pause.
 */
export function linkTargets(
  chunks: readonly { url: string; text: string; sourceKind?: string | undefined }[],
  extra: readonly string[] = [],
): LinkTargets {
  const allowed = new Set<string>();
  const sources = chunks.map((chunk) => {
    if (chunk.sourceKind === "entry") return null;
    const key = pageKey(chunk.url);
    if (key === null) return null;
    allowed.add(key);
    return httpUrl(chunk.url)?.href ?? null;
  });
  for (const chunk of chunks) {
    for (const match of chunk.text.matchAll(URL_IN_TEXT)) {
      const key = pageKey(match[0].replace(/[.,;:!?]+$/u, ""));
      if (key !== null) allowed.add(key);
    }
  }
  for (const url of extra) {
    const key = pageKey(url);
    if (key !== null) allowed.add(key);
  }
  return { sources, allowed };
}

/** A bracket of only numbers (`[1]`, `[1, 2]`): a citation marker, never link text. */
const MARKER_LABEL = /^[ \t]*\d[ \t\d,–-]*$/u;
/** A reference to a source by number: `[words][2]`, also `[words](2)`. */
const SOURCE_NUMBER = /^[ \t]*(\d{1,2})[ \t]*$/u;
/** A complete autolink, `<scheme:…>`. */
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/uy;
/** What could still become an autolink once more text arrives. */
const AUTOLINK_START = /<(?:[A-Za-z][A-Za-z0-9+.-]{0,31}(?::[^\s<>]*)?)?$/uy;
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/u;

type Construct =
  | { kind: "unsettled" }
  | { kind: "none" }
  | { kind: "marker"; end: number }
  /** A link: its text is `[labelStart, labelEnd)`; `target` is its destination or reference. */
  | {
      kind: "link";
      labelStart: number;
      labelEnd: number;
      end: number;
      target: { inline: string } | { reference: string } | null;
    };

/** Where a backtick span starting at `at` closes on its line, or -1 (or null: not yet known). */
function spanClose(text: string, at: number): number | null {
  let length = 0;
  while (text[at + length] === "`") length++;
  for (let p = at + length; p < text.length; ) {
    if (text[p] === "\n") return -1;
    if (text[p] === "`") {
      let run = 0;
      while (text[p + run] === "`") run++;
      if (run === length) return p + run;
      p += run;
    } else {
      p++;
    }
  }
  return null;
}

/**
 * Reads what a "[" at `open` starts. Not `final`, a construct the end of the
 * text could still change is `unsettled`; `final`, an unfinished link is a
 * link with no target, so it is reduced to its text.
 */
function readConstruct(text: string, open: number, final: boolean): Construct {
  const unfinished = (labelEnd: number): Construct =>
    final
      ? { kind: "link", labelStart: open + 1, labelEnd, end: text.length, target: null }
      : { kind: "unsettled" };
  let p = open + 1;
  for (;;) {
    if (p >= text.length) {
      return MARKER_LABEL.test(text.slice(open + 1)) && final
        ? { kind: "none" }
        : unfinished(text.length);
    }
    const char = text[p];
    if (char === "\n" || char === "[") return { kind: "none" };
    if (char === "]") break;
    if (char === "\\") {
      p += 2;
    } else if (char === "`") {
      const close = spanClose(text, p);
      if (close === null && !final) return { kind: "unsettled" };
      if (close !== null && close > 0) p = close;
      else p++;
    } else {
      p++;
    }
  }
  const labelEnd = p;
  const label = text.slice(open + 1, labelEnd);
  const after = labelEnd + 1;
  const next = text[after];
  if (next === undefined) {
    if (!final) return { kind: "unsettled" };
    return MARKER_LABEL.test(label) ? { kind: "marker", end: after } : { kind: "none" };
  }
  if (next === "(") return readDestination(text, open, labelEnd, final);
  if (MARKER_LABEL.test(label)) return { kind: "marker", end: after };
  if (next === "[") {
    for (let q = after + 1; q < text.length; q++) {
      const char = text[q];
      if (char === "\n" || char === "[") return { kind: "none" };
      if (char === "]") {
        return {
          kind: "link",
          labelStart: open + 1,
          labelEnd,
          end: q + 1,
          target: { reference: text.slice(after + 1, q) },
        };
      }
    }
    return unfinished(labelEnd);
  }
  return { kind: "none" };
}

/** Reads an inline link's destination after `](`, with an optional title. */
function readDestination(text: string, open: number, labelEnd: number, final: boolean): Construct {
  const unfinished: Construct = final
    ? { kind: "link", labelStart: open + 1, labelEnd, end: text.length, target: null }
    : { kind: "unsettled" };
  let p = labelEnd + 2;
  const skipSpaces = () => {
    while (text[p] === " " || text[p] === "\t") p++;
  };
  skipSpaces();
  if (p >= text.length) return unfinished;
  const angle = text[p] === "<";
  if (angle) p++;
  const start = p;
  let depth = 0;
  let destEnd = -1;
  for (; p < text.length; p++) {
    const char = text[p];
    if (char === "\n") return { kind: "none" };
    if (char === "\\") {
      p++;
    } else if (angle) {
      if (char === ">") {
        destEnd = p;
        p++;
        break;
      }
      if (char === "<") return { kind: "none" };
    } else if (char === " " || char === "\t") {
      destEnd = p;
      break;
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      if (depth === 0) {
        destEnd = p;
        break;
      }
      depth--;
    }
  }
  if (destEnd === -1) return unfinished;
  const destination = text.slice(start, destEnd);
  skipSpaces();
  if (p >= text.length) return unfinished;
  const quote = text[p];
  if (quote === '"' || quote === "'" || quote === "(") {
    const closer = quote === "(" ? ")" : quote;
    p++;
    for (; p < text.length && text[p] !== closer; p++) {
      if (text[p] === "\n") return { kind: "none" };
      if (text[p] === "\\") p++;
    }
    if (p >= text.length) return unfinished;
    p++;
    skipSpaces();
    if (p >= text.length) return unfinished;
  }
  if (text[p] !== ")") return { kind: "none" };
  return {
    kind: "link",
    labelStart: open + 1,
    labelEnd,
    end: p + 1,
    target: { inline: destination },
  };
}

/** Whether the line starting at `at` ends the paragraph before it (blank, or a new block). */
function startsNewBlock(text: string, at: number): boolean {
  let p = at;
  let width = 0;
  while (text[p] === " " || text[p] === "\t") {
    width += text[p] === "\t" ? 4 - (width % 4) : 1;
    p++;
  }
  if (p >= text.length || text[p] === "\n") return true;
  if (width > 3) return false;
  const rest = text.slice(p, p + 12);
  return (
    rest.startsWith(">") ||
    rest.startsWith("#") ||
    rest.startsWith("```") ||
    rest.startsWith("~~~") ||
    LIST_MARKER.test(rest)
  );
}

/** A destination the widget and Markdown both read whole: no space, parenthesis or angle bracket. */
function destinationText(href: string): string {
  return href.replace(/[()<> ]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface LinkScan {
  /** The rewritten text from where the new text starts, up to `consumed`. */
  out: string;
  /** Where in the whole text `out` stops: the start of an unsettled link, or the end. */
  consumed: number;
  /** The pages the answer links to (before a pause too), by `pageKey`, in order. */
  linked: string[];
  /** Links reduced to their text because their target is not one of the answer's pages. */
  removed: number;
}

/**
 * Rewrites the links in `whole` from `from` on (what comes before was already
 * written, and is only read for code and the paragraph's links).
 */
function scanLinks(whole: string, targets: LinkTargets, from: number, final: boolean): LinkScan {
  // Read with every line ending as "\n" ("\r\n" as " \n"), keeping indexes, as
  // `stripCitationMarkers` does; the output keeps the endings the model wrote.
  const text = whole.replace(/\r\n?/gu, (eol) => (eol.length === 2 ? " \n" : "\n"));
  const ranges = proseRanges(text, true);
  const linked: string[] = [];
  let removed = 0;
  let paragraph = new Set<string>();
  let out = "";
  let copied = from;
  let range = 0;

  const note = (key: string) => {
    paragraph.add(key);
    if (!linked.includes(key)) linked.push(key);
  };
  /** The page a link goes to, as `[key, href]`, or null when it may not. */
  const resolve = (
    target: { inline: string } | { reference: string } | null,
  ): [string, string] | null => {
    if (target === null) return null;
    const raw = "inline" in target ? target.inline : target.reference;
    const number = SOURCE_NUMBER.exec(raw);
    if (number !== null) {
      const href = targets.sources[Number(number[1]) - 1] ?? null;
      const key = href === null ? null : pageKey(href);
      return href === null || key === null ? null : [key, href];
    }
    if ("reference" in target) return null;
    const url = httpUrl(raw.trim());
    const key = url === null ? null : pageKey(url.href);
    return url === null || key === null || !targets.allowed.has(key) ? null : [key, url.href];
  };
  const stop = (at: number): LinkScan => ({
    out: out + whole.slice(copied, at),
    consumed: at,
    linked,
    removed,
  });

  for (let i = 0; i < text.length; ) {
    while (range < ranges.length && (ranges[range] as [number, number])[1] <= i) range++;
    const current = ranges[range];
    const prose = current !== undefined && current[0] <= i;
    const char = text[i];
    if (char === "\n") {
      if (startsNewBlock(text, i + 1)) paragraph = new Set();
      i++;
      continue;
    }
    if (!prose || escapedAt(text, i)) {
      i++;
      continue;
    }
    if (char === "!" && i + 1 >= text.length && !final && i >= from) return stop(i);
    if (char === "<") {
      AUTOLINK.lastIndex = i;
      const auto = AUTOLINK.exec(text);
      if (auto === null) {
        AUTOLINK_START.lastIndex = i;
        if (!final && i >= from && AUTOLINK_START.test(text)) return stop(i);
        i++;
        continue;
      }
      const end = i + auto[0].length;
      const key = pageKey(auto[1] as string);
      if (i < from) {
        if (key !== null) note(key);
      } else if (key !== null && targets.allowed.has(key) && !paragraph.has(key)) {
        note(key);
      } else {
        if (key === null || !targets.allowed.has(key)) removed++;
        out += whole.slice(copied, i) + (auto[1] as string);
        copied = end;
      }
      i = end;
      continue;
    }
    if (char !== "[") {
      i++;
      continue;
    }
    const image = i > 0 && text[i - 1] === "!" && !escapedAt(text, i - 1);
    const start = image ? i - 1 : i;
    const construct = readConstruct(text, i, final || i < from);
    if (construct.kind === "unsettled") return stop(start);
    if (construct.kind === "none") {
      i++;
      continue;
    }
    if (construct.kind === "marker") {
      i = construct.end;
      continue;
    }
    const resolved = resolve(construct.target);
    if (i < from) {
      // Already written: a link there was kept, so it counts for the paragraph.
      if (resolved !== null) note(resolved[0]);
      else if (construct.target !== null && "inline" in construct.target) {
        const key = pageKey(construct.target.inline.trim());
        if (key !== null) note(key);
      }
      i = construct.end;
      continue;
    }
    const label = whole.slice(construct.labelStart, construct.labelEnd);
    let replacement: string;
    if (resolved !== null && !paragraph.has(resolved[0])) {
      note(resolved[0]);
      replacement = `${image ? "!" : ""}[${label}](${destinationText(resolved[1])})`;
    } else {
      if (resolved === null) removed++;
      replacement = label;
    }
    out += whole.slice(copied, start) + replacement;
    copied = construct.end;
    i = construct.end;
  }
  return stop(text.length);
}

/**
 * `text` with its links rewritten (see the module comment), as at the end of
 * a stream. `before` is the text already written ahead of it (a paused
 * reply's first part).
 */
export function rewriteSourceLinks(
  text: string,
  targets: LinkTargets,
  before = "",
): { text: string; linked: string[]; removed: number } {
  const scan = scanLinks(before + text, targets, before.length, true);
  return { text: scan.out, linked: scan.linked, removed: scan.removed };
}

export interface SourceLinker {
  /** Takes the next raw chunk and returns what can be sent now (maybe ""). */
  push(chunk: string): string;
  /** Returns whatever was held back, at the end of the stream or a pause. */
  flush(): string;
  /** Everything sent so far, which is exactly the text to store. */
  readonly text: string;
  /** The pages the answer links to so far, by `pageKey`. */
  readonly linked: readonly string[];
  /** How many links were reduced to text because of where they went. */
  readonly removed: number;
}

/**
 * Rewrites links on a stream whose chunks may split one anywhere. What it
 * sends always adds up to `rewriteSourceLinks(all chunks joined)`: from the
 * start of a link that is not complete yet nothing is sent.
 */
export function sourceLinker(targets: LinkTargets, before = ""): SourceLinker {
  let raw = "";
  let sent = "";
  let last: LinkScan = { out: "", consumed: before.length, linked: [], removed: 0 };
  const emit = (scan: LinkScan): string => {
    last = scan;
    // Decisions are made left to right on text that has fully arrived, so
    // the output only grows; the guard keeps a surprise from repeating text.
    if (!scan.out.startsWith(sent)) return "";
    const delta = scan.out.slice(sent.length);
    sent = scan.out;
    return delta;
  };
  return {
    push(chunk) {
      if (chunk === "") return "";
      raw += chunk;
      return emit(scanLinks(before + raw, targets, before.length, false));
    },
    flush() {
      return emit(scanLinks(before + raw, targets, before.length, true));
    },
    get text() {
      return sent;
    },
    get linked() {
      return last.linked;
    },
    get removed() {
      return last.removed;
    },
  };
}
