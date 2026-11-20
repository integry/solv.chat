import { Errors, fail, ok, type Result } from "../result.js";
import { parseSessionField } from "./chat.js";
import { isPlainObject, readTrimmedString } from "./shared.js";

export type FeedbackVote = "up" | "down";

export interface FeedbackRequest {
  messageId: string;
  visitorId: string;
  value: FeedbackVote;
  note: string;
  /** The signed visitor session, when the engine runs the visitor check. */
  session?: string;
}

/** Validates an incoming public feedback request. */
export function parseFeedbackRequest(value: unknown): Result<FeedbackRequest> {
  if (!isPlainObject(value)) return fail("body: must be a JSON object");

  const errors = new Errors();

  const messageId = readTrimmedString(value.messageId, 1, 128);
  if (messageId === null) errors.add("messageId", "must be 1 to 128 characters");

  const visitorId = readTrimmedString(value.visitorId, 1, 128);
  if (visitorId === null) errors.add("visitorId", "must be 1 to 128 characters");

  let vote: FeedbackVote | null = null;
  if (value.value !== "up" && value.value !== "down") {
    errors.add("value", 'must be "up" or "down"');
  } else {
    vote = value.value;
  }

  let note = "";
  if (value.note !== undefined) {
    const parsedNote = readTrimmedString(value.note, 0, 1000);
    if (parsedNote === null) errors.add("note", "must be at most 1000 characters");
    else note = parsedNote;
  }

  const session = parseSessionField(value.session, errors);

  if (errors.failed || messageId === null || visitorId === null || vote === null) {
    return fail(...errors.list);
  }

  return ok({
    messageId,
    visitorId,
    value: vote,
    note,
    ...(session !== undefined ? { session } : {}),
  });
}
