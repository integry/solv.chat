import { isPlainObject } from "@solvchat/core";
import { normalizeQuestionText } from "../db/messages.js";
import type { Tenant } from "../db/tenant.js";
import { BadRequest, NotFound } from "./errors.js";

export interface GapSummary {
  question: string;
  displayQuestion: string;
  times: number;
  lastAsked: number;
  exampleMessageId: string;
  handled: boolean;
  documentId: string | null;
}

export interface GapsPage {
  gaps: GapSummary[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * The unanswered questions. `answered = 0` is written by the chat pipeline when
 * nothing cleared the score floor, so this screen is a direct read of that
 * decision rather than a second heuristic that could disagree with it.
 *
 * Grouping is by the normalised question text: lowercased and with runs of
 * whitespace collapsed, stored with the question when it is written. Each
 * unanswered reply counts against the question it records in `reply_to`. Fuzzy grouping would need embeddings per gap and a
 * threshold to argue about; the specification asks only that gaps be listed.
 *
 * `openOnly` leaves out groups that already have a written answer, which is
 * what the Gaps screen lists. Dismissed groups are always left out until the
 * question is asked again.
 */
export async function listGaps(
  tenant: Tenant,
  assistantId: string,
  options: { limit?: number; offset?: number; openOnly?: boolean } = {},
): Promise<GapsPage> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");

  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 50)), 100);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));

  const { groups, total } = await tenant.messages.gapGroups(assistantId, {
    limit,
    offset,
    openOnly: options.openOnly === true,
  });
  return {
    gaps: groups.map((group) => ({ ...group, handled: group.documentId !== null })),
    total,
    limit,
    offset,
  };
}

/** Upper bound on a question key in a dismiss request: longer is not a key we stored. */
const MAX_QUESTION_KEY = 2000;

function readQuestionKey(body: unknown): string {
  if (!isPlainObject(body) || typeof body.question !== "string") {
    throw new BadRequest(["question: must be a string"]);
  }
  // Normalised again so a display-text question finds the same group.
  const key = normalizeQuestionText(body.question);
  if (key.length === 0 || key.length > MAX_QUESTION_KEY) {
    throw new BadRequest(["question: must not be empty"]);
  }
  return key;
}

/** "Dismiss": hides one gap group until a visitor asks the question again. */
export async function dismissGap(
  tenant: Tenant,
  assistantId: string,
  body: unknown,
): Promise<{ question: string; dismissed: true }> {
  const question = readQuestionKey(body);
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  await tenant.messages.dismissGap(assistantId, question, Date.now());
  return { question, dismissed: true };
}

/** "Undo" after "Dismiss": the group is listed again. */
export async function restoreGap(
  tenant: Tenant,
  assistantId: string,
  body: unknown,
): Promise<{ question: string; dismissed: false }> {
  const question = readQuestionKey(body);
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  await tenant.messages.restoreGap(assistantId, question);
  return { question, dismissed: false };
}
