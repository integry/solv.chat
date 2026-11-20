import {
  REPEATED_MIN_PAGES,
  REPEATED_MIN_PERCENT,
  REPEATED_MIN_SOURCE_PAGES,
} from "../ingest/repeated.js";
import { prepare, safeJsonArray } from "./sql.js";

/**
 * A source's repeated block hashes as stored: sorted, and the raw JSON for a
 * compare-and-set; with the hashes whose pages are still owed a rebuild
 * (`pending`) and the count of stores (`rev`) that guards their removal.
 */
export interface StoredRepeated {
  hashes: string[];
  raw: string;
  pending: string[];
  rev: number;
  /**
   * Removals whose reconciliation has not yet run through (`repeated_owed`
   * above `repeated_reconciled`); 0 when none.
   */
  owed: number;
  /**
   * The source's count of removals (`repeated_owed`, which only rises), as
   * read with the set: the removals a reconciliation that runs through after
   * this read accounts for, passed to `discharge`.
   */
  removals: number;
  /**
   * The count of changes to the source's counted pages (`repeated_pages_rev`:
   * a page committed with its blocks, or deleted), as read with the set; a
   * changed set worked out after this read is stored only while it holds.
   */
  pagesRev: number;
}

const stringArray = (raw: string): string[] =>
  safeJsonArray<unknown>(raw)
    .filter((value): value is string => typeof value === "string")
    .sort();

/** Hashes for a JSON parameter: deduplicated and sorted. */
const hashList = (hashes: readonly string[]): string => JSON.stringify([...new Set(hashes)].sort());

/**
 * Tenant-scoped data access for repeated-block counting (`document_blocks`,
 * `source_blocks`, `sources.repeated_blocks`). Only hashes are read or
 * written here; a block's text lives in its document's R2 body.
 */
