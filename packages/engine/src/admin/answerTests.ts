import {
  isPlainObject,
  MAX_TESTS_PER_ASSISTANT,
  MAX_TESTS_PER_RUN,
  newId,
  parseTestInput,
  type TestExpectation,
} from "@solvchat/core";
import { answerMessage } from "../chat/answer.js";
import type { Tenant } from "../db/tenant.js";
import type { TestRow, TestRunRow, TestWithLatestResult } from "../db/tests.js";
import type { ModelInfo } from "../models.js";
import type { Embedder, Retriever } from "../providers/retrieval.js";
import type { LlmProvider } from "../providers/types.js";
import type { Limits, UsageSink } from "../seams/types.js";
import { BadRequest, NotFound } from "./errors.js";

/** A run's whole budget. One click must not be able to spend without limit. */
export const TEST_RUN_WALL_TIME_MS = 60_000;

const EXCERPT_LENGTH = 300;

export type TestOutcome = "passed" | "failed" | "not_run";

export interface TestResult {
  testId: string;
  question: string;
  expectation: TestExpectation;
  outcome: TestOutcome;
  /** One plain sentence: what was expected and what happened. */
  reason: string;
  /**
   * The answer's opening, so the owner can see what it said. Not the whole
   * answer: a run holds many, and this is a log, not a transcript.
   */
  excerpt: string;
}

function notRun(test: TestRow, reason: string): TestResult {
  return {
    testId: test.id,
    question: test.question,
    expectation: test.expectation as TestExpectation,
    outcome: "not_run",
    reason,
    excerpt: "",
  };
}

/**
 * Judges one answer. Deliberately mechanical: every check is an equality or a
 * substring on text the pipeline produced, so a failure tells the owner
 * something they can act on rather than a model's opinion of a model.
 */
function evaluate(
  expectation: TestExpectation,
  answer: { text: string; citations: Array<{ url: string }>; usedFallback: boolean },
  fallbackText: string,
): { passed: boolean; reason: string } {
  switch (expectation.kind) {
    case "cites": {
      // Whole-URL comparison. A substring match would pass a test about
      // /pricing when the answer cited /pricing-archive.
      const found = answer.citations.some((citation) => citation.url === expectation.url);
      return {
        passed: found,
        reason: found
          ? `Cited ${expectation.url}.`
          : `Did not cite ${expectation.url}. Cited: ${
              answer.citations.map((citation) => citation.url).join(", ") || "nothing"
            }.`,
      };
    }
    case "contains": {
      const found = answer.text.toLowerCase().includes(expectation.phrase.toLowerCase());
      return {
        passed: found,
        reason: found ? `Said "${expectation.phrase}".` : `Did not say "${expectation.phrase}".`,
      };
    }
    case "notContains": {
      const found = answer.text.toLowerCase().includes(expectation.phrase.toLowerCase());
      return {
        passed: !found,
        reason: found
          ? `Said "${expectation.phrase}", which it should not.`
          : `Did not say "${expectation.phrase}".`,
      };
    }
    case "declines":
      // Equality against the version's own fallback, not a guess at phrasing:
      // that exact string is what the pipeline emits when nothing clears the
      // score floor.
      return {
        passed: answer.usedFallback || answer.text.trim() === fallbackText.trim(),
        reason: answer.usedFallback
          ? "Said it did not know, as expected."
          : "Answered instead of saying it did not know.",
      };
  }
}

export interface RunDeps {
  tenant: Tenant;
  orgId: string;
  embedder: Embedder;
  retriever: Retriever;
  provider: LlmProvider;
  model?: ModelInfo | undefined;
  usage: UsageSink;
  limits: Limits;
  now?: (() => number) | undefined;
}

/** Lists all tests for an assistant with each test's newest run result. */
export async function listTests(
  tenant: Tenant,
  assistantId: string,
): Promise<TestWithLatestResult[]> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  return tenant.tests.listWithLatestResult(assistantId);
}

/** Creates a test for an assistant, enforcing the per-assistant cap. */
export async function createTest(
  tenant: Tenant,
  assistantId: string,
  body: unknown,
): Promise<TestRow> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  const parsed = parseTestInput(body);
  if (!parsed.ok) throw new BadRequest(parsed.errors);
  // Checked here rather than by a database constraint: the owner gets a plain
  // sentence naming the limit instead of a 409 from an index.
  if ((await tenant.tests.countFor(assistantId)) >= MAX_TESTS_PER_ASSISTANT) {
    throw new BadRequest([`tests: an assistant can have at most ${MAX_TESTS_PER_ASSISTANT} tests`]);
  }
  return tenant.tests.create({
    id: newId("tst"),
    assistantId,
    question: parsed.value.question,
    expectation: parsed.value.expectation as unknown as Record<string, unknown>,
    createdAt: Date.now(),
  });
}

