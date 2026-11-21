/**
 * What of a half-streamed answer can be shown without showing half-written
 * Markdown. The renderer (`markdown.ts`) shows an unfinished construct as
 * literal text: `[the guide](https://exa` as brackets and a stray URL, `**Note`
 * with its asterisks, a list marker on its own, a table row as a paragraph.
 * Those characters would then vanish a moment later. So, while the answer is
 * still arriving, the end of the text that could still turn into one of these
 * is held back until it completes; the caller shows it anyway after a short
 * time (see `HOLD_BOUND_MS`), and always once the stream ends, so the final
 * text is exactly what rendering the whole answer gives.
 *
 * A code fence is not held: a code block can be long, so an open one is shown
 * as a code block growing (with a closing fence added for the moment), and
 * only a last line that could be the closing fence waits.
 *
 * Only the rules the renderer itself has are followed here: links are
 * `[text](url)` on one line, emphasis is `*` and `**`, code spans are single
 * backticks on one line, fences are three or more backticks.
 */

/** The longest a construct is held back before it is shown as it stands. */
export const HOLD_BOUND_MS = 600;

export interface StreamingView {
  /** The Markdown to render now. */
  markdown: string;
  /** Where the held-back text starts; the text's length when nothing is held. */
  heldFrom: number;
}

// The renderer's fence rules: up to three spaces, three or more backticks,
// an info string with no backtick; a closing fence is backticks only, at
// least as many as opened it.
const FENCE_OPEN_RE = /^ {0,3}(`{3,})([^`]*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,})\s*$/;
/** A last line that is backticks so far: a fence opening or closing, or not. */
const BACKTICKS_ONLY_RE = /^ {0,3}`+$/;
/** A list marker with nothing after it yet ("-", "1.", "2) "). */
const BARE_LIST_MARKER_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)]?)[ \t]*$/;
/** What a table's delimiter row is made of, so far. */
const DELIMITER_SO_FAR_RE = /^[ \t|:-]*$/;

/** Backticks that would close the fence still open at the end of these lines, or null. */
function openFence(lines: readonly string[]): string | null {
  let open: string | null = null;
  for (const line of lines) {
    if (open === null) {
      const match = FENCE_OPEN_RE.exec(line);
      if (match) open = match[1] ?? "```";
      continue;
    }
    const close = FENCE_CLOSE_RE.exec(line);
    if (close && (close[1]?.length ?? 0) >= open.length) open = null;
  }
  return open;
}

/** Whether `line` has a `|` outside a code span, which may make it a table row. */
function hasPipe(line: string): boolean {
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") {
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
    } else if (ch === "|" && !inCode) {
      return true;
    }
  }
  return false;
}

/**
 * Where an unfinished inline construct starts in `line` (the last, still
 * growing line of the answer), or -1 when every one is complete.
 */
function unfinishedInline(line: string): number {
  // Opening `*` runs not yet closed, as positions in the line.
  const openEmphasis: number[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") {
      // An escape takes the next character; one at the very end is waiting for it.
      if (i + 1 >= line.length) return i;
      i += 2;
      continue;
    }
    if (ch === "`") {
      const close = line.indexOf("`", i + 1);
      if (close === -1) return earliest(openEmphasis, i);
      i = close + 1;
      continue;
    }
    if (ch === "[") {
      const end = linkEnd(line, i);
      if (end === -1) return earliest(openEmphasis, i > 0 && line[i - 1] === "!" ? i - 1 : i);
      i = end;
      continue;
    }
    if (ch === "*") {
      let end = i;
      while (line[end] === "*") end++;
      const before = i > 0 ? (line[i - 1] ?? "") : "";
      const after = line[end] ?? "";
      if (after === "") {
        // Nothing after it yet: it may open emphasis, close it, or be a marker.
        return earliest(openEmphasis, i);
      }
      const canClose = before !== "" && !/\s/.test(before);
      const canOpen = !/\s/.test(after);
      if (canClose && openEmphasis.length > 0) openEmphasis.pop();
      else if (canOpen) openEmphasis.push(i);
      i = end;
      continue;
    }
    i++;
  }
  return openEmphasis.length > 0 ? (openEmphasis[0] ?? -1) : -1;
}

function earliest(open: readonly number[], at: number): number {
  return open.length > 0 ? Math.min(open[0] ?? at, at) : at;
}

/**
 * Where the text after the `[` at `start` is settled: past the end of a
 * complete link, or straight after a bracket that can no longer be one.
 * -1 while it could still become a link.
 */
function linkEnd(line: string, start: number): number {
  const close = line.indexOf("]", start + 1);
  if (close === -1) return -1;
  if (close + 1 >= line.length) return -1; // "(" may come next
  if (line[close + 1] !== "(") return close + 1;
  let depth = 1;
  for (let j = close + 2; j < line.length; j++) {
    const ch = line[j];
    // The renderer allows no whitespace in a link's destination.
    if (ch === " " || ch === "\t") return j;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

/**
 * The view of `text` to render while it is still streaming: everything up to
 * the first construct that is not finished yet, and an open code block shown
 * as one. `text` is shown whole when nothing is unfinished.
 */
export function streamingView(text: string): StreamingView {
  const lastBreak = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  const lineStart = lastBreak + 1;
  const last = text.slice(lineStart);
  const complete = text.slice(0, lineStart).replace(/\r\n?/g, "\n");
  const lines = complete === "" ? [] : complete.slice(0, -1).split("\n");

  const fence = openFence(lines);
  if (fence !== null) {
    // In a code block: only a last line that may be the closing fence waits.
    const cut = BACKTICKS_ONLY_RE.test(last) ? lineStart : text.length;
    const shown = text.slice(0, cut);
    const joiner = shown.endsWith("\n") || shown.endsWith("\r") ? "" : "\n";
    return { markdown: `${shown}${joiner}${fence}`, heldFrom: cut };
  }

  let cut = text.length;
  if (BACKTICKS_ONLY_RE.test(last) || FENCE_OPEN_RE.test(last) || BARE_LIST_MARKER_RE.test(last)) {
    // A fence being opened, or a list item with no text yet.
    cut = lineStart;
  } else if (hasPipe(last) || /^[ \t]*\|/.test(last)) {
    // A table row is shown once it is whole.
    cut = lineStart;
  } else {
    const inline = unfinishedInline(last);
    if (inline !== -1) cut = lineStart + inline;
  }

  // A row with pipes straight before a delimiter row still arriving is a
  // table header: it waits for the delimiter rather than showing as a
  // paragraph. Not when the line above has pipes too: then it is a row of a
  // table already shown.
  const previous = lines[lines.length - 1];
  const lineBefore = lines[lines.length - 2];
  if (
    cut === lineStart &&
    previous !== undefined &&
    hasPipe(previous) &&
    (lineBefore === undefined || !hasPipe(lineBefore)) &&
    DELIMITER_SO_FAR_RE.test(last)
  ) {
    const previousStart = text.lastIndexOf(previous, lineStart);
    if (previousStart !== -1) cut = previousStart;
  }

  // A backslash ending a line is a line break only once the next line has
  // begun; until then the renderer shows it.
  if (cut === text.length && last === "" && previous?.endsWith("\\")) {
    cut = text.lastIndexOf("\\", lineStart);
  }

  return { markdown: text.slice(0, cut), heldFrom: cut };
}
