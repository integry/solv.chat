import {
  isPlainObject,
  MAX_TESTS_PER_RUN,
  newId,
  parseTestInput,
  type TestExpectation,
} from "@solvchat/core";
import { answerMessage, listsSources } from "../chat/answer.js";
import { mcpRunnerFor } from "../chat/mcpRunner.js";
import type { ToolRunner } from "../chat/toolLoop.js";
import { type KeySource, modelKeySource } from "../chat/trace.js";
import type { Tenant } from "../db/tenant.js";
import type { TestRow, TestRunRow, TestWithLatestResult } from "../db/tests.js";
import type { VersionRow } from "../db/versions.js";
import type { ModelInfo } from "../models.js";
import type { Embedder, Retriever } from "../providers/retrieval.js";
import type { LlmProvider } from "../providers/types.js";
import type { KeyProvider, Limits, UsageSink } from "../seams/types.js";
import { BadRequest, NotFound } from "./errors.js";
import { configRevision } from "./versions.js";

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
  /**
   * The answer's trace in `preview_traces` ("How this answer was made"),
   * when the test ran and its trace was written. Absent on older runs and on
   * a test that did not run.
   */
  traceId?: string;
}

const WALL_TIME_MESSAGE = "The run took too long and stopped early.";
const INFRA_ERROR_MESSAGE = "The assistant could not answer, so this test did not run.";

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (signal.aborted) {
    onAbort?.();
    promise.catch(() => {});
    throw abortError();
  }
  promise.catch(() => {});
  let handleAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    handleAbort = () => {
      onAbort?.();
      reject(abortError());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (handleAbort) {
      signal.removeEventListener("abort", handleAbort);
    }
  }
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
  answer: {
    text: string;
    citations: Array<{ url: string }>;
    citationsShown: boolean;
    /** The pages the answer was given, whether or not the visitor saw them. */
    used: string[];
    /** The complete addresses its text links to, fragment kept, in every source mode. */
    linked: string[];
    usedFallback: boolean;
  },
  fallbackText: string,
): { passed: boolean; reason: string } {
  switch (expectation.kind) {
    case "cites": {
      // Whole-URL comparison. A substring match would pass a test about
      // /pricing when the answer cited /pricing-archive.
      // A link in the text to the page passes in every mode, and says so.
      if (answer.linked.includes(expectation.url)) {
        return { passed: true, reason: `Linked to ${expectation.url}.` };
      }
      if (answer.citationsShown) {
        const found = answer.citations.some((citation) => citation.url === expectation.url);
        const listed = answer.citations.map((citation) => citation.url).join(", ") || "nothing";
        return {
          passed: found,
          reason: found
            ? `Cited ${expectation.url}.`
            : `Did not cite ${expectation.url}. Cited: ${listed}.`,
        };
      }
      // With no list the visitor sees no citations, so the check is on the
      // pages the answer used, and says so.
      const used = answer.used.includes(expectation.url);
      const usedList = answer.used.join(", ") || "nothing";
      return {
        passed: used,
        reason: used
          ? `Used ${expectation.url}.`
          : `Did not use ${expectation.url}. Used: ${usedList}.`,
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
  /** The retrieval score floor; absent, the default. */
  scoreFloor?: number | undefined;
  secretKey?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  runners?: readonly ToolRunner[] | undefined;
  now?: (() => number) | undefined;
  /**
   * The key seam's flags, for the trace's key source. Absent, the source is
   * read as stored or environment only.
   */
  keys?: Pick<KeyProvider, "managed" | "ownKeysAllowed"> | undefined;
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
  // Enforced atomically with insertion so concurrent requests cannot exceed
  // the per-assistant cap; the owner gets a plain sentence naming the limit.
  const created = await tenant.tests.createIfUnderLimit(
    {
      id: newId("tst"),
      assistantId,
      question: parsed.value.question,
      expectation: parsed.value.expectation as unknown as Record<string, unknown>,
      createdAt: Date.now(),
    },
    MAX_TESTS_PER_RUN,
  );
  if (created === null) {
    throw new BadRequest([`tests: an assistant can have at most ${MAX_TESTS_PER_RUN} tests`]);
  }
  return created;
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

/**
 * Replaces an assistant's entire test set with the declared list.
 *
 * Validation runs before any delete so an invalid payload leaves the existing
 * tests untouched.
 */
export async function replaceTests(
  tenant: Tenant,
  assistantId: string,
  body: unknown,
): Promise<{ created: number; removed: number; tests: TestRow[] }> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  if (!isPlainObject(body)) {
    throw new BadRequest(["body: must be a JSON object"]);
  }
  if (!Array.isArray(body.tests)) {
    throw new BadRequest(["tests: must be an array"]);
  }
  if (body.tests.length > MAX_TESTS_PER_RUN) {
    throw new BadRequest([`tests: an assistant can have at most ${MAX_TESTS_PER_RUN} tests`]);
  }

  const parsedItems: Array<{ question: string; expectation: Record<string, unknown> }> = [];
  const errors: string[] = [];
  for (let i = 0; i < body.tests.length; i++) {
    const parsed = parseTestInput(body.tests[i]);
    if (!parsed.ok) {
      for (const error of parsed.errors) {
        errors.push(`tests[${i}].${error}`);
      }
      continue;
    }
    parsedItems.push({
      question: parsed.value.question,
      expectation: parsed.value.expectation as unknown as Record<string, unknown>,
    });
  }
  if (errors.length > 0) {
    throw new BadRequest(errors);
  }

  const baseNow = Date.now();
  return tenant.tests.replaceAll(
    assistantId,
    parsedItems.map((item, index) => ({
      id: newId("tst"),
      question: item.question,
      expectation: item.expectation,
      createdAt: baseNow + index,
    })),
  );
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
): Promise<{
  runId: string;
  draft: VersionRow;
  passed: boolean;
  results: TestResult[];
  stopped?: string;
}> {
  const draft = await deps.tenant.versions.draft(assistantId);
  if (draft === null) throw new NotFound("assistant");
  const configHash = await configRevision(draft);
  const mcp = await mcpRunnerFor(
    {
      tenant: deps.tenant,
      secretKey: deps.secretKey ?? "",
      fetchImpl: deps.fetchImpl,
    },
    assistantId,
    draft.config.allowedTools,
  );
  const runners: ToolRunner[] = [...(deps.runners ?? [])];
  if (mcp) runners.push(mcp);

  const tests = await deps.tenant.tests.list(assistantId);
  const clock = deps.now ?? Date.now;
  const startedAt = clock();

  const results: TestResult[] = [];
  let stopped: string | undefined;
  // Made up front so each test's trace can name the run it belongs to; the
  // run's row is written once every test has answered.
  const runId = newId("run");
  const keys = deps.keys ?? {};
  // Read once per run, after the first answer that asked a model: every test
  // uses the same provider and key.
  let keySource: Promise<KeySource> | undefined;
  const runKeySource = () => {
    keySource ??= modelKeySource(deps.tenant.providerSettings, keys, deps.provider.name);
    return keySource;
  };

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    if (!test) continue;

    if (stopped !== undefined) {
      // Not run, not failed: a test that never ran says nothing about the
      // draft, and calling it a failure sends the owner hunting a bug that is
      // not there.
      results.push(notRun(test, stopped));
      continue;
    }

    if (i >= MAX_TESTS_PER_RUN) {
      stopped = `A run executes at most ${MAX_TESTS_PER_RUN} tests, so the remaining tests did not run.`;
      results.push(notRun(test, stopped));
      continue;
    }

    const elapsedBefore = clock() - startedAt;
    if (elapsedBefore >= TEST_RUN_WALL_TIME_MS) {
      stopped = WALL_TIME_MESSAGE;
      results.push(notRun(test, stopped));
      continue;
    }

    const controller = new AbortController();
    const remainingMs = Math.max(0, TEST_RUN_WALL_TIME_MS - elapsedBefore);
    const timer = setTimeout(() => controller.abort(), remainingMs);

    const answer = {
      text: "",
      citations: [] as Array<{ url: string }>,
      citationsShown: listsSources(draft.config.behaviour),
      used: [] as string[],
      linked: [] as string[],
      usedFallback: false,
      traceId: undefined as string | undefined,
    };
    let errored = false;
    let timedOut = false;

    try {
      // The same check a visitor's question passes. A run is spend like any
      // other, and the owner's cap is the owner's cap.
      const decision = await raceWithAbort(
        deps.limits.check(deps.orgId, assistantId, {
          kind: "chat",
          ip: "",
        }),
        controller.signal,
      );
      if (!decision.ok) {
        stopped =
          decision.reason === "spend_cap"
            ? "This assistant reached its spending limit for today, so the run stopped."
            : "Too many requests just now, so the run stopped.";
        results.push(notRun(test, stopped));
        continue;
      }

      const iterable = answerMessage(
        {
          tenant: deps.tenant,
          embedder: deps.embedder,
          retriever: deps.retriever,
          provider: deps.provider,
          model: deps.model,
          usage: deps.usage,
          scoreFloor: deps.scoreFloor,
          runners,
          signal: controller.signal,
          // With no list no citation event is sent; the pages the answer
          // linked to and used still decide a "cites" test.
          onCitable: (citations: readonly { url: string }[], linked: readonly string[]) => {
            for (const c of citations) answer.used.push(c.url);
            answer.linked.push(...linked);
          },
          // Kept apart from visitor replies, marked as a test run of this run.
          trace: {
            version: { id: draft.id, state: "draft" },
            keySource: runKeySource,
            preview: { source: "test_run", runId, testId: test.id },
          },
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
      );
      const iterator = iterable[Symbol.asyncIterator]();
      for (;;) {
        const step = await raceWithAbort(iterator.next(), controller.signal, () => {
          void iterator.return?.().catch(() => {});
        });
        if (step.done) break;
        const event = step.value;
        if (event.type === "token") answer.text += event.text;
        else if (event.type === "citation") answer.citations.push({ url: event.url });
        else if (event.type === "done") answer.traceId = event.messageId;
        else if (event.type === "error") {
          // A provider failure is not a test failure; the draft was not judged.
          results.push(notRun(test, INFRA_ERROR_MESSAGE));
          errored = true;
          break;
        }
      }
    } catch {
      if (controller.signal.aborted) {
        timedOut = true;
      } else {
        results.push(notRun(test, INFRA_ERROR_MESSAGE));
        errored = true;
      }
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) {
      stopped = WALL_TIME_MESSAGE;
      results.push(notRun(test, stopped));
      continue;
    }
    if (errored) {
      if (controller.signal.aborted) {
        stopped = WALL_TIME_MESSAGE;
      }
      continue;
    }
    if (controller.signal.aborted || clock() - startedAt >= TEST_RUN_WALL_TIME_MS) {
      stopped = WALL_TIME_MESSAGE;
      results.push(notRun(test, stopped));
      continue;
    }

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
      ...(answer.traceId === undefined ? {} : { traceId: answer.traceId }),
    });
  }

  // Passed means every test ran and every test passed: a run that stopped
  // early has not shown the draft is good.
  const passed = results.length > 0 && results.every((result) => result.outcome === "passed");
  await deps.tenant.tests.createRun({
    id: runId,
    versionId: draft.id,
    startedAt,
    results,
    passed,
    configHash,
  });
  return { runId, draft, passed, results, ...(stopped ? { stopped } : {}) };
}
