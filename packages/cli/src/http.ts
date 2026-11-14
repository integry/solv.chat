/**
 * Error thrown for CLI usage, validation, or HTTP failures that should exit
 * with a non-zero code and a plain message.
 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

interface ApiErrorPayload {
  error?: unknown;
  errors?: unknown;
  fields?: unknown;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/**
 * Formats an API error response into a plain, human-readable message that
 * includes field-level errors without ever echoing credentials.
 */
export async function formatApiError(response: Response, authHint: string): Promise<string> {
  if (response.status === 401) {
    return `Unauthorized (401): check ${authHint}`;
  }

  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    return `Request failed with status ${response.status}`;
  }

  if (bodyText.trim().length > 0) {
    try {
      const parsed = JSON.parse(bodyText) as ApiErrorPayload;
      const details = [...stringList(parsed.errors), ...stringList(parsed.fields)];
      const message = typeof parsed.error === "string" ? parsed.error : undefined;

      if (details.length > 0) {
        const prefix = message ? `${message} ` : "";
        return `Request failed (${response.status}): ${prefix}${details.join("; ")}`;
      }
      if (message) {
        return `Request failed (${response.status}): ${message}`;
      }
    } catch {
      // Plain-text body fallback below.
    }
  }

  return `Request failed with status ${response.status}`;
}

/**
 * Performs an HTTP request using the injected `fetch` implementation, parsing
 * the JSON response or throwing a `CliError` on non-2xx status codes.
 */
export async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  authHint: string,
): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new CliError(await formatApiError(response, authHint));
  }
  return (await response.json()) as T;
}

/** Normalizes an endpoint base URL by stripping trailing slashes. */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function hasInvalidHeaderChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f || code > 0xff) {
      return true;
    }
  }
  return false;
}

/**
 * Validates that a credential header value can be passed to `fetch` without
 * triggering a `TypeError` that echoes the secret, throwing a `CliError` that
 * names only the source environment variable.
 */
export function assertValidHeaderValue(name: string, value: string, envVar: string): void {
  if (hasInvalidHeaderChar(value)) {
    throw new CliError(`Invalid ${envVar} environment variable`);
  }
  try {
    new Headers({ [name]: value });
  } catch {
    throw new CliError(`Invalid ${envVar} environment variable`);
  }
}
