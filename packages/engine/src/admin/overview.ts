import type { TopQuestionRow } from "../db/messages.js";
import type { Tenant } from "../db/tenant.js";
import { utcDay } from "../util/time.js";
import { NotFound } from "./errors.js";

export interface AssistantOverview {
  messages: number;
  answeredShare: number;
  topQuestions: TopQuestionRow[];
  todayCostMicros: number;
}

/**
 * The four numbers the specification names, read in one call so the screen
 * cannot show a message count from one instant beside a cost from another.
 *
 * Cost comes from usage_daily rather than being recomputed from messages:
 * usage_daily is what the UsageSink wrote, so the owner sees the same figure
 * the spend cap enforces. Recomputing could disagree after a price change.
 */
export async function overviewFor(
  tenant: Tenant,
  assistantId: string,
  today: string = utcDay(Date.now()),
): Promise<AssistantOverview> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");

  const [messages, answeredShare, topQuestions, todayCost] = await Promise.all([
    tenant.messages.countFor(assistantId),
    tenant.messages.answeredShareFor(assistantId),
    tenant.messages.topQuestionsFor(assistantId, 5),
    tenant.usage.costMicrosFor(assistantId, today),
  ]);

  // A day with no messages reads zero rather than null: the screen shows a
  // number with a plain sentence, and "—" would make an owner wonder if it is
  // broken.
  return {
    messages,
    answeredShare,
    topQuestions,
    todayCostMicros: todayCost ?? 0,
  };
}
