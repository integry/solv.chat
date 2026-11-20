/**
 * Citation markers (`[1]`, `[2, 3]`, `[1][2]`) taken out of an answer for an
 * assistant with "Show sources in answers" off. The prompt already asks the
 * model not to write them; this catches any that still appear, on the stream
 * and in the stored text alike, so an API client sees the same as the widget.
 *
 * Narrow on purpose, so a site's own text survives:
 * - only numbers from 1 to `maxSource` (the most sources a prompt can carry),
 *   so "[2024]" or "[42]" stay;
 * - never inside Markdown code (an inline code span, a fenced block or an
 *   indented block), so `items[1]` in a code sample stays. In prose a marker goes wherever it is,
 *   also straight after a word ("Forgot Password[1].");
 * - never a Markdown link (`[1](https://…)`).
 * The spaces before a marker go with it: "open at 9 [1]." becomes "open at 9.".
 * Each bracket is judged on its own, so in "option [42] [1]." the "[42]"
 * stays and the "[1]" still goes.
 */

const NUMBER = String.raw`\d{1,2}`;
const ONE_MARKER = String.raw`\[[ \t]*${NUMBER}(?:[ \t]*[,–-][ \t]*${NUMBER})*[ \t]*\]`;
const MARKER = new RegExp(String.raw`[ \t]*${ONE_MARKER}(?!\()`, "gu");
/**
 * The end of a stream that could still turn into a marker (or be the spaces
 * before one, or a marker that a following "(" would make a link), so it is
 * held back until the next chunk says which. It holds a whole run of
 * brackets, however long: any text it lets through can never become part of
 * a marker later, so what was sent is never taken back. A stray "[" is held only until a letter (or any
 * other character a marker cannot hold) arrives.
 */
const UNSETTLED_TAIL = /[ \t]*(?:\[[ \t\d,–-]*\]?[ \t]*)*$/u;

function withinRange(marker: string, maxSource: number): boolean {
  const numbers = marker.match(/\d+/g) ?? [];
  return numbers.every((n) => {
    const value = Number(n);
    return value >= 1 && value <= maxSource;
  });
}

function stripAll(text: string, maxSource: number): string {
  return text.replace(MARKER, (match) => (withinRange(match, maxSource) ? "" : match));
}

/**
 * The `[start, end)` ranges of `text` that are prose, not Markdown code.
 * A fence is a line starting (after up to three spaces) with three or more
 * backticks or tildes, and runs to a line starting with at least as many of
 * the same and nothing else but spaces; unclosed, to the end. An indented
 * block is a line indented four columns past the current list item's text
 * (a tab reaching the next multiple of four), where a paragraph cannot hold
 * it: first in the text, or after a blank line, a heading, a closing fence or
 * another indented line. Elsewhere a run of backticks opens an inline span
 * that ends at the same number of backticks or at a blank line.
 *
 * Read strictly left to right: whether a character is code depends only on
 * the text before it, so appending text never turns already-sent prose into
 * code or back. (Markdown proper would wait for a closing backtick; a stray
 * one here only protects the rest of its paragraph, which keeps markers in.)
 */
/**
 * Where the paragraph ends if the line break at `at` is followed by a blank
 * line: the blank line's own break, so the spaces between stay with the code
 * and nothing already read as code turns into prose once the break arrives.
 */
function blankLineAt(text: string, at: number): number | null {
  let p = at + 1;
  while (text[p] === " " || text[p] === "\t") p++;
  return text[p] === "\n" ? p : null;
}

/** How far `text` is indented from `at`, with tabs reaching the next multiple of four. */
function indentAt(text: string, at: number): { width: number; end: number } {
  let width = 0;
  let end = at;
  while (text[end] === " " || text[end] === "\t") {
    width = text[end] === "\t" ? width + 4 - (width % 4) : width + 1;
    end++;
  }
  return { width, end };
}

const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/u;
const ATX_HEADING = /^#{1,6}(?:[ \t\n]|$)/u;

/**
 * The column a list item's text starts at, if the line whose text starts at
 * `at` (indented `width`) is a list item; otherwise null.
 */
function listItemColumn(text: string, at: number, width: number): number | null {
  const lineEnd = text.indexOf("\n", at);
  const line = text.slice(at, lineEnd === -1 ? text.length : lineEnd);
  const marker = LIST_MARKER.exec(line);
  if (marker === null) return null;
  const after = indentAt(line, marker[0].length);
  const gap = after.width;
  // Text more than four columns past the marker is itself indented code; the
  // item's text then starts one column after the marker, as with no text.
  const textGap = gap >= 1 && gap <= 4 && after.end < line.length ? gap : 1;
  return width + marker[0].length + textGap;
}

function proseRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let proseStart = 0;
  let i = 0;
  // Whether the next line may start an indented code block (it cannot
  // continue a paragraph), and the column a list item's text starts at, so
  // that text indented to stay in the item is not taken for code.
  let codeMayStart = true;
  let previousBlank = true;
  let listColumn = 0;
  const runAt = (at: number, char: string): number => {
    let end = at;
    while (text[end] === char) end++;
    return end - at;
  };
  const lineStartFence = (at: number): { char: string; length: number; end: number } | null => {
    let p = at;
    while (p - at < 3 && text[p] === " ") p++;
    const char = text[p];
    if (char !== "`" && char !== "~") return null;
    const length = runAt(p, char);
    return length >= 3 ? { char, length, end: p + length } : null;
  };
  // A closing fence carries nothing after it but spaces: a line such as
  // "```not-a-close" is still code. At the very end of the text the rest of
  // the line is not known yet, so the fence counts as closed for now; any
  // later text on that line can only make it code again, and the stream holds
  // nothing back that this would change (prose after it is empty or spaces).
  const onlySpacesToLineEnd = (at: number): boolean => {
    let p = at;
    while (text[p] === " " || text[p] === "\t") p++;
    return p === text.length || text[p] === "\n";
  };
  while (i < text.length) {
    const atLineStart = i === 0 || text[i - 1] === "\n";
    if (atLineStart) {
      const indent = indentAt(text, i);
      const blank = indent.end === text.length || text[indent.end] === "\n";
      if (blank) {
        codeMayStart = true;
        previousBlank = true;
      } else if (codeMayStart && indent.width >= listColumn + 4) {
        // An indented code line, up to its line break.
        ranges.push([proseStart, i]);
        const lineEnd = text.indexOf("\n", i);
        i = lineEnd === -1 ? text.length : lineEnd;
        proseStart = i;
        previousBlank = false;
        continue;
      } else {
        const item = listItemColumn(text, indent.end, indent.width);
        if (item !== null) listColumn = item;
        else if (previousBlank && indent.width < listColumn) listColumn = 0;
        codeMayStart = ATX_HEADING.test(text.slice(indent.end, indent.end + 8));
        previousBlank = false;
      }
    }
    const fence = atLineStart ? lineStartFence(i) : null;
    if (fence !== null) {
      ranges.push([proseStart, i]);
      // Skip to the closing fence line, or to the end.
      let p = text.indexOf("\n", fence.end);
      let close = text.length;
      while (p !== -1) {
        const closer = lineStartFence(p + 1);
        if (
          closer !== null &&
          closer.char === fence.char &&
          closer.length >= fence.length &&
          onlySpacesToLineEnd(closer.end)
        ) {
          close = closer.end;
          break;
        }
        p = text.indexOf("\n", p + 1);
      }
      i = close;
      proseStart = close;
      codeMayStart = true;
      continue;
    }
    if (text[i] === "`") {
      const length = runAt(i, "`");
      ranges.push([proseStart, i]);
      let p = i + length;
      let close = text.length;
      while (p < text.length) {
        if (text[p] === "`") {
          const run = runAt(p, "`");
          if (run === length) {
            close = p + run;
            break;
          }
          p += run;
          continue;
        }
        const blank = text[p] === "\n" ? blankLineAt(text, p) : null;
        if (blank !== null) {
          close = blank;
          codeMayStart = true;
          previousBlank = true;
          break;
        }
        p++;
      }
      i = close;
      proseStart = close;
      continue;
    }
    i++;
  }
  ranges.push([proseStart, text.length]);
  return ranges.filter(([start, end]) => end > start);
}

/**
 * `text` with its citation markers removed. `before` is the text already
 * written ahead of it (a paused reply's first part), which decides whether
 * `text` starts inside a code block or span.
 */
export function stripCitationMarkers(text: string, maxSource: number, before = ""): string {
  const whole = before + text;
  let out = "";
  let at = before.length;
  for (const [start, end] of proseRanges(whole)) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    out += whole.slice(at, from) + stripAll(whole.slice(from, end), maxSource);
    at = end;
  }
  return out + whole.slice(at);
}

export interface MarkerStripper {
  /** Takes the next raw chunk and returns what can be sent now (maybe ""). */
  push(chunk: string): string;
  /** Returns whatever was held back, at the end of the stream or a pause. */
  flush(): string;
  /** Everything sent so far, which is exactly the clean text to store. */
  readonly text: string;
}

/**
 * Strips markers from a stream whose chunks may split one ("[" in one chunk,
 * "1]" in the next). What it sends always adds up to
 * `stripCitationMarkers(all chunks joined)`: the tail that could still become
 * a marker waits for the next chunk.
 */
export function markerStripper(maxSource: number, before = ""): MarkerStripper {
  let raw = "";
  let sent = "";
  const emit = (clean: string): string => {
    // The held tail covers every unfinished marker (UNSETTLED_TAIL holds a
    // whole run of brackets) and code is decided left to right, so the clean
    // text only grows; the guard keeps a surprise from repeating text.
    if (!clean.startsWith(sent)) return "";
    const delta = clean.slice(sent.length);
    sent = clean;
    return delta;
  };
  return {
    push(chunk) {
      if (chunk === "") return "";
      raw += chunk;
      const tail = UNSETTLED_TAIL.exec(raw);
      const cut = tail ? tail.index : raw.length;
      return emit(stripCitationMarkers(raw.slice(0, cut), maxSource, before));
    },
    flush() {
      return emit(stripCitationMarkers(raw, maxSource, before));
    },
    get text() {
      return sent;
    },
  };
}
