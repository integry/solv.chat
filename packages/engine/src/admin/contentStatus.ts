import type { Tenant } from "../db/tenant.js";
import { INDEX_SETTLE_MS } from "../ingest/indexLag.js";
import { NotFound } from "./errors.js";

/**
 * `GET …/assistants/:id/content-status`: whether answers may not reflect
 * the assistant's latest content changes yet (see "Index lag").
 */
export interface ContentStatus {
  /**
   * True while documents are waiting to be indexed, or for
   * `INDEX_SETTLE_MS` after the last change to searchable content (chunks
   * committed, documents deleted, a Rebuild queued).
   */
  settling: boolean;
  /** Documents still waiting to be indexed (Sources' "Indexing…"). */
  indexing: number;
  /**
   * When the notice ends if nothing else changes and nothing is waiting
   * (milliseconds); null when not settling or while documents are waiting.
   */
  settlesAt: number | null;
}

export async function contentStatus(
  tenant: Tenant,
  assistantId: string,
  now: number = Date.now(),
): Promise<ContentStatus> {
  const status = await tenant.assistants.contentStatus(assistantId);
  if (status === null) throw new NotFound("assistant");
  const until = status.changedAt === null ? null : status.changedAt + INDEX_SETTLE_MS;
  const recent = until !== null && until > now;
  const waiting = status.indexing > 0;
  return {
    settling: waiting || recent,
    indexing: status.indexing,
    settlesAt: !waiting && recent ? until : null,
  };
}
