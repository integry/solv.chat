import type { ReactNode } from "react";
import { isSafeHttpUrl } from "../safeUrl.js";

/**
 * An inline Markdown link: `[words](https://…)`. The engine writes source
 * links this way, with any space, parenthesis or angle bracket in the address
 * percent-encoded, so the address never holds one. An optional `!` before it
 * makes it an image, which is not turned into a link here.
 */
const INLINE_LINK = /(!?)\[([^[\]\n]*)\]\(([^\s()<>]+)\)/gu;

function escapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

/**
 * Shows answer text as it is, except that each inline link to an `http(s)`
 * address becomes a real link: with sources linked in the text and no list
 * under the answer, these links are the only way to reach the sources. Any
 * other text, a link to another kind of address, an escaped `\[` and an image
 * stay plain text. React escapes every piece, so the text can add no markup.
 */
export function InlineLinks({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let copied = 0;
  for (const match of text.matchAll(INLINE_LINK)) {
    const [whole, bang = "", label = "", href = ""] = match;
    const start = match.index;
    if (bang !== "" || escapedAt(text, start) || label.trim() === "" || !isSafeHttpUrl(href)) {
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
