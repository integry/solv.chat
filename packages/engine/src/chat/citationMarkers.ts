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
 * The list item marker at `at` and the columns of space after it that belong
 * to the marker (the item's text starts after them), or null.
 */
function listItemAt(text: string, at: number): { marker: number; gap: number } | null {
  const lineEnd = text.indexOf("\n", at);
  const line = text.slice(at, lineEnd === -1 ? text.length : lineEnd);
  const marker = LIST_MARKER.exec(line);
  if (marker === null) return null;
  const after = indentAt(line, marker[0].length);
  // Text more than four columns past the marker is itself indented code; the
  // item's text then starts one column after the marker, as with no text.
  const gap = after.width >= 1 && after.width <= 4 && after.end < line.length ? after.width : 1;
  return { marker: marker[0].length, gap };
}

/** How many times `char` repeats from `at`. */
function runAt(text: string, at: number, char: string): number {
  let end = at;
  while (text[end] === char) end++;
  return end - at;
}

/** A run of three or more backticks or tildes at `at`, as a fence opens or closes with. */
function fenceAt(text: string, at: number): { char: string; length: number; end: number } | null {
  const char = text[at];
  if (char !== "`" && char !== "~") return null;
  const length = runAt(text, at, char);
  return length >= 3 ? { char, length, end: at + length } : null;
}

/** Past a quote's ">" and the one space that may follow it. */
function afterQuoteMarker(text: string, at: number): number {
  return text[at + 1] === " " || text[at + 1] === "\t" ? at + 2 : at + 1;
}

/**
 * A block a line can sit in: a block quote (each of its lines starts with
 * ">"), or a list item whose text starts `column` columns into the space
 * its parent leaves.
 */
type Container = { quote: true } | { quote: false; column: number };

/**
 * Where a line's own text starts once some of its containers are read: the
 * whitespace from `at`, of which the first `skip` columns are list items'.
 */
interface LinePosition {
  at: number;
  skip: number;
}

/** How many of `containers` the line starting at `start` continues, and where its text starts. */
function continuedContainers(
  text: string,
  start: number,
  containers: readonly Container[],
): LinePosition & { matched: number } {
  let at = start;
  let skip = 0;
  let matched = 0;
  for (const container of containers) {
    const indent = indentAt(text, at);
    const blank = indent.end === text.length || text[indent.end] === "\n";
    if (container.quote) {
      if (blank || indent.width - skip > 3 || text[indent.end] !== ">") break;
      at = afterQuoteMarker(text, indent.end);
      skip = 0;
    } else if (!blank) {
      // A blank line stays in a list item; text must reach the item's column.
      if (indent.width - skip < container.column) break;
      skip += container.column;
    }
    matched++;
  }
  return { at, skip, matched };
}

/**
 * Opens the quotes and list items that start a line at `from` (each at most
 * three columns in), adding them to `containers`. Returns where the line's
 * text then starts, or null if none starts there.
 */
function openContainers(
  text: string,
  from: LinePosition,
  containers: Container[],
): LinePosition | null {
  let { at, skip } = from;
  let opened = false;
  for (;;) {
    const indent = indentAt(text, at);
    const width = indent.width - skip;
    if (width > 3) break;
    if (text[indent.end] === ">") {
      containers.push({ quote: true });
      at = afterQuoteMarker(text, indent.end);
      skip = 0;
    } else {
      const item = listItemAt(text, indent.end);
      if (item === null) break;
      containers.push({ quote: false, column: width + item.marker + item.gap });
      at = indent.end + item.marker;
      skip = item.gap;
    }
    opened = true;
  }
  return opened ? { at, skip } : null;
}

/** Whether a line whose text starts at `at`, indented `width`, starts a block that ends a paragraph. */
function startsBlock(text: string, at: number, width: number): boolean {
  if (width > 3) return false;
  return (
    text[at] === ">" ||
    fenceAt(text, at) !== null ||
    listItemAt(text, at) !== null ||
    ATX_HEADING.test(text.slice(at, at + 8))
  );
}

/**
 * The `[start, end)` ranges of `text` that are prose, not Markdown code.
 *
 * Lines are read inside their containers, as Markdown does: block quotes
 * (">") and list items (text indented to the item's column), nested either
 * way. A line's indent is counted from where its innermost container's text
 * starts, so code in a quote or a list item is found like code anywhere else.
 * A paragraph line may leave out its containers' markers and stay in them.
 *
 * A fence is a line starting (up to three columns in) with three or more
 * backticks or tildes, and runs to a line in the same containers starting
 * with at least as many of the same and nothing else but spaces; unclosed, to
 * the end, or to the first line that leaves a container holding it. In a
 * fence on a line of its own (nothing before it but up to three spaces, the
 * way the widget finds fences), a line indented less than the list item
 * holding the fence still stays code, as the widget shows it, and so does
 * everything after it until a fence starts (code again, in Markdown too).
 * An indented block is a line indented four columns, where a paragraph cannot
 * hold it: first in its container, or after a blank line, a heading, a
 * closing fence or another indented line. Elsewhere a run of backticks opens
 * an inline span that ends at the same number of backticks or at a blank line.
 *
 * Read strictly left to right: whether a character is code depends only on
 * the text before it, so appending text never turns already-sent prose into
 * code or back. (Markdown proper would wait for a closing backtick; a stray
 * one here only protects the rest of its paragraph, which keeps markers in.)
 */
function proseRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // Inside an open fence (or held code) this is the end of the text, so it is
  // code to the end until a line ends it.
  let proseStart = 0;
  let i = 0;
  // The containers the current line is in, the open fence, whether lines are
  // held as code after a fence's list item ended, and whether the next line
  // may start an indented code block (no paragraph is open).
  const containers: Container[] = [];
  // `plain` marks a fence opened on a line with nothing before it but up to
  // three spaces, whatever containers that line is in: read that way alone,
  // as the widget reads its fences, it holds its code wherever it is.
  let fence: { char: string; length: number; plain: boolean } | null = null;
  let held = false;
  let codeMayStart = true;
  const lineEnd = (at: number): number => {
    const end = text.indexOf("\n", at);
    return end === -1 ? text.length : end;
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
  /**
   * Reads the line starting at `start`, as code or not, and returns where to
   * go on from: past the code, or `start` itself to read its text for spans.
   */
  const readLine = (start: number): number => {
    const line = continuedContainers(text, start, containers);
    if (fence !== null) {
      if (line.matched === containers.length) {
        const indent = indentAt(text, line.at);
        const closer = indent.width - line.skip <= 3 ? fenceAt(text, indent.end) : null;
        if (
          closer !== null &&
          closer.char === fence.char &&
          closer.length >= fence.length &&
          onlySpacesToLineEnd(closer.end)
        ) {
          fence = null;
          proseStart = closer.end;
          codeMayStart = true;
          return closer.end;
        }
        return lineEnd(start);
      }
      // The line leaves a container holding the fence, which ends it, and is
      // read afresh. Indented less than a list item in a plain fence, it is
      // held as code with all that follows until a fence starts.
      const left = containers.slice(line.matched);
      if (fence.plain && !left.some((container) => container.quote)) held = true;
      else proseStart = start;
      fence = null;
      codeMayStart = true;
    }
    // Where the line's text goes on from once its kind is known: held code
    // skips to the line's end, anything else is read for spans.
    const next = (): number => (held ? lineEnd(start) : start);
    let position: LinePosition = line;
    let indent = indentAt(text, position.at);
    let blank = indent.end === text.length || text[indent.end] === "\n";
    if (line.matched < containers.length && !blank) {
      // A paragraph's next line may leave its containers' markers out.
      if (!codeMayStart && !startsBlock(text, indent.end, indent.width - line.skip)) return next();
      codeMayStart = true;
    }
    if (line.matched < containers.length) containers.length = line.matched;
    if (!(codeMayStart && indent.width - position.skip >= 4)) {
      const opened = openContainers(text, position, containers);
      if (opened !== null) {
        position = opened;
        indent = indentAt(text, position.at);
        blank = indent.end === text.length || text[indent.end] === "\n";
        codeMayStart = true;
      }
    }
    const width = indent.width - position.skip;
    if (blank) {
      codeMayStart = true;
      return next();
    }
    if (codeMayStart && width >= 4) {
      // An indented code line, up to its line break.
      if (held) return lineEnd(start);
      ranges.push([proseStart, start]);
      proseStart = lineEnd(start);
      return proseStart;
    }
    const opener = width <= 3 ? fenceAt(text, indent.end) : null;
    if (opener !== null) {
      if (!held) ranges.push([proseStart, start]);
      held = false;
      proseStart = text.length;
      const plain = /^ {0,3}$/u.test(text.slice(start, indent.end));
      fence = { char: opener.char, length: opener.length, plain };
      return lineEnd(opener.end);
    }
    codeMayStart = ATX_HEADING.test(text.slice(indent.end, indent.end + 8));
    return next();
  };
  let lineRead = -1;
  while (i < text.length) {
    if ((i === 0 || text[i - 1] === "\n") && lineRead !== i) {
      lineRead = i;
      const next = readLine(i);
      if (next !== i) {
        i = next;
        continue;
      }
    }
    if (text[i] === "`") {
      const length = runAt(text, i, "`");
      ranges.push([proseStart, i]);
      let p = i + length;
      let close = text.length;
      while (p < text.length) {
        if (text[p] === "`") {
          const run = runAt(text, p, "`");
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
