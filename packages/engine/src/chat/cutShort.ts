/**
 * What is added to an answer the model stopped at its output limit, so the
 * visitor is not left with half a sentence or an unclosed code block. One
 * fixed sentence in the site's voice; per-assistant text is not offered.
 */
export const CUT_SHORT_LINE = "That answer was cut short. Ask me to continue.";

// The widget's own fence rules (`packages/widget/src/markdown.ts`): up to
// three spaces, three or more backticks, an info string with no backtick; a
// closing fence is backticks only, at least as many as opened it.
const FENCE_OPEN_RE = /^ {0,3}(`{3,})([^`]*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,})\s*$/;

/**
 * The backticks that would close a code fence still open at the end of
 * `text`, or null when every fence is closed.
 */
export function openFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
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

/**
 * The text to append to an answer that was cut at the length limit: the
 * closing fence when a code block was left open, then the closing line,
 * each starting on a line of its own.
 */
export function cutShortSuffix(text: string): string {
  const fence = openFence(text);
  let suffix = "";
  let tail = text;
  if (fence !== null) {
    suffix += `${tail.endsWith("\n") || tail === "" ? "" : "\n"}${fence}\n`;
    tail += suffix;
  }
  const lead =
    tail.trim() === "" ? "" : tail.endsWith("\n\n") ? "" : tail.endsWith("\n") ? "\n" : "\n\n";
  return `${suffix}${lead}${CUT_SHORT_LINE}`;
}
