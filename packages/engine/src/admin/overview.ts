import { defaultVersionConfig } from "@solvchat/core";
import type { TopQuestionRow } from "../db/messages.js";
import type { Tenant } from "../db/tenant.js";
import { utcDay } from "../util/time.js";
import { NotFound } from "./errors.js";

export interface AssistantOverview {
  messages: number;
  answeredShare: number;
  topQuestions: TopQuestionRow[];
  todayCostMicros: number;
  todayCostUnknown: boolean;
  dailyCostCapMicros: number;
  configError: string | null;
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
  options?: {
    today?: string | undefined;
    checkConfigError?: (() => Promise<string | null>) | undefined;
  },
): Promise<AssistantOverview> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");

  const today = options?.today ?? utcDay(Date.now());
  const [messages, answeredShare, topQuestions, todayUsage, published, configError] =
    await Promise.all([
      tenant.messages.countFor(assistantId),
      tenant.messages.answeredShareFor(assistantId),
      tenant.messages.topQuestionsFor(assistantId, 5),
      tenant.usage.summaryFor(assistantId, today),
      tenant.versions.published(assistantId),
      options?.checkConfigError ? options.checkConfigError() : Promise.resolve(null),
    ]);

  const dailyCostCapMicros = published
    ? published.config.limits.dailyCostCapMicros
    : defaultVersionConfig().limits.dailyCostCapMicros;

  // A day with no messages reads zero rather than null: the screen shows a
  // number with a plain sentence, and "—" would make an owner wonder if it is
  // broken.
  return {
    messages,
    answeredShare,
    topQuestions,
    todayCostMicros: todayUsage?.costMicros ?? 0,
    todayCostUnknown: todayUsage?.costUnknown ?? false,
    dailyCostCapMicros,
    configError,
  };
}