export function blocksFor(db: D1Database, orgId: string) {
  return {
    /** The source's repeated hashes as last stored, or null when there is no such source. */
    async stored(sourceId: string): Promise<StoredRepeated | null> {
      const row = await prepare(
        db,
        `SELECT repeated_blocks, repeated_pending, repeated_rev, repeated_owed,
                repeated_reconciled, repeated_pages_rev
           FROM sources WHERE org_id = ?1 AND id = ?2`,
      )
        .bind(orgId, sourceId)
        .first<{
          repeated_blocks: string;
          repeated_pending: string;
          repeated_rev: number;
          repeated_owed: number;
          repeated_reconciled: number;
          repeated_pages_rev: number;
        }>();
      if (row === null) return null;
      return {
        hashes: stringArray(row.repeated_blocks),
        raw: row.repeated_blocks,
        pending: stringArray(row.repeated_pending),
        rev: Number(row.repeated_rev),
        owed: Math.max(0, Number(row.repeated_owed) - Number(row.repeated_reconciled)),
        removals: Number(row.repeated_owed),
        pagesRev: Number(row.repeated_pages_rev),
      };
    },

    /**
     * The hashes on at least `repeatedThreshold(pages)` of the source's
     * indexed pages (those with recorded blocks), worked out from the
     * counts in one statement: it reads the source's page count from
     * `documents_identity` and only the `source_blocks` rows over the
     * threshold.
     */
    async compute(sourceId: string): Promise<string[]> {
      const res = await prepare(
        db,
        `WITH n AS (
           SELECT COUNT(*) AS pages FROM documents
            WHERE org_id = ?1 AND source_id = ?2 AND repeated_key IS NOT NULL
         )
         SELECT b.block_hash AS block_hash
           FROM source_blocks b, n
          WHERE b.org_id = ?1 AND b.source_id = ?2
            AND n.pages >= ?3
            AND b.pages >= MAX(?4, (n.pages * ?5 + 99) / 100)
          ORDER BY b.block_hash`,
      )
        .bind(orgId, sourceId, REPEATED_MIN_SOURCE_PAGES, REPEATED_MIN_PAGES, REPEATED_MIN_PERCENT)
        .all<{ block_hash: string }>();
      return res.results.map((row) => row.block_hash);
    },

    /**
     * Stores `next` as the source's repeated hashes if they are still
     * `expected.raw` and no page of the source was committed or deleted
     * since `expected.pagesRev` was read (`next` was counted from the pages
     * as they were then), and in the same statement adds `changed` (the
     * hashes whose status this changes) to the pending ones, so the pages
     * holding them stay owed a rebuild until `settle` removes them.
     */
    async swap(
      sourceId: string,
      expected: Pick<StoredRepeated, "raw" | "pagesRev">,
      next: readonly string[],
      changed: readonly string[],
    ): Promise<boolean> {
      const res = await prepare(
        db,
        `UPDATE sources
            SET repeated_blocks = ?4,
                repeated_pending = (
                  SELECT json_group_array(value) FROM (
                    SELECT value FROM json_each(sources.repeated_pending)
                    UNION SELECT value FROM json_each(?5)
                    ORDER BY value
                  )
                ),
                repeated_rev = repeated_rev + 1
          WHERE org_id = ?1 AND id = ?2 AND repeated_blocks = ?3 AND repeated_pages_rev = ?6`,
      )
        .bind(orgId, sourceId, expected.raw, hashList(next), hashList(changed), expected.pagesRev)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    /**
     * Removes `delivered` from the source's pending hashes once their pages
     * are queued, unless the repeated hashes were stored again since `rev`
     * was read (the pages that store owes may not be queued yet; the next
     * reconciliation queues them and settles).
     */
    async settle(sourceId: string, rev: number, delivered: readonly string[]): Promise<boolean> {
      if (delivered.length === 0) return true;
      const res = await prepare(
        db,
        `UPDATE sources
            SET repeated_pending = (
                  SELECT json_group_array(value) FROM (
                    SELECT value FROM json_each(sources.repeated_pending)
                     WHERE value NOT IN (SELECT value FROM json_each(?4))
                     ORDER BY value
                  )
                )
          WHERE org_id = ?1 AND id = ?2 AND repeated_rev = ?3`,
      )
        .bind(orgId, sourceId, rev, hashList(delivered))
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    /**
     * Records that a reconciliation which read the source's removals as
     * `expected.removals` (before it counted) has run through: those
     * removals are accounted for. A removal since raised `repeated_owed`
     * past that value, and stays owed. `repeated_reconciled` only rises, so a
     * reconciliation that finishes after a later one never lowers it.
     */
    async discharge(
      sourceId: string,
      expected: Pick<StoredRepeated, "owed" | "removals">,
    ): Promise<boolean> {
      if (expected.owed === 0) return true;
      const res = await prepare(
        db,
        `UPDATE sources SET repeated_reconciled = ?3
          WHERE org_id = ?1 AND id = ?2 AND repeated_reconciled < ?3`,
      )
        .bind(orgId, sourceId, expected.removals)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    /** The hashes recorded for one document. */
    async forDocument(documentId: string): Promise<string[]> {
      const res = await prepare(
        db,
        "SELECT block_hash FROM document_blocks WHERE org_id = ?1 AND document_id = ?2 ORDER BY block_hash",
      )
        .bind(orgId, documentId)
        .all<{ block_hash: string }>();
      return res.results.map((row) => row.block_hash);
    },

    /**
     * The source's indexed documents holding any of `hashes`: the pages a
     * change to those hashes' status makes out of date. A document still
     * owed its indexing is left out; its own message builds it with the
     * repeated blocks of its time.
     */
    async documentsWith(
      sourceId: string,
      hashes: readonly string[],
    ): Promise<Array<{ id: string; contentHash: string }>> {
      if (hashes.length === 0) return [];
      const res = await prepare(
        db,
        `SELECT DISTINCT d.id AS id, d.content_hash AS content_hash
           FROM document_blocks b
           JOIN documents d ON d.org_id = b.org_id AND d.id = b.document_id
          WHERE b.org_id = ?1 AND b.source_id = ?2
            AND b.block_hash IN (SELECT value FROM json_each(?3))
            AND d.indexed_hash = d.content_hash AND d.body_key IS NOT NULL
          ORDER BY d.id`,
      )
        .bind(orgId, sourceId, hashList(hashes))
        .all<{ id: string; content_hash: string }>();
      return res.results.map((row) => ({ id: row.id, contentHash: row.content_hash }));
    },

    /**
     * For each of `hashes`: on how many of the source's pages it is, and one
     * document holding it (the first by id, so the same one each time).
     */
    async samples(
      sourceId: string,
      hashes: readonly string[],
    ): Promise<Map<string, { pages: number; documentId: string | null }>> {
      const out = new Map<string, { pages: number; documentId: string | null }>();
      if (hashes.length === 0) return out;
      const res = await prepare(
        db,
        `SELECT s.block_hash AS block_hash, s.pages AS pages,
                (SELECT MIN(b.document_id) FROM document_blocks b
                  WHERE b.org_id = s.org_id AND b.source_id = s.source_id
                    AND b.block_hash = s.block_hash) AS document_id
           FROM source_blocks s
          WHERE s.org_id = ?1 AND s.source_id = ?2
            AND s.block_hash IN (SELECT value FROM json_each(?3))`,
      )
        .bind(orgId, sourceId, hashList(hashes))
        .all<{ block_hash: string; pages: number; document_id: string | null }>();
      for (const row of res.results) {
        out.set(row.block_hash, { pages: Number(row.pages), documentId: row.document_id });
      }
      return out;
    },
  };
}
