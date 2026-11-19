import { reviewCatchUpCandidates } from "../db/messages.js";
import { forScheduledReview } from "../db/tenant.js";
import { type ProviderEnv, resolveProviderSettings } from "../providers/config.js";
import type { Seams } from "../seams/types.js";
import {
  REVIEW_MAX_SUBJECT_TITLES,
  type ReviewJob,
  type ReviewRunResult,
  runAnswerReview,
} from "./review.js";
import { type ChatRouteOverrides, reviewerSource } from "./route.js";

/**
 * Answer-review catch-up (see "Answer review" in docs/architecture.md). The
 * live review runs as deferred work after the answer, so if that work is cut
 * off, nothing is stored and nothing says why. The scheduled handler takes,
 * each tick, a few replies from the last day that still have no outcome and
 * no recorded failure, and reviews each one once, the same way: the same
 * spend cap, key and "Review answers" switch, the same metering.
 */

/** Replies reviewed per tick. Each review is at most two calls of `REVIEW_TIMEOUT_MS`. */
export const MAX_REVIEW_CATCH_UP_PER_TICK = 10;
/** How far back the catch-up looks. Older replies are left as they are. */
export const REVIEW_CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * How old a reply must be before the catch-up takes it. Ours: the live review
 * (two attempts of 10 seconds and a few reads) is long finished by then, so
 * the two never review one reply at the same time.
 */
export const REVIEW_CATCH_UP_MIN_AGE_MS = 5 * 60 * 1000;
/** Rows read per tick: some may belong to an org the auth seam refuses. */
const CANDIDATES_PER_TICK = 50;

export interface ReviewCatchUpDeps {
  db: D1Database;
  env: ProviderEnv;
  seams: Seams;
  overrides?: ChatRouteOverrides | undefined;
  maxAnswers?: number | undefined;
  now?: (() => number) | undefined;
}

export interface ReviewCatchUpResult {
  /** Replies taken this tick (each is never taken again). */
  taken: number;
  /** How each taken reply ended. */
  results: ReviewRunResult[];
}

/**
 * Reviews up to `maxAnswers` replies that the live review left with no outcome
 * and no recorded failure. Each is claimed in its trace first, so it is
 * attempted at most once by the catch-up, even with two ticks at once. Never
 * throws for one reply's sake.
 */
export async function runReviewCatchUp(deps: ReviewCatchUpDeps): Promise<ReviewCatchUpResult> {
  const clock = deps.now ?? Date.now;
  const now = clock();
  const max = Math.max(0, Math.trunc(deps.maxAnswers ?? MAX_REVIEW_CATCH_UP_PER_TICK));
  const result: ReviewCatchUpResult = { taken: 0, results: [] };
  if (max === 0) return result;
  const candidates = await reviewCatchUpCandidates(deps.db, {
    from: now - REVIEW_CATCH_UP_WINDOW_MS,
    to: now - REVIEW_CATCH_UP_MIN_AGE_MS,
    limit: Math.max(max, CANDIDATES_PER_TICK),
  });
  const vouched = new Map<string, string | null>();
  for (const candidate of candidates) {
    if (result.taken >= max) break;
    let orgId = vouched.get(candidate.claimedOrgId);
    if (orgId === undefined) {
      // The org was read from a row the engine wrote, and is checked again
      // with the seam, as a scheduled sync's is: a suspended org gets no review.
      orgId = await deps.seams.auth.resolveOrg({
        kind: "queued_ingest",
        orgId: candidate.claimedOrgId,
      });
      vouched.set(candidate.claimedOrgId, orgId);
    }
    if (orgId === null) continue;
    try {
      const outcome = await catchUpOne(deps, orgId, candidate.messageId, clock);
      if (outcome === null) continue;
      result.taken++;
      result.results.push(outcome);
    } catch (err) {
      // One reply's fault must not stop the others; it stays claimed.
      console.warn("chat: review catch-up failed", {
        error: err instanceof Error ? err.name : typeof err,
      });
    }
  }
  return result;
}

/** Claims and reviews one reply; null when another run claimed it first. */
async function catchUpOne(
  deps: ReviewCatchUpDeps,
  orgId: string,
  messageId: string,
  clock: () => number,
): Promise<ReviewRunResult | null> {
  const tenant = forScheduledReview(deps.db, orgId);
  // Claimed before anything is spent: a run cut off from here on never
  // retries this reply.
  if (!(await tenant.traces.claimReviewCatchUp(messageId, clock()))) return null;

  const reply = await tenant.messages.get(messageId);
  if (reply === null || reply.role !== "assistant" || reply.outcome !== null) {
    return { status: "not_reviewed" };
  }
  const [question, conversation] = await Promise.all([
    reply.replyTo === null ? null : tenant.messages.get(reply.replyTo),
    tenant.conversations.get(reply.conversationId),
  ]);
  if (question === null || question.role !== "user" || conversation === null) {
    return { status: "not_reviewed" };
  }
  const assistantId = conversation.assistantId;
  const settings = await resolveProviderSettings(deps.db, deps.env, orgId);
  const { overrides, seams } = deps;
  const providerKind = overrides?.providerKind ?? settings.llmProvider.value;
  const tier = providerKind === "openrouter" ? "fast" : (overrides?.tier ?? settings.llmTier.value);
  // The same switch as the live path: off means no call, and only a
  // retrieval miss is stored (as `declined`).
  const reviewer = settings.reviewAnswers.value
    ? reviewerSource({
        seams,
        overrides,
        orgId,
        assistantId,
        providerKind,
        tier,
        configuredModel: settings.llmModel.value ?? undefined,
      })
    : null;

  const job: ReviewJob = {
    orgId,
    assistantId,
    messageId: reply.id,
    questionId: question.id,
    question: question.content,
    reply: reply.content,
    // `answered = 0` is a retrieval miss: the reply is the fixed fallback.
    retrievalMiss: !reply.answered,
  };
  return runAnswerReview(
    {
      messages: tenant.messages,
      topics: tenant.topics,
      traces: tenant.traces,
      catchUp: true,
      subject: async (id) => {
        const [assistant, version, contentTitles] = await Promise.all([
          tenant.assistants.get(id),
          tenant.versions.published(id),
          tenant.documents.titlesForAssistant(id, REVIEW_MAX_SUBJECT_TITLES),
        ]);
        return {
          name: assistant?.name ?? "",
          title: version?.config.widget.title ?? "",
          contentTitles,
        };
      },
      reviewer,
      limits: seams.limits,
      usage: seams.usage,
      now: clock,
    },
    job,
  );
}
