import { ApiError, postJson } from "./client.js";
import type { TestRunSummary, VersionRow } from "./types.js";

/** The draft the owner confirmed in "What will change": its id and revision. */
export interface ConfirmedDraft {
  draftId: string;
  revision: string;
}

/**
 * Thrown when the server refused to publish because the draft changed after
 * the owner confirmed it (another tab saved, say). The comparison must be
 * shown again before another publish.
 */
export class DraftChangedError extends Error {}

/** Thrown when publish is blocked because one or more answer tests failed. */
export class FailedTestsError extends Error {
  readonly run: TestRunSummary;

  constructor(run: TestRunSummary) {
    super("Some tests did not pass.");
    this.run = run;
  }
}

/**
 * Publishes the draft, or throws `FailedTestsError` when the server refuses
 * with 409 because tests failed. With `confirmed`, only that draft is
 * published: `DraftChangedError` when the draft is no longer it.
 */
export async function publishAssistant(
  assistantId: string,
  force: boolean,
  runId?: string,
  confirmed?: ConfirmedDraft,
): Promise<{ version: VersionRow }> {
  try {
    const fields = {
      ...(force ? { force: true } : {}),
      ...(force && runId ? { runId } : {}),
      ...(confirmed ? { expected: confirmed } : {}),
    };
    const body = Object.keys(fields).length > 0 ? fields : undefined;
    return await postJson<{ version: VersionRow }>(
      `/api/admin/assistants/${assistantId}/publish`,
      body,
    );
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.status === 409 &&
      typeof err.body === "object" &&
      err.body !== null &&
      (err.body as { code?: unknown }).code === "draft_changed"
    ) {
      throw new DraftChangedError(err.message);
    }
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
