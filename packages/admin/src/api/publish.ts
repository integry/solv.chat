import { ApiError, postJson } from "./client.js";
import type { TestRunSummary, VersionRow } from "./types.js";

/** Thrown when publish is blocked because one or more answer tests failed. */
export class FailedTestsError extends Error {
  readonly run: TestRunSummary;

  constructor(run: TestRunSummary) {
    super("Some tests did not pass.");
    this.run = run;
  }
}

/**
 * Publishes the current draft, or throws `FailedTestsError` when the server
 * refuses with 409 because tests failed.
 */
export async function publishAssistant(
  assistantId: string,
  force: boolean,
): Promise<{ version: VersionRow }> {
  try {
    return await postJson<{ version: VersionRow }>(
      `/api/admin/assistants/${assistantId}/publish`,
      force ? { force: true } : undefined,
    );
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.status === 409 &&
      typeof err.body === "object" &&
      err.body !== null &&
      "run" in err.body &&
      typeof (err.body as { run?: unknown }).run === "object" &&
      (err.body as { run?: unknown }).run !== null
    ) {
      throw new FailedTestsError((err.body as { run: TestRunSummary }).run);
    }
    throw err;
  }
}
