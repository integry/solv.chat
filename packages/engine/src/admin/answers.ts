import { type EntryDeps, type SaveEntryResult, saveEntry } from "./entries.js";
import { BadRequest, NotFound } from "./errors.js";

export interface WriteAnswerArgs {
  assistantId: string;
  question: string;
  answer: string;
  fromMessageId: string;
}

/**
 * "Write the right answer". Takes the question from the gap, hands the words to
 * saveEntry (reviewed with the Sources screen), and records which message
 * prompted it so the gap can show as handled.
 *
 * Linking by message id rather than question text: the owner may reword the
 * question when they answer it, and a text link would then silently break.
 */
export async function writeTheRightAnswer(
  deps: EntryDeps,
  principal: { orgId: string },
  args: WriteAnswerArgs,
): Promise<SaveEntryResult> {
  if (!args.fromMessageId || args.fromMessageId.trim().length === 0) {
    throw new BadRequest(["fromMessageId: is required"]);
  }

  const assistant = await deps.tenant.assistants.get(args.assistantId);
  if (assistant === null) throw new NotFound("assistant");

  const message = await deps.tenant.messages.get(args.fromMessageId);
  // 404 rather than trusting the body's question: the message proves the gap
  // exists in this org and assistant, which is what makes the link meaningful.
  if (message === null) throw new NotFound("message");
  const conversation = await deps.tenant.conversations.get(message.conversationId);
  if (conversation === null || conversation.assistantId !== args.assistantId) {
    throw new NotFound("message");
  }

  // A reply links through the question it records; guessing "the latest
  // question before it" picks the wrong one when two requests interleave.
  const canonicalMessageId =
    message.role === "assistant" && message.replyTo !== null ? message.replyTo : args.fromMessageId;

  const result = await saveEntry(deps, principal, {
    assistantId: args.assistantId,
    question: args.question,
    answer: args.answer,
  });

  await deps.tenant.messages.linkGapAnswer(canonicalMessageId, result.documentId, Date.now());

  return result;
}
