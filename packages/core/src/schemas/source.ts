import { Errors, fail, ok, type Result } from "../result.js";
import { MAX_DOCUMENT_MARKDOWN_BYTES } from "./document.js";
import { isPlainObject, parseUrl, readTrimmedString } from "./shared.js";

export type SourceKind = "push" | "sitemap" | "entry";

export type SourceInput =
  | { kind: "push"; label: string; settings: Record<string, never> }
  | { kind: "entry"; label: string; settings: Record<string, never> }
  | { kind: "sitemap"; label: string; settings: SitemapSourceSettings };

/** How often a sitemap source is read again. `off` (the default) means only when the owner imports. */
export type SyncSchedule = "off" | "daily" | "weekly";

export const SYNC_SCHEDULES: readonly SyncSchedule[] = ["off", "daily", "weekly"];

/**
 * The largest share of a source's documents one scheduled sync may remove,
 * in percent, unless the owner sets another. A run that would remove more
 * removes nothing and is recorded as failed: a sitemap that suddenly lists
 * half the site is more likely broken than pruned.
 */
export const DEFAULT_SYNC_MAX_REMOVE_PERCENT = 50;

// A type, not an interface, so it stays assignable to `Record<string, unknown>`.
export type SitemapSourceSettings = {
  url: string;
  /** Left out means `off`, so sources created before scheduling existed do not change. */
  sync?: SyncSchedule;
  /** 1 to 100; left out means `DEFAULT_SYNC_MAX_REMOVE_PERCENT`. */
  maxRemovePercent?: number;
};

export interface EntryInput {
  question: string;
  answer: string;
}

const textEncoder = new TextEncoder();

/** Formats a hand-written entry into the Markdown document stored and ingested. */
export function formatEntryMarkdown(question: string, answer: string): string {
  return `# ${question}\n\n${answer}`;
}

/** Validates a hand-written entry (question and answer). */
export function parseEntryInput(value: unknown): Result<EntryInput> {
  if (!isPlainObject(value)) return fail("body: must be a JSON object");

  const errors = new Errors();
  const question = readTrimmedString(value.question, 1, 300);
  if (question === null) errors.add("question", "must be 1 to 300 characters");

  const answer = readTrimmedString(value.answer, 1, MAX_DOCUMENT_MARKDOWN_BYTES);
  if (answer === null) {
    errors.add("answer", "must not be empty");
  } else {
    const headingBytes =
      question !== null ? textEncoder.encode(formatEntryMarkdown(question, "")).byteLength : 0;
    const maxAnswerBytes = MAX_DOCUMENT_MARKDOWN_BYTES - headingBytes;
    if (textEncoder.encode(answer).byteLength > maxAnswerBytes) {
      errors.add(
        "answer",
        question !== null
          ? `must be at most ${maxAnswerBytes} bytes with this question (total ${MAX_DOCUMENT_MARKDOWN_BYTES} bytes)`
          : `must be at most ${MAX_DOCUMENT_MARKDOWN_BYTES} bytes`,
      );
    }
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
    const sync = value.settings.sync;
    if (sync !== undefined && !SYNC_SCHEDULES.includes(sync as SyncSchedule)) {
      errors.add("settings.sync", 'must be "off", "daily", or "weekly"');
    }
    const maxRemovePercent = value.settings.maxRemovePercent;
    if (
      maxRemovePercent !== undefined &&
      (typeof maxRemovePercent !== "number" ||
        !Number.isInteger(maxRemovePercent) ||
        maxRemovePercent < 1 ||
        maxRemovePercent > 100)
    ) {
      errors.add("settings.maxRemovePercent", "must be a whole number from 1 to 100");
    }
    if (errors.failed || label === null || url === null) return fail(...errors.list);
    const settings: SitemapSourceSettings = { url: url.href };
    if (sync !== undefined) settings.sync = sync as SyncSchedule;
    if (maxRemovePercent !== undefined) settings.maxRemovePercent = maxRemovePercent as number;
    return ok({ kind: "sitemap", label, settings });
  }

  if (value.settings !== undefined && !isPlainObject(value.settings)) {
    errors.add("settings", "must be an object");
  }

  if (errors.failed || label === null || (kind !== "push" && kind !== "entry")) {
    return fail(...errors.list);
  }

  return ok({ kind, label, settings: {} });
}