/** Updates an existing test's question and/or expectation. */
export async function updateTest(tenant: Tenant, testId: string, body: unknown): Promise<TestRow> {
  const existing = await tenant.tests.get(testId);
  if (existing === null) throw new NotFound("test");
  if (!isPlainObject(body)) {
    throw new BadRequest(["body: must be a JSON object"]);
  }
  const parsed = parseTestInput({
    question: body.question ?? existing.question,
    expectation: body.expectation ?? existing.expectation,
  });
  if (!parsed.ok) throw new BadRequest(parsed.errors);

  const expectation = parsed.value.expectation as unknown as Record<string, unknown>;
  await tenant.tests.updateTest(testId, {
    question: parsed.value.question,
    expectation,
  });
  return {
    ...existing,
    question: parsed.value.question,
    expectation,
  };
}

/** Deletes a test by id. */
export async function deleteTest(tenant: Tenant, testId: string): Promise<{ deleted: true }> {
  const deleted = await tenant.tests.remove(testId);
  if (!deleted) throw new NotFound("test");
  return { deleted: true };
}

/** Lists recent test runs for an assistant, newest first. */
export async function listTestRuns(tenant: Tenant, assistantId: string): Promise<TestRunRow[]> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  return tenant.tests.listRunsForAssistant(assistantId);
}

/**
 * Runs an assistant's tests against its draft and records the run.
 *
 * Sequential on purpose. Twenty-five tests in parallel would be twenty-five
 * embeddings and twenty-five model calls in one invocation — past the Workers
 * Free subrequest limit — and every spend-cap check would read the same
 * pre-run total, which would make the cap decorative.
 */
export async function runAnswerTests(
  deps: RunDeps,
  assistantId: string,
): Promise<{ runId: string; passed: boolean; results: TestResult[]; stopped?: string }> {
  const draft = await deps.tenant.versions.draft(assistantId);
  if (draft === null) throw new NotFound("assistant");
  const tests = (await deps.tenant.tests.list(assistantId)).slice(0, MAX_TESTS_PER_RUN);
  const clock = deps.now ?? Date.now;
  const startedAt = clock();

  const results: TestResult[] = [];
  let stopped: string | undefined;

  for (const test of tests) {
    if (stopped !== undefined || clock() - startedAt > TEST_RUN_WALL_TIME_MS) {
      stopped ??= "The run took too long and stopped early.";
      // Not run, not failed: a test that never ran says nothing about the
      // draft, and calling it a failure sends the owner hunting a bug that is
      // not there.
      results.push(notRun(test, stopped));
      continue;
    }

    // The same check a visitor's question passes. A run is spend like any
    // other, and the owner's cap is the owner's cap.
    const decision = await deps.limits.check(deps.orgId, assistantId, {
      kind: "chat",
      ip: "",
    });
    if (!decision.ok) {
      stopped =
        decision.reason === "spend_cap"
          ? "This assistant reached its spending limit for today, so the run stopped."
          : "Too many requests just now, so the run stopped.";
      results.push(notRun(test, stopped));
      continue;
    }

    const answer = { text: "", citations: [] as Array<{ url: string }>, usedFallback: false };
    let errored = false;
    for await (const event of answerMessage(
      {
        tenant: deps.tenant,
        embedder: deps.embedder,
        retriever: deps.retriever,
        provider: deps.provider,
        model: deps.model,
        usage: deps.usage,
      },
      {
        orgId: deps.orgId,
        assistantId,
        visitorId: "answer-test",
        message: test.question,
        behaviour: draft.config.behaviour,
        // The specification's two conditions, both satisfied by the pane's own
        // mode: nothing is stored, and usage is metered.
        preview: true,
      },
    )) {
      if (event.type === "token") answer.text += event.text;
      else if (event.type === "citation") answer.citations.push({ url: event.url });
      else if (event.type === "error") {
        // A provider failure is not a test failure; the draft was not judged.
        results.push(notRun(test, "The assistant could not answer, so this test did not run."));
        errored = true;
        break;
      }
    }
    if (errored) continue;
    answer.usedFallback = answer.text.trim() === draft.config.behaviour.fallbackText.trim();

    const expectation = test.expectation as TestExpectation;
    const verdict = evaluate(expectation, answer, draft.config.behaviour.fallbackText);
    results.push({
      testId: test.id,
      question: test.question,
      expectation,
      outcome: verdict.passed ? "passed" : "failed",
      reason: verdict.reason,
      excerpt: answer.text.slice(0, EXCERPT_LENGTH),
    });
  }

  // Passed means every test ran and every test passed: a run that stopped
  // early has not shown the draft is good.
  const passed = results.length > 0 && results.every((result) => result.outcome === "passed");
  const runId = newId("run");
  await deps.tenant.tests.createRun({
    id: runId,
    versionId: draft.id,
    startedAt,
    results,
    passed,
  });
  return { runId, passed, results, ...(stopped ? { stopped } : {}) };
}
