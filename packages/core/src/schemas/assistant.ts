import { Errors, fail, ok, type Result } from "../result.js";
import { isPlainObject, readTrimmedString } from "./shared.js";

export interface AssistantInput {
  name: string;
  allowedOrigins: string[];
}

/**
 * Origins are compared byte-for-byte against the Origin header at runtime, so
 * we normalise here and reject anything that is not exactly an origin.
 * Accepting a path or a wildcard would quietly widen who may embed the
 * assistant or where `navigate` may send a visitor.
 */
export function parseOriginValue(raw: unknown, field: string, errors: Errors): string | null {
  if (typeof raw !== "string" || raw.trim() === "") {
    errors.add(field, "must be a non-empty string");
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    errors.add(field, "must be an absolute URL such as https://example.com");
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    errors.add(field, "must use http or https");
    return null;
  }
  if (url.username !== "" || url.password !== "") {
    errors.add(field, "must be an origin only, with no credentials");
    return null;
  }
  if (url.hostname.includes("*")) {
    errors.add(field, "must not contain wildcards");
    return null;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    errors.add(field, "must be an origin only, with no path");
    return null;
  }
  return url.origin;
}

/** Validates and normalises assistant creation/update input. */
export function parseAssistantInput(value: unknown): Result<AssistantInput> {
  if (!isPlainObject(value)) return fail("body: must be a JSON object");

  const errors = new Errors();
  const name = readTrimmedString(value.name, 1, 80);
  if (name === null) errors.add("name", "must be 1 to 80 characters");

  const origins: string[] = [];
  if (!Array.isArray(value.allowedOrigins)) {
    errors.add("allowedOrigins", "must be an array");
  } else {
    value.allowedOrigins.forEach((raw, i) => {
      const origin = parseOriginValue(raw, `allowedOrigins[${i}]`, errors);
      // De-duplicate: the admin lets an owner paste a list, and a repeat would
      // otherwise show twice on the Widget screen.
      if (origin !== null && !origins.includes(origin)) origins.push(origin);
    });
  }

  if (errors.failed || name === null) return fail(...errors.list);
  // Built from known fields only: returning the caller's object would let a
  // visitor smuggle extra keys into whatever we persist next.
  return ok({ name, allowedOrigins: origins });
}
