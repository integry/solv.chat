/**
 * Citation markers (`[1]`, `[2, 3]`, `[1][2]`) taken out of an answer for an
 * assistant with "Show sources in answers" off. The prompt already asks the
 * model not to write them; this catches any that still appear, on the stream
 * and in the stored text alike, so an API client sees the same as the widget.
 *
 * Narrow on purpose, so a site's own text survives:
 * - only numbers from 1 to `maxSource` (the most sources a prompt can carry),
 *   so "[2024]" or "[42]" stay;
 * - only a marker that follows a space, a tab, punctuation or the start of
 *   the text, so `items[1]` in a code sample stays;
 * - never a Markdown link (`[1](https://…)`).
 * The spaces before a marker go with it: "open at 9 [1]." becomes "open at 9.".
 */

const NUMBER = String.raw`\d{1,2}`;
const ONE_MARKER = String.raw`\[[ \t]*${NUMBER}(?:[ \t]*[,–-][ \t]*${NUMBER})*[ \t]*\]`;
const MARKERS = new RegExp(
  String.raw`(?:[ \t]+|(?<![\p{L}\p{N}_]))${ONE_MARKER}(?:[ \t]*${ONE_MARKER})*(?!\()`,
  "gu",
);
/**
 * The end of a stream that could still turn into a marker (or be the spaces
 * before one, or a marker that a following "(" would make a link), so it is
 * held back until the next chunk says which. Bounded so a stray "[" does not
 * hold the stream for long.
 */
const UNSETTLED_TAIL = /[ \t]*(?:\[[ \t\d,–-]{0,24}\]?[ \t]*)*$/u;

/** A stand-in for a letter just before the text, for the look-behind rule. */
const WORD_CONTEXT = "x";
const WORD_CHAR = /[\p{L}\p{N}_]$/u;

function withinRange(marker: string, maxSource: number): boolean {
  const numbers = marker.match(/\d+/g) ?? [];
  return numbers.every((n) => {
    const value = Number(n);
    return value >= 1 && value <= maxSource;
  });
}

function stripAll(text: string, maxSource: number): string {
  return text.replace(MARKERS, (match) => (withinRange(match, maxSource) ? "" : match));
}

/**
 * `text` with its citation markers removed. `before` is the text already
 * written ahead of it (a paused reply's first part), which decides whether a
 * marker at the very start follows a word.
 */
export function stripCitationMarkers(text: string, maxSource: number, before = ""): string {
  if (!WORD_CHAR.test(before)) return stripAll(text, maxSource);
  return stripAll(WORD_CONTEXT + text, maxSource).slice(WORD_CONTEXT.length);
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
    // A held tail never reaches into what was already sent, so the clean
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
