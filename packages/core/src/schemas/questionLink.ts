/**
 * Most characters (code points) of a grouped question a link to its
 * conversations carries. A grouped question can be thousands of characters
 * long, and percent-encoded it can be several times longer than that: too long
 * for an address. A longer question is sent as its first characters, and the
 * conversation list matches every group that starts with them. Two questions
 * that agree on their whole first 150 characters then share a link; the count
 * beside the link is still for the one question.
 */
export const QUESTION_LINK_LENGTH = 150;

/**
 * The `question=` a link sends for a grouped question (already normalised:
 * trimmed, lowercase, whitespace collapsed). A short one is sent whole. A
 * longer one is cut to `QUESTION_LINK_LENGTH` characters, never inside one,
 * and one more when the cut ends on a space: the engine trims what it is sent,
 * so a trailing space would leave the text too short to be read as a start.
 */
export function toQuestionLink(question: string): string {
  const chars = Array.from(question);
  if (chars.length <= QUESTION_LINK_LENGTH) return question;
  const end =
    chars[QUESTION_LINK_LENGTH - 1]?.trim() === ""
      ? QUESTION_LINK_LENGTH + 1
      : QUESTION_LINK_LENGTH;
  return chars.slice(0, end).join("");
}

/** Whether a `question=` is the start of longer questions rather than one whole question. */
export function isQuestionLinkStart(question: string): boolean {
  return Array.from(question).length >= QUESTION_LINK_LENGTH;
}
