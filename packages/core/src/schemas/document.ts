import { Errors, fail, ok, type Result } from "../result.js";
import { isPlainObject, parseUrl, readTrimmedString } from "./shared.js";

/** Maximum markdown payload size per document (1 MiB) so one document cannot exhaust the Worker. */
export const MAX_DOCUMENT_MARKDOWN_BYTES = 1024 * 1024;

export interface DocumentInput {
  externalId: string;
  url: string;
  title: string;
  markdown: string;
}

const textEncoder = new TextEncoder();

/** Validates an ingested document payload. */
export function parseDocumentInput(value: unknown): Result<DocumentInput> {
  if (!isPlainObject(value)) return fail("body: must be a JSON object");

  const errors = new Errors();
  const externalId = readTrimmedString(value.externalId, 1, 200);
  if (externalId === null) errors.add("externalId", "must be 1 to 200 characters");

  const parsedUrl = parseUrl(value.url, ["https:", "http:"]);
  if (parsedUrl === null) errors.add("url", "must be an absolute http or https URL");

  const title = readTrimmedString(value.title, 0, 300);
  if (title === null) errors.add("title", "must be a string of at most 300 characters");

  if (typeof value.markdown !== "string") {
    errors.add("markdown", "must be a string");
  } else if (textEncoder.encode(value.markdown).byteLength > MAX_DOCUMENT_MARKDOWN_BYTES) {
    errors.add("markdown", `must be at most ${MAX_DOCUMENT_MARKDOWN_BYTES} bytes`);
  }

  if (
    errors.failed ||
    externalId === null ||
    parsedUrl === null ||
    title === null ||
    typeof value.markdown !== "string"
  ) {
    return fail(...errors.list);
  }

  return ok({
    externalId,
    url: parsedUrl.href,
    title,
    markdown: value.markdown,
  });
}
