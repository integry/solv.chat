import { defaultVersionConfig } from "@solvchat/core";
import type { TopQuestionRow } from "../db/messages.js";
import type { NotIndexedSource } from "../db/sources.js";
import type { Tenant } from "../db/tenant.js";
import type { EffectiveProviderSettings } from "../providers/config.js";
import { DAY_MS, utcDay } from "../util/time.js";
import { NotFound } from "./errors.js";
import { type PeriodFigures, periodFigures, rangeFor } from "./reports.js";

/** The Overview's stated period: the last 7 days, against the 7 before. */
export const OVERVIEW_DAYS = 7;
/**
 * A document still not indexed this long after it was written, with no failure
 * recorded, is reported as waiting. A recorded failure is reported at once.
 */
export const NOT_INDEXED_AFTER_MS = 15 * 60_000;

export interface OverviewPeriod extends PeriodFigures {
  days: typeof OVERVIEW_DAYS;
  previous: PeriodFigures;
}

/** The getting-started checklist, each step read from stored state. */
export interface OverviewSetup {
  hasContent: boolean;
  tried: boolean;
  published: boolean;
  installed: boolean;
  visitorQuestion: boolean;
}

/** Things the owner should act on. Every list or count is empty or zero when there is nothing. */
export interface OverviewAttention {
  /** Unanswered question groups with no written answer and not dismissed. */
  openGaps: number;
  /** Failed tests in the latest test run. */
  failingTests: number;
  /**
   * Sources with documents that did not get indexed: `failed` ones as soon as
   * indexing records the failure, `waiting` ones once they are overdue.
   */
  notIndexed: NotIndexedSource[];
}

export interface AssistantOverview {
  topQuestions: TopQuestionRow[];
  todayCostMicros: number;
  todayCostUnknown: boolean;
  dailyCostCapMicros: number;
  costUnit?: "usd" | "credits" | undefined;
  configError: string | null;
  period: OverviewPeriod;
  /** Questions per UTC day over `period`, oldest first, one entry per day. */
  daily: Array<{ day: string; questions: number }>;
  setup: OverviewSetup;
  attention: OverviewAttention;
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
    /** The clock for the period figures; defaults to now. */
    at?: number | undefined;
    costUnit?: "usd" | "credits" | undefined;
    resolveSettings?: (() => Promise<EffectiveProviderSettings>) | undefined;
    checkConfigError?:
      | ((resolved?: EffectiveProviderSettings) => Promise<string | null>)
      | undefined;
  },
): Promise<AssistantOverview> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");

  const today = options?.today ?? utcDay(Date.now());
  const settings = options?.resolveSettings ? await options.resolveSettings() : undefined;
  const costUnit =
    settings !== undefined
      ? settings.llmProvider.value === "openrouter"
        ? "credits"
        : undefined
      : options?.costUnit;

  // One clock for both periods and the chart, so they line up at midnight.
  const at = options?.at ?? Date.now();
  const range = rangeFor(OVERVIEW_DAYS, at);
  const previousRange = rangeFor(OVERVIEW_DAYS, at - OVERVIEW_DAYS * DAY_MS);

  const [
    topQuestions,
    todayUsage,
    published,
    configError,
    current,
    previous,
    perDay,
    sources,
    milestones,
    visitorQuestion,
    latestRun,
    gaps,
    notIndexed,
  ] = await Promise.all([
    tenant.messages.topQuestionsFor(assistantId, 5),
    tenant.usage.summaryFor(assistantId, today),
    tenant.versions.published(assistantId),
    options?.checkConfigError ? options.checkConfigError(settings) : Promise.resolve(null),
    periodFigures(tenant, assistantId, range),
    periodFigures(tenant, assistantId, previousRange),
    tenant.reports.questionsPerDay(assistantId, range),
    tenant.sources.listWithStats(assistantId),
    tenant.assistants.milestones(assistantId),
    tenant.conversations.hasVisitorQuestion(assistantId),
    tenant.tests.latestRun(assistantId),
    tenant.messages.gapGroups(assistantId, { limit: 1, offset: 0, openOnly: true }),
    tenant.sources.notIndexed(assistantId, at - NOT_INDEXED_AFTER_MS),
  ]);

  const byDay = new Map(perDay.map((row) => [row.day, row.questions]));
  const daily = Array.from({ length: OVERVIEW_DAYS }, (_, i) => {
    const day = utcDay(range.fromMs + i * DAY_MS);
    return { day, questions: byDay.get(day) ?? 0 };
  });
  const failingTests = (latestRun?.results ?? []).filter(
    (result) =>
      typeof result === "object" &&
      result !== null &&
      (result as { outcome?: unknown }).outcome === "failed",
  ).length;

  const dailyCostCapMicros = published
    ? published.config.limits.dailyCostCapMicros
    : defaultVersionConfig().limits.dailyCostCapMicros;

  // A day with no messages reads zero rather than null: the screen shows a
  // number with a plain sentence, and "—" would make an owner wonder if it is
  // broken.
  return {
    topQuestions,
    todayCostMicros: todayUsage?.costMicros ?? 0,
    todayCostUnknown: todayUsage?.costUnknown ?? false,
    dailyCostCapMicros,
    ...(costUnit !== undefined ? { costUnit } : {}),
    configError,
    period: { days: OVERVIEW_DAYS, ...current, previous },
    daily,
    setup: {
      hasContent: sources.some((source) => source.documentCount > 0),
      // A test run goes through the same pipeline as "Try it".
      tried: (milestones?.triedAt ?? null) !== null || latestRun !== null,
      published: published !== null,
      // A visitor question can only come through the installed widget; it also
      // covers installs from before the widget's first load was recorded.
      installed: (milestones?.widgetSeenAt ?? null) !== null || visitorQuestion,
      visitorQuestion,
    },
    attention: { openGaps: gaps.total, failingTests, notIndexed },
  };
}
