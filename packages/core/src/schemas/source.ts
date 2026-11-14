import { Errors, fail, ok, type Result } from "../result.js";
import { MAX_DOCUMENT_MARKDOWN_BYTES } from "./document.js";
import { isPlainObject, parseUrl, readTrimmedString } from "./shared.js";

export type SourceKind = "push" | "sitemap" | "entry";

export type SourceInput =
  | { kind: "push"; label: string; settings: Record<string, never> }
  | { kind: "entry"; label: string; settings: Record<string, never> }
  | { kind: "sitemap"; label: string; settings: { url: string } };

export interface EntryInput {
  question: string;
  answer: string;
}

const textEncoder = new TextEncoder();

/** Validates a hand-written entry (question and answer). */
export function parseEntryInput(value: unknown): Result<EntryInput> {
  if (!isPlainObject(value)) return fail("body: must be a JSON object");

  const errors = new Errors();
  const question = readTrimmedString(value.question, 1, 300);
  if (question === null) errors.add("question", "must be 1 to 300 characters");

  const answer = readTrimmedString(value.answer, 1, MAX_DOCUMENT_MARKDOWN_BYTES);
  if (answer === null) {
    errors.add("answer", "must not be empty");
  } else if (textEncoder.encode(answer).byteLength > MAX_DOCUMENT_MARKDOWN_BYTES) {
    errors.add("answer", `must be at most ${MAX_DOCUMENT_MARKDOWN_BYTES} bytes`);
  }

  if (errors.failed || question === null || answer === null) return fail(...errors.list);
  return ok({ question, answer });
}

/** Validates source creation/update input, shaping `settings` by `kind`. */
export function parseSourceInput(value: unknown): Result<SourceInput> {
  if (!isPlainObject(value)) return fail("body: must be a JSON object");

  const errors = new Errors();
  const kind = value.kind;
  if (kind !== "push" && kind !== "sitemap" && kind !== "entry") {
    errors.add("kind", 'must be "push", "sitemap", or "entry"');
  }

  const label = readTrimmedString(value.label, 1, 80);
  if (label === null) errors.add("label", "must be 1 to 80 characters");

  if (kind === "sitemap") {
    if (!isPlainObject(value.settings)) {
      errors.add("settings", "must be an object");
      return fail(...errors.list);
    }
    const url = parseUrl(value.settings.url, ["https:"]);
    if (url === null) errors.add("settings.url", "must be an https URL");
    if (errors.failed || label === null || url === null) return fail(...errors.list);
    return ok({ kind: "sitemap", label, settings: { url: url.href } });
  }

  if (value.settings !== undefined && !isPlainObject(value.settings)) {
    errors.add("settings", "must be an object");
  }

  if (errors.failed || label === null || (kind !== "push" && kind !== "entry")) {
    return fail(...errors.list);
  }

  return ok({ kind, label, settings: {} });
}
