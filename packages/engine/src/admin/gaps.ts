import { normalizeQuestionText } from "../db/messages.js";
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
 * whitespace collapsed. Fuzzy grouping would need embeddings per gap and a
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

  const rows = await tenant.messages.listGapRows(assistantId);
  const groups = new Map<string, GapSummary>();

  for (const row of rows) {
    const key = normalizeQuestionText(row.questionContent);
    if (!key) continue;

    const existing = groups.get(key);
    if (existing) {
      existing.times += 1;
      if (row.askedAt > existing.lastAsked) {
        existing.lastAsked = row.askedAt;
        existing.exampleMessageId = row.questionId;
        existing.displayQuestion = row.questionContent.trim();
      }
      if (row.answerDocumentId !== null && existing.documentId === null) {
        existing.handled = true;
        existing.documentId = row.answerDocumentId;
      }
    } else {
      groups.set(key, {
        question: key,
        displayQuestion: row.questionContent.trim(),
        times: 1,
        lastAsked: row.askedAt,
        exampleMessageId: row.questionId,
        handled: row.answerDocumentId !== null,
        documentId: row.answerDocumentId,
      });
    }
  }

  const sorted = Array.from(groups.values()).sort(
    (a, b) => b.times - a.times || b.lastAsked - a.lastAsked,
  );
  return {
    gaps: sorted.slice(offset, offset + limit),
    total: sorted.length,
    limit,
    offset,
  };
}
