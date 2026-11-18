/**
 * Where a question in Overview or Reports leads: that assistant's
 * conversations in which a visitor asked it, matched by the grouped question
 * the count is for (not by its words anywhere, which would also find replies
 * and longer questions). The address names the assistant, so a link opened in
 * a new tab does not land on another one.
 */
export function questionConversationsQuery(
  assistantId: string,
  question: string,
): Record<string, string> {
  return { question, assistant: assistantId };
}
