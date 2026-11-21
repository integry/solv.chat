/**
 * Where an answer's Markdown is code, read the way the engine reads it.
 *
 * The engine leaves code alone when it takes out citation markers and when
 * it checks the links in an answer: a link inside an inline code span, a
 * fenced block or an indented block is kept as written and never checked
 * against the answer's pages. Anything that shows an answer and turns its
 * links into real links (the admin "Try it" pane) uses the same reading, so
 * a code example stays literal there too.
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

/**
 * Whether the character at `at` is escaped by a Markdown backslash before it:
 * an odd run of backslashes (`\\\`` is an escaped backslash and a real
 * backtick). Only in prose; inside code a backslash is a backslash.
 */
export function escapedAt(text: string, at: number): boolean {
  let backslashes = 0;
  for (let p = at - 1; p >= 0 && text[p] === "\\"; p--) backslashes++;
  return backslashes % 2 === 1;
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

/** An autolink's start up to its scheme's ":" (`<https:`), and the rest of its address. */
const AUTOLINK_SCHEME = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:/uy;
const AUTOLINK_REST = /[^\s<>]*>?/uy;
/** A reference definition's label and colon (`[report]:`), at the start of a line's text. */
const DEFINITION_LABEL = /\[(?:[^[\]\\\n]|\\[^\n])+\]:/uy;

/** Where `pattern` (sticky) matching at `at` ends, or null if it does not match there. */
function matchEnd(pattern: RegExp, text: string, at: number): number | null {
  pattern.lastIndex = at;
  return pattern.exec(text) === null ? null : pattern.lastIndex;
}

/**
 * Where a link destination that may start at `at` ends: past the spaces
 * before it, either `<…>` up to its ">" or a run up to a space, a line break
 * or a ")" that closes no "(" in it. Never past a line break, so lines are
 * still read one by one; unfinished, it runs to the end of the text.
 */
function destinationEnd(text: string, at: number): number {
  let p = at;
  while (text[p] === " " || text[p] === "\t") p++;
  const angle = text[p] === "<";
  if (angle) p++;
  let depth = 0;
  for (; p < text.length; p++) {
    const char = text[p];
    if (char === "\n") return p;
    if (char === "\\") {
      // An escaped character is part of the address, a line break never.
      if (text[p + 1] !== "\n") p++;
    } else if (angle) {
      if (char === ">") return p + 1;
      if (char === "<") return p;
    } else if (char === " " || char === "\t") {
      return p;
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      if (depth === 0) return p;
      depth--;
    }
  }
  return text.length;
}

/** A bracket of only numbers (`[1]`, `[1, 2]`): a citation marker, as the engine's link check reads one. */
const MARKER_LABEL = /^[ \t]*\d[ \t\d,–-]*$/u;

/**
 * Where an inline link's tail that starts after its "](" at `at` ends, read
 * the way the engine's link check reads it (`readDestination` in
 * `chat/sourceLinks.ts`): its destination, an optional title in `"…"`, `'…'`
 * or `(…)`, and the closing ")". Returns the position past the ")"; unfinished,
 * the end of the text; and where it stops being a link's tail (a line break,
 * a "<" in `<…>`, anything but ")" after the title), that position.
 */
function linkTailEnd(text: string, at: number): number {
  let p = at;
  const skipSpaces = () => {
    while (text[p] === " " || text[p] === "\t") p++;
  };
  skipSpaces();
  const angle = text[p] === "<";
  if (angle) p++;
  let depth = 0;
  let destEnd = -1;
  for (; p < text.length; p++) {
    const char = text[p];
    if (char === "\n") return p;
    if (char === "\\") {
      // A backslash never escapes a line break: no destination holds one.
      if (text[p + 1] !== "\n") p++;
    } else if (angle) {
      if (char === ">") {
        destEnd = ++p;
        break;
      }
      if (char === "<") return p;
    } else if (char === " " || char === "\t" || (char === ")" && depth === 0)) {
      destEnd = p;
      break;
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
    }
  }
  if (destEnd === -1) return text.length;
  skipSpaces();
  const quote = text[p];
  if (quote === '"' || quote === "'" || quote === "(") {
    const closer = quote === "(" ? ")" : quote;
    for (p++; p < text.length && text[p] !== closer; p++) {
      if (text[p] === "\n") return p;
      if (text[p] === "\\" && text[p + 1] !== "\n") p++;
    }
    if (p >= text.length) return text.length;
    p++;
    skipSpaces();
  }
  if (p >= text.length) return text.length;
  return text[p] === ")" ? p + 1 : p;
}

/**
 * Where a reference link's second bracket, whose "[" is at `at`, ends: past
 * its "]", or where a line break or another "[" ends it first (unfinished, the
 * end of the text), as the engine's link check reads it.
 */
function referenceEnd(text: string, at: number): number {
  for (let p = at + 1; p < text.length; p++) {
    if (text[p] === "\n" || text[p] === "[") return p;
    if (text[p] === "]") return p + 1;
  }
  return text.length;
}

/**
 * The `[start, end)` ranges of `text` that are prose, not Markdown code nor
 * a link's destination.
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
 * an inline span that ends at the same number of backticks or at a blank line;
 * a backtick escaped with a backslash (`\``) opens none, while inside a span
 * a backslash is a backslash, as in Markdown.
 *
 * A link's destination is left out too: what follows "](" (an inline link's
 * or an image's), "<" and a scheme's ":" (an autolink's), or a line's opening
 * "[label]:" (a reference definition's, left out with its label), up to where
 * `destinationEnd` (or, for an autolink, a space, "<" or ">") ends it. The "(" stays with the prose
 * before it, so a marker there is still seen to be a link's text.
 *
 * Read strictly left to right: whether a character is code (or a destination)
 * depends only on the text before it, so appending text never turns
 * already-sent prose into code or back. (Markdown proper would wait for a
 * closing backtick or ")"; a stray one here only protects the rest of its
 * paragraph or the word after it, which keeps markers in.)
 *
 * With `keepLinks`, links are left in the prose whole (their destinations, autolinks
 * and reference definitions too): only code is left out. The engine's link
 * check (`chat/sourceLinks.ts`) and the admin "Try it" pane read links
 * themselves. A link's tail (after its label's "]": the destination and
 * title up to ")", or a reference's "[…]") and an autolink's address open no
 * code span there: the check reads a backtick in them as part of the link
 * and may write the link without it (a title is dropped, a link it does not
 * allow loses all but its label), so a span opened there would hide the
 * links after it from the check while they reach the visitor as links.
 * Where a tail turns out not to be one (a line break, anything but ")" after
 * the title), reading goes on from there as usual; what came before stays
 * prose, so appending text still changes nothing already read.
 *
 * Lines end at "\n" only: a caller reading text with "\r\n" or "\r" endings
 * maps them first (`"\r\n"` to `" \n"`, `"\r"` to `"\n"`), keeping indexes.
 */
export function proseRanges(text: string, keepLinks = false): Array<[number, number]> {
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
  // Leaves `[start, end)` out of the prose (a link's destination) and
  // returns where to go on from.
  const skip = (start: number, end: number): number => {
    ranges.push([proseStart, start]);
    proseStart = end;
    return end;
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
    const label =
      !held && !keepLinks && width <= 3 ? matchEnd(DEFINITION_LABEL, text, indent.end) : null;
    if (label !== null) {
      // A reference definition: its label is no marker, and its destination
      // is the word after the label.
      codeMayStart = false;
      return skip(indent.end, destinationEnd(text, label));
    }
    codeMayStart = ATX_HEADING.test(text.slice(indent.end, indent.end + 8));
    return next();
  };
  let lineRead = -1;
  // With `keepLinks`, where the last "[" in prose on this line is while no
  // "]" has closed it yet (or -1): a link's label, whose "]" may start its tail.
  let label = -1;
  while (i < text.length) {
    if ((i === 0 || text[i - 1] === "\n") && lineRead !== i) {
      lineRead = i;
      label = -1;
      const next = readLine(i);
      if (next !== i) {
        i = next;
        continue;
      }
    }
    // An escaped "]", "<" or "`" (`\``) is plain text, as in Markdown, and
    // opens nothing; inside a span the closing backticks are found as they
    // are, since code does not escape.
    if (escapedAt(text, i)) {
      i++;
      continue;
    }
    if (!keepLinks && text[i] === "]" && text[i + 1] === "(") {
      i = skip(i + 2, destinationEnd(text, i + 2));
      continue;
    }
    if (!keepLinks && text[i] === "<") {
      const scheme = matchEnd(AUTOLINK_SCHEME, text, i);
      if (scheme !== null) {
        i = skip(scheme, matchEnd(AUTOLINK_REST, text, scheme) ?? scheme);
        continue;
      }
    }
    if (keepLinks) {
      // A link's tail stays prose but opens no code span: the link check
      // reads it as the link's (and may write the link without it), so a
      // backtick there must not hide what follows it from that check.
      if (text[i] === "[") {
        label = i;
      } else if (text[i] === "]" && label !== -1) {
        const words = text.slice(label + 1, i);
        label = -1;
        if (text[i + 1] === "(") {
          i = linkTailEnd(text, i + 2);
          continue;
        }
        if (text[i + 1] === "[" && !MARKER_LABEL.test(words)) {
          i = referenceEnd(text, i + 1);
          continue;
        }
      } else if (text[i] === "<") {
        const scheme = matchEnd(AUTOLINK_SCHEME, text, i);
        if (scheme !== null) {
          i = matchEnd(AUTOLINK_REST, text, scheme) ?? scheme;
          continue;
        }
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
      // A label holds no line break, so a span running onto another line
      // leaves no "[" open behind it.
      if (text.slice(i, close).includes("\n")) label = -1;
      i = close;
      proseStart = close;
      continue;
    }
    i++;
  }
  ranges.push([proseStart, text.length]);
  return ranges.filter(([start, end]) => end > start);
}
