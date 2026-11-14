import type { Tenant } from "../db/tenant.js";
import { NotFound } from "./errors.js";

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
 */
export async function listGaps(
  tenant: Tenant,
  assistantId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<GapsPage> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");

  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 50)), 100);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));

  const { groups, total } = await tenant.messages.gapGroups(assistantId, { limit, offset });
  return {
    gaps: groups.map((group) => ({ ...group, handled: group.documentId !== null })),
    total,
    limit,
    offset,
  };
}
