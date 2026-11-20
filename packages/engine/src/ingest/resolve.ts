import type { ResolvedChunkRow } from "../db/documents.js";
import type { Tenant } from "../db/tenant.js";
import type { RetrievedChunk } from "../providers/retrieval.js";
import { RETIRED_CHUNK_KEEP_MS } from "./indexLag.js";

export interface ResolvedChunk {
  chunkId: string;
  documentId: string;
  score: number;
  text: string;
  headingPath: string;
  url: string;
  title: string;
  /** `entry` answers live in the admin, so their URL is not a visitor link. */
  sourceKind: "push" | "sitemap" | "entry";
}

// "Maximum bound parameters per query: 100", two taken by org and assistant.
// Source: https://developers.cloudflare.com/d1/platform/limits/ — checked 2026-11-14
const IDS_PER_READ = 98;

async function liveRows(
  tenant: Tenant,
  assistantId: string,
  ids: string[],
): Promise<ResolvedChunkRow[]> {
  const out: ResolvedChunkRow[] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_READ) {
    out.push(...(await tenant.documents.chunksByIds(assistantId, ids.slice(i, i + IDS_PER_READ))));
  }
  return out;
}

/**
 * Resolves retrieved vector hits against D1 for the tenant org and assistant,
 * dropping any ids with no chunk row and returning survivors in score order.
 *
 * A hit whose chunk a re-index or update replaced within
 * `RETIRED_CHUNK_KEEP_MS` resolves to that chunk's text (`retired_chunks`):
 * the index still returns the old vector until it applies the delete, and
 * may not show the new ones yet, so the page stays answerable meanwhile
 * (see "Index lag"). It is left out when a current chunk of the same
 * document is among the hits: the index already shows the new content.
 */
export async function resolveChunks(
  tenant: Tenant,
  assistantId: string,
  retrieved: RetrievedChunk[],
  options: { now?: number | undefined } = {},
): Promise<ResolvedChunk[]> {
  if (retrieved.length === 0) return [];

  const uniqueIds = [...new Set(retrieved.map((item) => item.chunkId))];
  const rows = await liveRows(tenant, assistantId, uniqueIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = uniqueIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    const since = (options.now ?? Date.now()) - RETIRED_CHUNK_KEEP_MS;
    const liveDocuments = new Set(rows.map((row) => row.documentId));
    const retired = await tenant.documents.retiredChunksByIds(assistantId, missing, since);
    for (const row of retired) {
      if (!liveDocuments.has(row.documentId)) byId.set(row.id, row);
    }
  }

  const sorted = [...retrieved].sort((a, b) => b.score - a.score);
  const out: ResolvedChunk[] = [];
  const seen = new Set<string>();
  for (const hit of sorted) {
    const row = byId.get(hit.chunkId);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({
      chunkId: row.id,
      documentId: row.documentId,
      score: hit.score,
      text: row.text,
      headingPath: row.headingPath,
      url: row.url,
      title: row.title,
      sourceKind: row.sourceKind,
    });
  }
  return out;
}
