/**
 * Longest `q=` the conversation list accepts, in UTF-16 code units (the
 * length JavaScript reports). The engine refuses anything longer.
 */
export const MAX_CONVERSATION_SEARCH_LENGTH = 200;

/**
 * Turns any text (a stored question, say) into a search the conversation list
 * accepts. The search matches text anywhere in a message, so keeping the start
 * still finds every conversation the whole text would. A character is never
 * cut in half, so the result is always valid to put in an address.
 */
export function toConversationSearch(text: string): string {
  const search = text.trim();
  if (search.length <= MAX_CONVERSATION_SEARCH_LENGTH) return search;
  let kept = "";
  for (const char of search) {
    if (kept.length + char.length > MAX_CONVERSATION_SEARCH_LENGTH) break;
    kept += char;
  }
  return kept.trim();
}
