import { toQuestionLink } from "@solvchat/core";

/** Inclusive UTC days, `YYYY-MM-DD`: the period a Reports count is for. */
export interface AskedRange {
  from: string;
  to: string;
}

/**
 * Where a question in Overview or Reports leads: that assistant's
 * conversations in which a visitor asked it, matched by the grouped question
 * the count is for (not by its words anywhere, which would also find replies
 * and longer questions). The address names the assistant, so a link opened in
 * a new tab does not land on another one. A very long question is sent as its
 * start (`toQuestionLink`), so the address stays short enough to load.
 *
 * `asked` is the report's period: the list keeps the conversations where the
 * question was asked in those same UTC days, the asks the count is of. It is
 * not the list's "Started" choice: a conversation started long before can
 * hold a question asked this week.
 */
export function questionConversationsQuery(
  assistantId: string,
  question: string,
  asked?: AskedRange,
): Record<string, string> {
  return {
    question: toQuestionLink(question),
    ...(asked === undefined ? {} : { askedFrom: asked.from, askedTo: asked.to }),
    assistant: assistantId,
  };
}
