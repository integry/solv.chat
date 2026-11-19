import { ANSWER_OUTCOMES, type AnswerOutcome } from "@solvchat/core";
import { describe, expect, it } from "vitest";
import {
  buildReviewRequest,
  MISS_OUTCOMES,
  REVIEW_FRAME,
  type ReviewSubject,
  runAnswerReview,
} from "../../src/chat/review.js";
import evalSet from "../fixtures/review-eval.json";

/**
 * The evaluation set's cases with scripted reviewers. These check that the
 * set is well formed and that the rules around the reviewer (the fixed frame,
 * tagged data, what a miss may be) hold for every case, whatever label comes
 * back. They cannot say whether a real model classifies well or resists the
 * injected text: `scripts/review-eval.mjs` runs the same cases against the
 * real fast-tier model for that (opt-in, needs a provider key).
 */

interface EvalCase {
  id: string;
  subject: string;
  retrievalMiss: boolean;
  question: string;
  reply: string;
  accept: AnswerOutcome[];
  injection?: boolean;
}

const subjects = evalSet.subjects as Record<string, ReviewSubject | null>;
const cases = evalSet.cases as EvalCase[];

async function storedOutcome(
  item: EvalCase,
  label: AnswerOutcome,
): Promise<{ outcome: AnswerOutcome | null; request: string }> {
  let outcome: AnswerOutcome | null = null;
  let request = "";
  const subject = subjects[item.subject] ?? null;
  await runAnswerReview(
    {
      messages: {
        async setOutcome(_id, value) {
          outcome = value;
          return true;
        },
      },
      reviewer: async () => ({
        async review(input) {
          const built = buildReviewRequest(input, "EVALTAG");
          request = JSON.stringify(built);
          expect(built.system).toBe(REVIEW_FRAME);
          return { outcome: label, confidence: null };
        },
      }),
      subject: async () => subject,
      limits: { check: async () => ({ ok: true }) },
      usage: { record: async () => {} },
    },
    {
      orgId: "org_eval",
      assistantId: "ast_eval",
      messageId: `msg_${item.id}`,
      question: item.question,
      reply: item.reply,
      retrievalMiss: item.retrievalMiss,
    },
  );
  return { outcome, request };
}

describe("chat/review: evaluation set", () => {
  it("is well formed: unique ids, known subjects, valid labels, and injections to resist", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const item of cases) {
      expect(Object.keys(subjects)).toContain(item.subject);
      expect(item.accept.length).toBeGreaterThan(0);
      for (const label of item.accept) expect(ANSWER_OUTCOMES).toContain(label);
      if (item.retrievalMiss) {
        for (const label of item.accept) expect(MISS_OUTCOMES.has(label)).toBe(true);
      }
    }
    // Every kind of decision is represented, and so are injected instructions.
    const accepted = new Set(cases.flatMap((c) => c.accept));
    expect([...accepted].sort()).toEqual([...ANSWER_OUTCOMES].sort());
    expect(cases.filter((c) => c.injection).length).toBeGreaterThanOrEqual(3);
  });

  it.each(cases.map((c) => [c.id, c] as const))(
    "%s: a reviewer giving an accepted label has it stored",
    async (_id, item) => {
      const label = item.accept[0] as AnswerOutcome;
      expect((await storedOutcome(item, label)).outcome).toBe(label);
    },
  );

  it.each(cases.map((c) => [c.id, c] as const))(
    "%s: the data stays data, and no label can make a miss more than a miss",
    async (_id, item) => {
      for (const label of ANSWER_OUTCOMES) {
        const { outcome, request } = await storedOutcome(item, label);
        // The question, reply and titles travel in the user turn only.
        const parsed = JSON.parse(request) as { system: string };
        expect(parsed.system).not.toContain(item.question);
        if (item.retrievalMiss) {
          expect(outcome !== null && MISS_OUTCOMES.has(outcome)).toBe(true);
          // With no known subject, off_topic would hide a real gap.
          if (subjects[item.subject] === null) expect(outcome).not.toBe("off_topic");
        } else {
          expect(outcome).toBe(label);
        }
      }
    },
  );
});
