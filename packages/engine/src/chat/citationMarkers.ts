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
 *   indented block, also within a list item or a quote), so `items[1]` in a
 *   code sample stays. In prose a marker goes wherever it is, also straight
 *   after a word ("Forgot Password[1].");
 * - never a Markdown link (`[1](https://…)`), and never in a link's
 *   destination, so a link still goes where it did: an inline link's or
 *   image's (`[Download](https://…/report[1].pdf)`), an autolink's
 *   (`<https://…/report[1].pdf>`) or a reference definition's
 *   (`[report]: https://…/report[1].pdf`);
 * - never a reference link's label: not the label of a definition
 *   (`[1]: https://…`), nor one straight after a link's text (`[guide][1]`,
 *   `![chart][2]`, or the empty `[guide][]`), so the link still reaches its
 *   definition. The text must be more than numbers: `[42][1]` and `[1][2]` are
 *   citations (a label alone, `[1]` with a definition, cannot be told from
 *   one and goes).
 * - never a bracket escaped as literal text (`\[1]`, as Markdown shows "[1]"),
 *   while an escaped backslash leaves the bracket real (`\\[1]` is a citation).
 * The spaces before a marker go with it: "open at 9 [1]." becomes "open at 9.".
 * Each bracket is judged on its own, so in "option [42] [1]." the "[42]"
 * stays and the "[1]" still goes.
 *
 * A line ends at "\n", "\r\n" or a bare "\r" alike, as the widget reads the
 * answer, so a closing fence or a blank line is found whatever line endings
 * the model used; the text itself keeps its own endings.
 */

import { escapedAt, proseRanges } from "@solvchat/core";

const NUMBER = String.raw`\d{1,2}`;
const ONE_MARKER = String.raw`\[[ \t]*${NUMBER}(?:[ \t]*[,–-][ \t]*${NUMBER})*[ \t]*\]`;
const MARKER = new RegExp(String.raw`[ \t]*${ONE_MARKER}(?!\(|\[\])`, "gu");
/** What a run of citation markers is made of; a bracket of only this is no link text. */
const NUMERIC_BRACKET = /^\[[ \t\d,–-]*\]$/u;
/**
 * The end of a stream that could still turn into a marker (or be the spaces
 * before one, or a marker that a following "(" or "[]" would make a link), so it is
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

/**
 * Whether the bracket closing right before `at` is a link's text, which makes
 * a marker at `at` the label of a reference link (`[guide][1]`). The text is
 * found by walking back to its "[" over nested brackets, within the paragraph;
 * a bracket of numbers alone (`[42][1]`, `[1][2]`) is a run of citations.
 */
function linkTextBefore(text: string, at: number): boolean {
  if (text[at - 1] !== "]") return false;
  let depth = 0;
  for (let p = at - 1; p >= 0; p--) {
    const char = text[p];
    if (char === "\n" && blankLineAt(text, p)) return false;
    if (p > 0 && text[p - 1] === "\\") continue;
    if (char === "]") depth++;
    else if (char === "[" && --depth === 0) return !NUMERIC_BRACKET.test(text.slice(p, at));
  }
  return false;
}

/** `source` with the markers `text` shows from `from` up to `end` taken out. */
function stripAll(
  text: string,
  from: number,
  end: number,
  maxSource: number,
  source = text,
): string {
  let out = "";
  let at = from;
  MARKER.lastIndex = from;
  for (let match = MARKER.exec(text); match !== null; match = MARKER.exec(text)) {
    const markerEnd = match.index + match[0].length;
    if (markerEnd > end) break;
    const marker = match[0].trimStart();
    const markerStart = markerEnd - marker.length;
    if (
      withinRange(marker, maxSource) &&
      !escapedAt(text, markerStart) &&
      !linkTextBefore(text, markerStart)
    ) {
      out += source.slice(at, match.index);
      at = markerEnd;
    }
  }
  return out + source.slice(at, end);
}

/** Whether the line break at `at` is followed by a blank line, which ends a paragraph. */
function blankLineAt(text: string, at: number): boolean {
  let p = at + 1;
  while (text[p] === " " || text[p] === "\t") p++;
  return text[p] === "\n";
}

/**
 * `text` with its citation markers removed. `before` is the text already
 * written ahead of it (a paused reply's first part), which decides whether
 * `text` starts inside a code block or span.
 */
export function stripCitationMarkers(text: string, maxSource: number, before = ""): string {
  const whole = before + text;
  // Read with every line ending as "\n" ("\r\n" as " \n", a trailing space
  // changing nothing), keeping each index, so the cuts apply to `whole` as is.
  // A "\r" a chunk ends on reads as "\n" until its "\n" arrives, to the same effect.
  const lines = whole.replace(/\r\n?/gu, (eol) => (eol.length === 2 ? " \n" : "\n"));
  let out = "";
  let at = before.length;
  for (const [start, end] of proseRanges(lines)) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    out += whole.slice(at, from) + stripAll(lines, from, end, maxSource, whole);
    at = end;
  }
  const clean = out + whole.slice(at);
  // An answer that opens with a marker does not open with the space after it.
  return before === "" && !/^[ \t]/u.test(whole) ? clean.replace(/^[ \t]+/u, "") : clean;
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
