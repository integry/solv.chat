import { toQuestionLink } from "@solvchat/core";

/**
 * Where a question in Overview or Reports leads: that assistant's
 * conversations in which a visitor asked it, matched by the grouped question
 * the count is for (not by its words anywhere, which would also find replies
 * and longer questions). The address names the assistant, so a link opened in
 * a new tab does not land on another one. A very long question is sent as its
 * start (`toQuestionLink`), so the address stays short enough to load.
 *
 * `days` is the period the count is for, so the list opens on the same span.
 * The two can still differ a little: the count is for whole UTC days, while
 * the list's "last N days" runs back from now by when each conversation
 * started.
 */
export function questionConversationsQuery(
  assistantId: string,
  question: string,
  days?: number,
): Record<string, string> {
  return {
    question: toQuestionLink(question),
    ...(days === undefined ? {} : { days: String(days) }),
    assistant: assistantId,
  };
}
