import type { Tenant } from "../db/tenant.js";
import type { RetrievedChunk } from "../providers/retrieval.js";

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

/**
 * Resolves retrieved vector hits against D1 for the tenant org and assistant,
 * dropping any ids with no live chunk row and returning survivors in score order.
 */
export async function resolveChunks(
  tenant: Tenant,
  assistantId: string,
  retrieved: RetrievedChunk[],
): Promise<ResolvedChunk[]> {
  if (retrieved.length === 0) return [];

  const uniqueIds = [...new Set(retrieved.map((item) => item.chunkId))];
  const rows = await tenant.documents.chunksByIds(assistantId, uniqueIds);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const sorted = [...retrieved].sort((a, b) => b.score - a.score);
  const out: ResolvedChunk[] = [];
  for (const hit of sorted) {
    const row = byId.get(hit.chunkId);
    if (!row) continue;
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
