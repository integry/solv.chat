/**
 * Thrown where a row is absent or belongs to another org: the API answers
 * 404 for both so it never confirms another org's ids.
 */
export class NotFound extends Error {}

/** Thrown when request input or state fails validation; mapped to 400. */
export class BadRequest extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join("; "));
    this.errors = errors;
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
