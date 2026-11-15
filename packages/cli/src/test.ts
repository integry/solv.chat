import { readFile } from "node:fs/promises";
import {
  isPlainObject,
  MAX_TESTS_PER_ASSISTANT,
  parseTestInput,
  type TestInput,
} from "@solvchat/core";
import { assertValidHeaderValue, CliError, normalizeEndpoint, requestJson } from "./http.js";
import type { CliDeps } from "./push.js";

export interface TestOptions {
  file?: string;
  endpoint: string;
  assistant: string;
  ingestKey?: string;
  dryRun?: boolean;
}

interface RunResult {
  testId: string;
  question: string;
  outcome: "passed" | "failed" | "not_run";
  reason: string;
}

interface RunResponse {
  passed: boolean;
  results: RunResult[];
  stopped?: string | null;
}

/**
 * Validates a `tests` declaration from `solv.config.json` against
 * `@solvchat/core`'s test schema and per-assistant cap.
 */
export function parseDeclaredTests(
  rawTests: unknown,
  file: string,
  log?: (line: string) => void,
): TestInput[] {
  if (!Array.isArray(rawTests)) {
    throw new CliError(`${file}: tests must be an array`);
  }
  if (rawTests.length > MAX_TESTS_PER_ASSISTANT) {
    const message = `tests: an assistant can have at most ${MAX_TESTS_PER_ASSISTANT} tests`;
    log?.(message);
    throw new CliError(message);
  }

  const items: TestInput[] = [];
  const errors: string[] = [];
  for (let i = 0; i < rawTests.length; i++) {
    const parsed = parseTestInput(rawTests[i]);
    if (!parsed.ok) {
      for (const error of parsed.errors) {
        errors.push(`tests[${i}].${error}`);
      }
      continue;
    }
    items.push(parsed.value);
  }
  if (errors.length > 0) {
    for (const error of errors) {
      log?.(error);
    }
    throw new CliError(errors.join("; "));
  }
  return items;
}

/**
 * Reads and validates a `tests` array from `solv.config.json`.
 */
async function readDeclaredTests(file: string, log?: (line: string) => void): Promise<TestInput[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new CliError(`Invalid JSON in ${file}`);
  }
  if (!isPlainObject(parsed) || parsed.tests === undefined) {
    throw new CliError(`${file} declares no tests`);
  }
  return parseDeclaredTests(parsed.tests, file, log);
}

/**
 * Runs the assistant's answer tests and exits non-zero if any did not pass.
 *
 * All judgement lives on the server so CI and the admin's "Run now" always
 * agree on whether the draft passes.
 */
export async function test(options: TestOptions, deps: CliDeps): Promise<void> {
  const declared =
    options.file === undefined ? null : await readDeclaredTests(options.file, deps.log);

  if (options.dryRun) {
    if (declared === null) {
      deps.log("Would run the tests stored on this assistant.");
    } else {
      deps.log(`Would replace the assistant's tests with ${declared.length} from ${options.file}:`);
      for (const item of declared) {
        deps.log(`  ${item.question}`);
      }
      deps.log("Any test not in this file would be removed.");
    }
    return;
  }

  if (!options.ingestKey) {
    throw new CliError("Missing SOLV_INGEST_KEY environment variable");
  }
  const endpoint = normalizeEndpoint(options.endpoint);
  const authHeader = `Bearer ${options.ingestKey}`;
  assertValidHeaderValue("Authorization", authHeader, "SOLV_INGEST_KEY");
  const headers = { Authorization: authHeader, "Content-Type": "application/json" };
  const base = `${endpoint}/v1/ingest/${encodeURIComponent(options.assistant)}`;

  if (declared !== null) {
    deps.log(
      `Replacing the assistant's tests with ${declared.length} from ${options.file} (any test not in this file will be removed).`,
    );
    const synced = await requestJson<{ created: number; removed: number }>(
      deps.fetchImpl,
      `${base}/tests`,
      { method: "PUT", headers, body: JSON.stringify({ tests: declared }) },
      "SOLV_INGEST_KEY",
    );
    deps.log(`Applied ${synced.created} tests from ${options.file} (${synced.removed} removed).`);
  }

  const run = await requestJson<RunResponse>(
    deps.fetchImpl,
    `${base}/test-runs`,
    { method: "POST", headers, body: "{}" },
    "SOLV_INGEST_KEY",
  );

  let failed = 0;
  let notRun = 0;
  for (const result of run.results) {
    if (result.outcome === "passed") {
      deps.log(`PASS  ${result.question} — ${result.reason}`);
    } else if (result.outcome === "failed") {
      failed++;
      deps.log(`FAIL  ${result.question}`);
      deps.log(`      ${result.reason}`);
    } else {
      notRun++;
      // Distinct from FAIL: "did not run" is not evidence about the draft.
      deps.log(`SKIP  ${result.question}`);
      deps.log(`      ${result.reason}`);
    }
  }
  if (run.stopped) {
    deps.log(run.stopped);
  }
  deps.log(`${run.results.length - failed - notRun} passed, ${failed} failed, ${notRun} not run.`);

  if (run.results.length === 0) {
    deps.log("No tests to run.");
    if (!run.passed) {
      throw new CliError("No tests to run");
    }
    return;
  }
  if (failed > 0 || notRun > 0) {
    throw new CliError(failed > 0 ? `${failed} test(s) failed` : `${notRun} test(s) did not run`);
  }
  if (!run.passed) {
    throw new CliError("Test run did not pass");
  }
}
