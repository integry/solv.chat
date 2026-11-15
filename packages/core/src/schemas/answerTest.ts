import { Errors, fail, ok, type Result } from "../result.js";
import { isPlainObject, parseUrl, readTrimmedString } from "./shared.js";

/** Chosen here; the specification names caps but no numbers. */
export const MAX_TESTS_PER_RUN = 25;
export const MAX_TEST_QUESTION_LENGTH = 500;
export const MAX_TEST_PHRASE_LENGTH = 200;

/**
 * Exactly one expectation per test, which is the specification's wording. One
 * question with three conditions would make a failure ambiguous to read, and
 * an owner can write three tests.
 */
export type TestExpectation =
  | { kind: "cites"; url: string }
  | { kind: "contains"; phrase: string }
  | { kind: "notContains"; phrase: string }
  | { kind: "declines" };

export interface TestInput {
  question: string;
  expectation: TestExpectation;
}

/** Validates a test creation or update payload with field-prefixed errors. */
export function parseTestInput(value: unknown): Result<TestInput> {
  if (!isPlainObject(value)) return fail("body: must be a JSON object");
  const errors = new Errors();

  const question = readTrimmedString(value.question, 1, MAX_TEST_QUESTION_LENGTH);
  if (question === null) {
    errors.add("question", `must be 1 to ${MAX_TEST_QUESTION_LENGTH} characters`);
  }

  const raw = value.expectation;
  let expectation: TestExpectation | null = null;
  if (!isPlainObject(raw)) {
    errors.add("expectation", "must be an object");
  } else {
    switch (raw.kind) {
      case "cites": {
        // A whole URL, normalised: comparing substrings would let a citation
        // to another page on the same host pass a test about one page.
        const url = parseUrl(raw.url, ["https:", "http:"]);
        if (url === null) errors.add("expectation.url", "must be an absolute http or https URL");
        else expectation = { kind: "cites", url: url.href };
        break;
      }
      case "contains":
      case "notContains": {
        const phrase = readTrimmedString(raw.phrase, 1, MAX_TEST_PHRASE_LENGTH);
        if (phrase === null) {
          errors.add("expectation.phrase", `must be 1 to ${MAX_TEST_PHRASE_LENGTH} characters`);
        } else {
          expectation = { kind: raw.kind, phrase };
        }
        break;
      }
      case "declines":
        expectation = { kind: "declines" };
        break;
      default:
        errors.add("expectation.kind", 'must be "cites", "contains", "notContains" or "declines"');
    }
  }

  if (errors.failed || question === null || expectation === null) return fail(...errors.list);
  // Built from known fields, like every other parser here: returning the
  // caller's object would let extra keys reach the stored JSON.
  return ok({ question, expectation });
}
