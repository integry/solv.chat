import { escapedAt, proseRanges } from "@solvchat/core";
import type { ReactNode } from "react";
import { isSafeHttpUrl } from "../safeUrl.js";

/**
 * An inline Markdown link: `[words](https://…)`. The engine writes source
 * links this way, with any space, parenthesis or angle bracket in the address
 * percent-encoded, so the address never holds one. An optional `!` before it
 * makes it an image, which is not turned into a link here.
 */
const INLINE_LINK = /(!?)\[([^[\]\n]*)\]\(([^\s()<>]+)\)/gu;

/**
 * Whether `[start, end)` lies in prose, not code, as the engine reads the
 * answer. The engine checks only links in prose against the answer's pages
 * and keeps a link in code as written, so one in code stays text here.
 */
function inProse(ranges: ReadonlyArray<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([from, to]) => from <= start && end <= to);
}

/**
 * Shows answer text as it is, except that each inline link to an `http(s)`
 * address becomes a real link: with sources linked in the text and no list
 * under the answer, these links are the only way to reach the sources. Any
 * other text, a link to another kind of address, an escaped `\[`, an image and
 * anything in code (an inline code span, a fenced or indented block) stay
 * plain text. React escapes every piece, so the text can add no markup.
 */
export function InlineLinks({ text }: { text: string }) {
  // Read with every line ending as "\n", keeping indexes, as the engine does.
  const ranges = proseRanges(
    text.replace(/\r\n?/gu, (eol) => (eol.length === 2 ? " \n" : "\n")),
    true,
  );
  const parts: ReactNode[] = [];
  let copied = 0;
  for (const match of text.matchAll(INLINE_LINK)) {
    const [whole, bang = "", label = "", href = ""] = match;
    const start = match.index;
    // The "]" before the address: from there to the ")" must be prose too.
    const close = start + bang.length + 1 + label.length;
    if (
      bang !== "" ||
      escapedAt(text, start) ||
      label.trim() === "" ||
      !isSafeHttpUrl(href) ||
      !inProse(ranges, start, start + 1) ||
      !inProse(ranges, close, start + whole.length)
    ) {
      continue;
    }
    if (start > copied) parts.push(text.slice(copied, start));
    parts.push(
      <a key={start} href={href} target="_blank" rel="noreferrer">
        {label}
      </a>,
    );
    copied = start + whole.length;
  }
  if (copied === 0) return <>{text}</>;
  if (copied < text.length) parts.push(text.slice(copied));
  return <>{parts}</>;
}
