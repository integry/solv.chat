import { toConversationSearch } from "@solvchat/core";

/**
 * Where a question in Overview or Reports leads: that assistant's
 * conversations, searched for the question. The address names the assistant,
 * so a link opened in a new tab does not land on another one, and the search
 * is cut to the length the conversation list accepts.
 */
export function questionConversationsQuery(
  assistantId: string,
  question: string,
): Record<string, string> {
  return { q: toConversationSearch(question), assistant: assistantId };
}
