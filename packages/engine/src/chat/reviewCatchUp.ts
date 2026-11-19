import { reviewCatchUpCandidates } from "../db/messages.js";
import { forScheduledReview, type Tenant } from "../db/tenant.js";
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
 * How long after a reply was completed the catch-up waits before taking it:
 * after it was written, or, for one that paused for page actions, after the
 * continuation that completed it (`resumed_at`), which is when its live
 * review starts. Ours: the live review (two attempts of 10 seconds and a few
 * reads) is long finished by then, so the two never review one reply at the
 * same time.
 */
export const REVIEW_CATCH_UP_MIN_AGE_MS = 5 * 60 * 1000;
/** Rows read per page: some may belong to an org the auth seam refuses. */
const CANDIDATES_PER_PAGE = 50;
/**
 * Pages read per tick at most. Each later page leaves out every org refused
 * so far and starts past the last row read, so a refused org's backlog,
 * however long, costs at most one page and never hides other orgs' replies.
 */
export const REVIEW_CATCH_UP_MAX_PAGES = 5;

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
  const limit = Math.max(max, CANDIDATES_PER_PAGE);
  const vouched = new Map<string, string | null>();
  let after: { createdAt: number; messageId: string } | undefined;
  for (let page = 0; page < REVIEW_CATCH_UP_MAX_PAGES && result.taken < max; page++) {
    const refused = [...vouched].filter(([, orgId]) => orgId === null).map(([claimed]) => claimed);
    const candidates = await reviewCatchUpCandidates(deps.db, {
      from: now - REVIEW_CATCH_UP_WINDOW_MS,
      to: now - REVIEW_CATCH_UP_MIN_AGE_MS,
      limit,
      excludeOrgIds: refused,
      after,
    });
    for (const candidate of candidates) {
      if (result.taken >= max) break;
      after = { createdAt: candidate.createdAt, messageId: candidate.messageId };
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
        // Only the claim itself throws here (nothing was written, so a later
        // tick may take the reply). One reply's fault never stops the others.
        console.warn("chat: review catch-up failed", {
          error: err instanceof Error ? err.name : typeof err,
        });
      }
    }
    if (candidates.length < limit) break;
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
  // retries this reply. The claim keeps its time, so a run cut off before it
  // records anything still leaves an answer that says why once the claim
  // expires (`reviewFailureOf`), with no help from the run itself.
  const claimedAt = clock();
  if (!(await tenant.traces.claimReviewCatchUp(messageId, claimedAt))) return null;
  try {
    const result = await reviewClaimed(deps, tenant, orgId, messageId, clock);
    // A failure has replaced the claim with its reason (or, if that write
    // failed, the open claim will say `review_error`). Otherwise the run
    // finished: close the claim, so an answer left without an outcome on
    // purpose ("Review answers" off) is not reported as cut off.
    if (result.status !== "failed") await release(tenant, messageId, claimedAt, clock);
    return result;
  } catch (err) {
    // A read failed after the claim (`runAnswerReview` itself never throws).
    // The claim keeps the reply from every later tick, so say why here, or
    // it would stay unreviewed with nothing in its trace.
    console.warn("chat: review catch-up failed", {
      error: err instanceof Error ? err.name : typeof err,
    });
    try {
      await tenant.traces.recordReview(
        messageId,
        { catchUp: true, failed: "review_error" },
        clock(),
      );
    } catch (recordErr) {
      console.error("chat: review failure not recorded", {
        error: recordErr instanceof Error ? recordErr.name : typeof recordErr,
      });
    }
    return { status: "failed", failure: "review_error" };
  }
}

/** Closes this run's claim. Never throws: the review's result stands either way. */
async function release(
  tenant: Tenant,
  messageId: string,
  claimedAt: number,
  clock: () => number,
): Promise<void> {
  try {
    await tenant.traces.releaseReviewCatchUp(messageId, claimedAt, clock());
  } catch (err) {
    console.error("chat: review catch-up claim not closed", {
      error: err instanceof Error ? err.name : typeof err,
    });
  }
}

/** Reviews a reply this run has claimed. */
async function reviewClaimed(
  deps: ReviewCatchUpDeps,
  tenant: Tenant,
  orgId: string,
  messageId: string,
  clock: () => number,
): Promise<ReviewRunResult> {
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
