import type { Tenant } from "../db/tenant.js";
import type { IngestQueueMessage } from "../ingest/documents.js";
import { INGEST_VERSION } from "../ingest/version.js";
import type { Limits } from "../seams/types.js";
import { NotFound } from "./errors.js";

/**
 * Documents queued by one "Rebuild" request. Reading them is one D1 query
 * and queuing them `REINDEX_MAX_DOCUMENTS / 100` queue batches, well inside
 * one request's limits; an assistant with more is rebuilt over several
 * presses (the response says how many are left). Ours.
 */
export const REINDEX_MAX_DOCUMENTS = 1000;
// "100 (or 256KB in total)" messages per `sendBatch`; 128 KB per message.
// Source: https://developers.cloudflare.com/queues/platform/limits/ — checked 2026-11-18
const QUEUE_SEND_BATCH_MESSAGES = 100;

export interface ReindexDeps {
  tenant: Tenant;
  orgId: string;
  queue: { sendBatch(messages: Array<{ body: IngestQueueMessage }>): Promise<unknown> };
  limits: Pick<Limits, "check">;
}

/** How many of the assistant's documents were indexed by an older ingest version. */
export interface ReindexStatus {
  outdated: number;
}

export interface ReindexResult {
  /** Documents queued to be rebuilt by this request. */
  queued: number;
  /** Outdated documents this request did not queue (over `REINDEX_MAX_DOCUMENTS`). */
  remaining: number;
}

/** Thrown when the Limits seam refuses the rebuild; mapped to 429. */
export class ReindexRefused extends Error {}

export async function reindexStatus(tenant: Tenant, assistantId: string): Promise<ReindexStatus> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  return { outdated: await tenant.documents.countOutdated(assistantId, INGEST_VERSION) };
}

/**
 * Rebuilds the assistant's documents that were indexed by an older ingest
 * version, from their stored text: each is queued as an ordinary
 * chunk-and-embed message, and the consumer (seeing an older version on a
 * document whose content is unchanged) chunks and embeds it again and
 * commits it with the current version. Nothing is fetched: a page's stored
 * text is what was read when it was fetched, so page chrome kept by the old
 * extraction stays until the page is fetched again (the next scheduled
 * sync of a synced source does that once; see `ingest/version.ts`).
 *
 * Asked of `Limits` as `{ kind: "ingest" }`, like any ingest. The cost is
 * that of indexing the same content again: the embedding of every chunk,
 * recorded through `UsageSink` as it is billed, as for a push. Idempotent:
 * a document rebuilt already is not outdated, and a message for one that a
 * concurrent rebuild finished is acknowledged without work.
 */
export async function reindexAssistant(
  deps: ReindexDeps,
  assistantId: string,
): Promise<ReindexResult> {
  const assistant = await deps.tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  const decision = await deps.limits.check(deps.orgId, assistantId, { kind: "ingest" });
  if (!decision.ok) throw new ReindexRefused(decision.reason);

  const [documents, total] = await Promise.all([
    deps.tenant.documents.listOutdated(assistantId, INGEST_VERSION, REINDEX_MAX_DOCUMENTS),
    deps.tenant.documents.countOutdated(assistantId, INGEST_VERSION),
  ]);
  for (let i = 0; i < documents.length; i += QUEUE_SEND_BATCH_MESSAGES) {
    await deps.queue.sendBatch(
      documents.slice(i, i + QUEUE_SEND_BATCH_MESSAGES).map((doc) => ({
        body: { orgId: deps.orgId, documentId: doc.id, contentHash: doc.contentHash },
      })),
    );
  }
  return { queued: documents.length, remaining: Math.max(0, total - documents.length) };
}
