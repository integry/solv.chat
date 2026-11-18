/**
 * Thrown where a row is absent or belongs to another org: the API answers
 * 404 for both so it never confirms another org's ids.
 */
export class NotFound extends Error {}

/** Thrown when request input or state fails validation; mapped to 400. */
export class BadRequest extends Error {
  readonly errors: string[];
  /** A stable code for a client to tell this refusal apart; sent as `code` when set. */
  readonly code: string | undefined;

  constructor(errors: string[], code?: string) {
    super(errors.join("; "));
    this.errors = errors;
    this.code = code;
  }
}

/** Thrown when a concurrent change prevents completing an update; mapped to 409. */
export class Conflict extends Error {
  /** A stable code for a client to tell this refusal apart; sent as `code` when set. */
  readonly code: string | undefined;

  constructor(message?: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** Parses a JSON request body, throwing `BadRequest` on malformed JSON. */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadRequest(["body: must be valid JSON"]);
  }
}
