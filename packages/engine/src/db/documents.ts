import { INGEST_VERSION } from "../ingest/version.js";
import { prepare, prepareInsert } from "./sql.js";
import { type SyncRunFence, syncRunHolds } from "./sync.js";

interface DocumentDbRow {
  id: string;
  org_id: string;
  source_id: string;
  external_id: string;
  url: string;
  title: string;
  content_hash: string;
  indexed_hash: string | null;
  body_key: string | null;
  updated_at: number;
  ingest_version: number;
  page_version: number | null;
  repeated_key: string | null;
}

interface ChunkDbRow {
  id: string;
  org_id: string;
  document_id: string;
  ordinal: number;
  text: string;
  heading_path: string;
}

export interface DocumentRow {
  id: string;
  orgId: string;
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  contentHash: string;
  indexedHash: string | null;
  bodyKey: string | null;
  updatedAt: number;
  /** The ingest version its searchable chunks were built with (see `ingest/version.ts`). */
  ingestVersion: number;
  /** For a fetched page, the extraction version of its stored text; null otherwise or before. */
  pageVersion: number | null;
  /**
   * Which of its blocks were repeated across its source when its chunks
   * were built (see `repeatedKey` in `ingest/repeated.ts`); null when its
   * blocks are not recorded (a written answer, or not built since).
   */
  repeatedKey: string | null;
}

/**
 * Why a document could not be indexed. Codes, not messages: the admin words
 * them, and a provider's own error text never reaches the database.
 */
export type IndexErrorCode = "too_long" | "missing_body" | "embedding_failed";

export interface DocumentSummaryRow {
  id: string;
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  updatedAt: number;
}

export interface ExistingDocumentState {
  id: string;
  url: string;
  contentHash: string;
  indexedHash: string | null;
  bodyKey: string | null;
  /** Absent means current: a row this push just wrote. */
  ingestVersion?: number;
}

export interface ChunkRow {
  id: string;
  orgId: string;
  documentId: string;
  ordinal: number;
  text: string;
  headingPath: string;
}

export interface ResolvedChunkRow {
  id: string;
  documentId: string;
  text: string;
  headingPath: string;
  url: string;
  title: string;
  sourceKind: "push" | "sitemap" | "entry";
}

export interface UpsertDocumentInput {
  id: string;
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  contentHash: string;
  bodyKey?: string | null;
  updatedAt: number;
}

/** What a scheduled sync needs to know about a document it may check again. */
export interface DocumentSyncRow {
  id: string;
  externalId: string;
  url: string;
  bodyKey: string | null;
  contentHash: string;
  /** The content last indexed; a value other than `contentHash` means indexing is still owed. */
  indexedHash: string | null;
  etag: string | null;
  lastModified: string | null;
  sitemapLastmod: string | null;
  syncCheckedAt: number | null;
  ingestVersion: number;
  pageVersion: number | null;
}

/** What a sync page needs before its conditional request: validators, and whether indexing is owed. */
export interface DocumentSyncValidators {
  id: string;
  bodyKey: string | null;
  contentHash: string;
  indexedHash: string | null;
  etag: string | null;
  lastModified: string | null;
  ingestVersion: number;
  pageVersion: number | null;
}

/** Validators recorded when a sync checks a page, for the next run's conditional request. */
export interface DocumentSyncCheck {
  etag: string | null;
  lastModified: string | null;
  sitemapLastmod: string | null;
  checkedAt: number;
  /**
   * The extraction version of the text now stored for the page, when this
   * check stored or confirmed it; left out, the stored version is kept.
   */
  pageVersion?: number | undefined;
}

/**
 * A page's recorded blocks, committed with its chunks (see "Repeated
 * blocks" in docs/architecture.md): its distinct block hashes and its
 * `repeatedKey`.
 */
export interface BlocksInput {
  sourceId: string;
  hashes: readonly string[];
  key: string;
}

export interface CommitOptions {
  /** Recorded in the same guarded batch; left out for a written answer. */
  blocks?: BlocksInput | undefined;
  /**
   * The ids of the stored chunks this build compared and found to be what
   * it makes: they (and so their vectors) stay, and only the document's
   * state and blocks are written. The commit is refused unless the
   * document's chunks are still exactly these, so a build that replaced
   * them after the comparison is never recorded over by this one.
   */
  keepChunks?: readonly string[] | undefined;
}

export interface ChunkInput {
  id: string;
  ordinal: number;
  text: string;
  headingPath: string;
}

const DOC_COLUMNS =
  "id, org_id, source_id, external_id, url, title, content_hash, indexed_hash, body_key, updated_at, ingest_version, page_version, repeated_key";
const CHUNK_COLUMNS = "id, org_id, document_id, ordinal, text, heading_path";

const mapDocument = (row: DocumentDbRow): DocumentRow => ({
  id: row.id,
  orgId: row.org_id,
  sourceId: row.source_id,
  externalId: row.external_id,
  url: row.url,
  title: row.title,
  contentHash: row.content_hash,
  indexedHash: row.indexed_hash,
  bodyKey: row.body_key,
  updatedAt: row.updated_at,
  ingestVersion: row.ingest_version,
  pageVersion: row.page_version,
  repeatedKey: row.repeated_key,
});

const mapChunk = (row: ChunkDbRow): ChunkRow => ({
  id: row.id,
  orgId: row.org_id,
  documentId: row.document_id,
  ordinal: row.ordinal,
  text: row.text,
  headingPath: row.heading_path,
});

// Source: https://developers.cloudflare.com/d1/platform/limits/ — checked 2026-11-14
// "Maximum bound parameters per query: 100"; a `db.batch()` "counts as a
// single query" against the per-invocation query limit. Two parameters are
// taken by org and source, so IN lists hold at most 98 values.
const IN_LIST_LIMIT = 98;

function inGroups<T>(values: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < values.length; i += IN_LIST_LIMIT) {
    groups.push(values.slice(i, i + IN_LIST_LIMIT));
  }
  return groups;
}

const placeholdersFrom = (count: number, first: number): string =>
  Array.from({ length: count }, (_, i) => `?${i + first}`).join(", ");

/** Tenant-scoped data access for `documents` and `chunks`. */
export function documentsFor(db: D1Database, orgId: string) {
  async function upsertRow(
    input: UpsertDocumentInput,
    fence: SyncRunFence | undefined,
  ): Promise<DocumentRow | null> {
    const values =
      fence === undefined
        ? "VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
        : `SELECT ?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE ${syncRunHolds("?1", "?3", "?10", "?11")}`;
    const statement = prepareInsert(
      db,
      `INSERT INTO documents (
         id, org_id, source_id, external_id, url, title, content_hash, body_key, updated_at
       )
       ${values}
       ON CONFLICT(org_id, source_id, external_id) DO UPDATE SET
         url = excluded.url,
         title = excluded.title,
         content_hash = excluded.content_hash,
         body_key = excluded.body_key,
         updated_at = excluded.updated_at
       RETURNING ${DOC_COLUMNS}`,
    );
    const params = [
      orgId,
      input.id,
      input.sourceId,
      input.externalId,
      input.url,
      input.title,
      input.contentHash,
      input.bodyKey ?? null,
      input.updatedAt,
    ];
    const saved = await (fence === undefined
      ? statement.bind(...params)
      : statement.bind(...params, fence.runId, fence.now)
    ).first<DocumentDbRow>();

    return saved ? mapDocument(saved) : null;
  }

  return {
    async listBySource(sourceId: string): Promise<DocumentRow[]> {
      const res = await prepare(
        db,
        `SELECT ${DOC_COLUMNS} FROM documents WHERE org_id = ?1 AND source_id = ?2 ORDER BY updated_at DESC`,
      )
        .bind(orgId, sourceId)
        .all<DocumentDbRow>();
      return res.results.map(mapDocument);
    },

    async listBySourcePaged(
      sourceId: string,
      options: { limit: number; offset: number },
    ): Promise<{ documents: DocumentSummaryRow[]; total: number }> {
      const [rows, countRow] = await Promise.all([
        prepare(
          db,
          `SELECT id, source_id, external_id, url, title, updated_at
           FROM documents
           WHERE org_id = ?1 AND source_id = ?2
           ORDER BY updated_at DESC, id ASC
           LIMIT ?3 OFFSET ?4`,
        )
          .bind(orgId, sourceId, options.limit, options.offset)
          .all<{
            id: string;
            source_id: string;
            external_id: string;
            url: string;
            title: string;
            updated_at: number;
          }>(),
        prepare(db, "SELECT COUNT(*) AS total FROM documents WHERE org_id = ?1 AND source_id = ?2")
          .bind(orgId, sourceId)
          .first<{ total: number }>(),
      ]);
      return {
        documents: rows.results.map((row) => ({
          id: row.id,
          sourceId: row.source_id,
          externalId: row.external_id,
          url: row.url,
          title: row.title,
          updatedAt: row.updated_at,
        })),
        total: Number(countRow?.total ?? 0),
      };
    },

    async get(id: string): Promise<DocumentRow | null> {
      const row = await prepare(
        db,
        `SELECT ${DOC_COLUMNS} FROM documents WHERE org_id = ?1 AND id = ?2`,
      )
        .bind(orgId, id)
        .first<DocumentDbRow>();
      return row ? mapDocument(row) : null;
    },

    /** The source's documents with these external ids, in one D1 batch however many. */
    async getByExternalIds(sourceId: string, externalIds: string[]): Promise<DocumentRow[]> {
      if (externalIds.length === 0) return [];
      const results = await db.batch(
        inGroups(externalIds).map((group) =>
          prepare(
            db,
            `SELECT ${DOC_COLUMNS} FROM documents
              WHERE org_id = ?1 AND source_id = ?2 AND external_id IN (${placeholdersFrom(group.length, 3)})`,
          ).bind(orgId, sourceId, ...group),
        ),
      );
      return results.flatMap((r) => (r.results as DocumentDbRow[]).map(mapDocument));
    },

    async getByExternalId(sourceId: string, externalId: string): Promise<DocumentRow | null> {
      const row = await prepare(
        db,
        `SELECT ${DOC_COLUMNS} FROM documents WHERE org_id = ?1 AND source_id = ?2 AND external_id = ?3`,
      )
        .bind(orgId, sourceId, externalId)
        .first<DocumentDbRow>();
      return row ? mapDocument(row) : null;
    },

    async existingFor(
      sourceId: string,
      externalIds: string[],
    ): Promise<Map<string, ExistingDocumentState>> {
      const result = new Map<string, ExistingDocumentState>();
      if (externalIds.length === 0) return result;
      // Only the batch's own ids, passed as one JSON parameter: a source can
      // hold thousands of documents, and a batch of 100 should not read them
      // all. One parameter also stays clear of D1's 100-parameter limit.
      const rows = await prepare(
        db,
        `SELECT id, external_id, url, content_hash, indexed_hash, body_key, ingest_version FROM documents
         WHERE org_id = ?1 AND source_id = ?2
           AND external_id IN (SELECT value FROM json_each(?3))`,
      )
        .bind(orgId, sourceId, JSON.stringify([...new Set(externalIds)]))
        .all<{
          id: string;
          external_id: string;
          url: string;
          content_hash: string;
          indexed_hash: string | null;
          body_key: string | null;
          ingest_version: number;
        }>();
      for (const row of rows.results) {
        result.set(row.external_id, {
          id: row.id,
          url: row.url,
          contentHash: row.content_hash,
          indexedHash: row.indexed_hash,
          bodyKey: row.body_key,
          ingestVersion: row.ingest_version,
        });
      }
      return result;
    },

    /** Every document of the source, with the validators a sync stored for it. */
    async listForSync(sourceId: string): Promise<DocumentSyncRow[]> {
      const res = await prepare(
        db,
        `SELECT id, external_id, url, body_key, content_hash, indexed_hash,
                etag, last_modified, sitemap_lastmod, sync_checked_at, ingest_version, page_version
           FROM documents WHERE org_id = ?1 AND source_id = ?2`,
      )
        .bind(orgId, sourceId)
        .all<{
          id: string;
          external_id: string;
          url: string;
          body_key: string | null;
          content_hash: string;
          indexed_hash: string | null;
          etag: string | null;
          last_modified: string | null;
          sitemap_lastmod: string | null;
          sync_checked_at: number | null;
          ingest_version: number;
          page_version: number | null;
        }>();
      return res.results.map((row) => ({
        id: row.id,
        externalId: row.external_id,
        url: row.url,
        bodyKey: row.body_key,
        contentHash: row.content_hash,
        indexedHash: row.indexed_hash,
        etag: row.etag,
        lastModified: row.last_modified,
        sitemapLastmod: row.sitemap_lastmod,
        syncCheckedAt: row.sync_checked_at,
        ingestVersion: row.ingest_version,
        pageVersion: row.page_version,
      }));
    },

    /** The validators a sync stored for one document and its indexing state, or null when there is no such document. */
    async syncValidators(
      sourceId: string,
      externalId: string,
    ): Promise<DocumentSyncValidators | null> {
      const row = await prepare(
        db,
        `SELECT id, body_key, content_hash, indexed_hash, etag, last_modified, ingest_version, page_version
           FROM documents
          WHERE org_id = ?1 AND source_id = ?2 AND external_id = ?3`,
      )
        .bind(orgId, sourceId, externalId)
        .first<{
          id: string;
          body_key: string | null;
          content_hash: string;
          indexed_hash: string | null;
          etag: string | null;
          last_modified: string | null;
          ingest_version: number;
          page_version: number | null;
        }>();
      return row
        ? {
            id: row.id,
            bodyKey: row.body_key,
            contentHash: row.content_hash,
            indexedHash: row.indexed_hash,
            etag: row.etag,
            lastModified: row.last_modified,
            ingestVersion: row.ingest_version,
            pageVersion: row.page_version,
          }
        : null;
    },

    /**
     * Stores what a sync learned about a page, only while `fence`'s run still
     * holds the source; false when the document does not exist or the run
     * no longer holds it.
     */
    async recordSyncCheck(
      sourceId: string,
      externalId: string,
      check: DocumentSyncCheck,
      fence: SyncRunFence,
    ): Promise<boolean> {
      const res = await prepare(
        db,
        `UPDATE documents SET etag = ?4, last_modified = ?5, sitemap_lastmod = ?6, sync_checked_at = ?7,
                page_version = COALESCE(?10, page_version)
          WHERE org_id = ?1 AND source_id = ?2 AND external_id = ?3
            AND ${syncRunHolds("?1", "?2", "?8", "?9")}`,
      )
        .bind(
          orgId,
          sourceId,
          externalId,
          check.etag,
          check.lastModified,
          check.sitemapLastmod,
          check.checkedAt,
          fence.runId,
          fence.now,
          check.pageVersion ?? null,
        )
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    /** Records which extraction version the stored text of these pages came from. */
    async setPageVersion(sourceId: string, externalIds: string[], version: number): Promise<void> {
      if (externalIds.length === 0) return;
      await prepare(
        db,
        `UPDATE documents SET page_version = ?3
          WHERE org_id = ?1 AND source_id = ?2
            AND external_id IN (SELECT value FROM json_each(?4))`,
      )
        .bind(orgId, sourceId, version, JSON.stringify([...new Set(externalIds)]))
        .run();
    },

    async upsert(input: UpsertDocumentInput): Promise<DocumentRow> {
      const saved = await upsertRow(input, undefined);
      if (!saved) throw new Error(`failed to upsert document ${input.externalId}`);
      return saved;
    },

    /**
     * As `upsert`, for a sync page: nothing is written unless `fence`'s run
     * still holds the source, checked in the same statement; null then.
     */
    async upsertForSync(
      input: UpsertDocumentInput,
      fence: SyncRunFence,
    ): Promise<DocumentRow | null> {
      return upsertRow(input, fence);
    },

    async updateMetadata(
      id: string,
      title: string,
      url: string,
      expectedContentHash: string,
      updatedAt?: number,
    ): Promise<boolean> {
      const res =
        updatedAt === undefined
          ? await prepare(
              db,
              "UPDATE documents SET title = ?4, url = ?5 WHERE org_id = ?1 AND id = ?2 AND content_hash = ?3",
            )
              .bind(orgId, id, expectedContentHash, title, url)
              .run()
          : await prepare(
              db,
              "UPDATE documents SET title = ?4, url = ?5, updated_at = ?6 WHERE org_id = ?1 AND id = ?2 AND content_hash = ?3",
            )
              .bind(orgId, id, expectedContentHash, title, url, updatedAt)
              .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async remove(id: string): Promise<boolean> {
      const res = await prepare(db, "DELETE FROM documents WHERE org_id = ?1 AND id = ?2")
        .bind(orgId, id)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    /**
     * Deletes these documents (cascading their chunks) in one atomic D1
     * batch, and returns the chunk ids of each document actually removed so
     * the caller can clean up vectors. Each group's chunk ids are read in the
     * same batch, just before its delete.
     */
    /**
     * Deletes these documents (cascading chunks) in one batch. With
     * `oweRepeated`, the same batch raises that source's `repeated_owed`
     * (see "Repeated blocks"), so the removal cannot be committed without
     * the reconciliation it owes being recorded.
     */
    async removeMany(
      ids: string[],
      options: { oweRepeated?: string | undefined } = {},
    ): Promise<Map<string, string[]>> {
      const removed = new Map<string, string[]>();
      if (ids.length === 0) return removed;
      const owe: D1PreparedStatement[] =
        options.oweRepeated === undefined
          ? []
          : [
              prepare(
                db,
                "UPDATE sources SET repeated_owed = repeated_owed + 1 WHERE org_id = ?1 AND id = ?2",
              ).bind(orgId, options.oweRepeated),
            ];
      const statements = inGroups(ids).flatMap((group) => [
        prepare(
          db,
          `SELECT id, document_id FROM chunks
            WHERE org_id = ?1 AND document_id IN (${placeholdersFrom(group.length, 2)})`,
        ).bind(orgId, ...group),
        prepare(
          db,
          `DELETE FROM documents WHERE org_id = ?1 AND id IN (${placeholdersFrom(group.length, 2)})
           RETURNING id`,
        ).bind(orgId, ...group),
      ]);
      const results = (await db.batch([...owe, ...statements])).slice(owe.length);
      for (let i = 0; i < results.length; i += 2) {
        const chunks = (results[i]?.results ?? []) as Array<{ id: string; document_id: string }>;
        for (const row of (results[i + 1]?.results ?? []) as Array<{ id: string }>) {
          removed.set(row.id, []);
        }
        for (const chunk of chunks) {
          removed.get(chunk.document_id)?.push(chunk.id);
        }
      }
      return removed;
    },

    async removeByExternalId(sourceId: string, externalId: string): Promise<boolean> {
      const res = await prepare(
        db,
        "DELETE FROM documents WHERE org_id = ?1 AND source_id = ?2 AND external_id = ?3",
      )
        .bind(orgId, sourceId, externalId)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async listChunks(documentId: string): Promise<ChunkRow[]> {
      const res = await prepare(
        db,
        `SELECT ${CHUNK_COLUMNS} FROM chunks WHERE org_id = ?1 AND document_id = ?2 ORDER BY ordinal ASC`,
      )
        .bind(orgId, documentId)
        .all<ChunkDbRow>();
      return res.results.map(mapChunk);
    },

    /**
     * Up to `limit` titles of the assistant's content (pages, pushed documents
     * and written answers), for the answer review to know what the site is
     * about. Titles only, never text. Read through `sources_assistant` and
     * `documents_identity`, and bounded by `limit`.
     */
    async titlesForAssistant(assistantId: string, limit: number): Promise<string[]> {
      const res = await prepare(
        db,
        `SELECT d.title AS title
           FROM sources s
           JOIN documents d ON d.org_id = s.org_id AND d.source_id = s.id
          WHERE s.org_id = ?1 AND s.assistant_id = ?2 AND trim(d.title) <> ''
          LIMIT ?3`,
      )
        .bind(orgId, assistantId, limit)
        .all<{ title: string }>();
      return res.results.map((row) => row.title);
    },

    async chunksByIds(assistantId: string, chunkIds: string[]): Promise<ResolvedChunkRow[]> {
      if (chunkIds.length === 0) return [];
      const placeholders = chunkIds.map((_, index) => `?${index + 3}`).join(", ");
      const res = await prepare(
        db,
        `SELECT c.id, c.document_id, c.text, c.heading_path, d.url, d.title, s.kind
         FROM chunks c
         JOIN documents d ON d.org_id = c.org_id AND d.id = c.document_id
         JOIN sources s ON s.org_id = d.org_id AND s.id = d.source_id
         WHERE c.org_id = ?1
           AND s.assistant_id = ?2
           AND c.id IN (${placeholders})`,
      )
        .bind(orgId, assistantId, ...chunkIds)
        .all<{
          id: string;
          document_id: string;
          text: string;
          heading_path: string;
          url: string;
          title: string;
          kind: "push" | "sitemap" | "entry";
        }>();
      return res.results.map((row) => ({
        id: row.id,
        documentId: row.document_id,
        text: row.text,
        headingPath: row.heading_path,
        url: row.url,
        title: row.title,
        sourceKind: row.kind,
      }));
    },

    /**
     * Records why the document's current content could not be indexed. Only
     * applies while `contentHash` is still the document's content: a newer
     * push or save replaces the hash, which makes the error stale.
     */
    /**
     * The assistant's documents whose current content is indexed, but by an
     * ingest version older than `version`: what a re-index rebuilds. A
     * document still owed its indexing is left out (it is queued already
     * and will be built by the current version). Bounded by `limit`, oldest
     * version first.
     */
    async listOutdated(
      assistantId: string,
      version: number,
      limit: number,
    ): Promise<Array<{ id: string; contentHash: string }>> {
      const res = await prepare(
        db,
        `SELECT d.id AS id, d.content_hash AS content_hash
           FROM sources s
           JOIN documents d ON d.org_id = s.org_id AND d.source_id = s.id
          WHERE s.org_id = ?1 AND s.assistant_id = ?2
            AND d.ingest_version < ?3 AND d.indexed_hash = d.content_hash
            AND d.body_key IS NOT NULL
          ORDER BY d.ingest_version ASC, d.id ASC
          LIMIT ?4`,
      )
        .bind(orgId, assistantId, version, limit)
        .all<{ id: string; content_hash: string }>();
      return res.results.map((row) => ({ id: row.id, contentHash: row.content_hash }));
    },

    /** How many documents `listOutdated` would return with no limit. */
    async countOutdated(assistantId: string, version: number): Promise<number> {
      const row = await prepare(
        db,
        `SELECT COUNT(*) AS total
           FROM sources s
           JOIN documents d ON d.org_id = s.org_id AND d.source_id = s.id
          WHERE s.org_id = ?1 AND s.assistant_id = ?2
            AND d.ingest_version < ?3 AND d.indexed_hash = d.content_hash
            AND d.body_key IS NOT NULL`,
      )
        .bind(orgId, assistantId, version)
        .first<{ total: number }>();
      return Number(row?.total ?? 0);
    },

    async markIndexError(id: string, contentHash: string, code: IndexErrorCode): Promise<boolean> {
      const res = await prepare(
        db,
        `UPDATE documents SET index_error = ?4, index_error_hash = ?3
         WHERE org_id = ?1 AND id = ?2 AND content_hash = ?3`,
      )
        .bind(orgId, id, contentHash, code)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async replaceChunks(
      documentId: string,
      chunks: ChunkInput[],
      expectedContentHash?: string,
      ingestVersion: number = INGEST_VERSION,
      options: CommitOptions = {},
    ): Promise<boolean> {
      if (expectedContentHash === undefined) {
        const stmts: D1PreparedStatement[] = [
          prepare(db, "DELETE FROM chunks WHERE org_id = ?1 AND document_id = ?2").bind(
            orgId,
            documentId,
          ),
          ...chunks.map((chunk) =>
            prepareInsert(
              db,
              `INSERT INTO chunks (id, org_id, document_id, ordinal, text, heading_path)
               VALUES (?2, ?1, ?3, ?4, ?5, ?6)`,
            ).bind(orgId, chunk.id, documentId, chunk.ordinal, chunk.text, chunk.headingPath),
          ),
        ];
        await db.batch(stmts);
        return true;
      }

      // One batch on purpose: the content-hash guard only protects the
      // commit if every insert runs in the same transaction. Each statement
      // binds at most 9 parameters (limit 100) and the largest document yields about
      // 900 chunks; Cloudflare documents that "a batch containing 2,000
      // statements executes in a single Worker invocation".
      // Source: https://developers.cloudflare.com/d1/platform/limits/ — checked 2026-11-14
      //
      // The guard admits content not yet indexed, content indexed by an
      // older ingest version (a re-index of unchanged text), and a page
      // built with other repeated blocks than this build's (`repeated_key`;
      // see "Repeated blocks"). Two re-index messages for one document with
      // the same result cannot both commit: the first sets the version and
      // key, and the second's guard is then false.
      //
      // A build that keeps the stored chunks also requires them to be the
      // ones it compared (`kept`, by id: every build inserts new ids), in
      // every statement of the batch, so another build's chunks committed
      // in between are not kept under this build's key.
      const keep = options.keepChunks;
      const keptParam = keep === undefined ? [] : [JSON.stringify([...new Set(keep)])];
      // The guard, with the kept-chunks check reading its id list from `?slot`.
      const guard = (slot: number) =>
        `content_hash = ?3 AND (indexed_hash IS NULL OR indexed_hash != ?3 OR ingest_version < ?4 OR repeated_key IS NOT ?5)` +
        (keep === undefined
          ? ""
          : ` AND (SELECT COUNT(*) FROM chunks WHERE org_id = ?1 AND document_id = ?2) = json_array_length(?${slot})
              AND NOT EXISTS (SELECT 1 FROM chunks WHERE org_id = ?1 AND document_id = ?2
                               AND id NOT IN (SELECT value FROM json_each(?${slot})))`);
      const key = options.blocks?.key ?? null;
      const stmts: D1PreparedStatement[] = [];
      if (keep === undefined) {
        // Nothing kept, so the guard has no kept-chunks check here.
        const owed = guard(0);
        stmts.push(
          prepare(
            db,
            `DELETE FROM chunks
             WHERE org_id = ?1 AND document_id = ?2
               AND EXISTS (SELECT 1 FROM documents WHERE org_id = ?1 AND id = ?2 AND ${owed})`,
          ).bind(orgId, documentId, expectedContentHash, ingestVersion, key),
          ...chunks.map((chunk) =>
            prepareInsert(
              db,
              `INSERT INTO chunks (id, org_id, document_id, ordinal, text, heading_path)
               SELECT ?6, ?1, ?2, ?7, ?8, ?9
               WHERE EXISTS (SELECT 1 FROM documents WHERE org_id = ?1 AND id = ?2 AND ${owed})`,
            ).bind(
              orgId,
              documentId,
              expectedContentHash,
              ingestVersion,
              key,
              chunk.id,
              chunk.ordinal,
              chunk.text,
              chunk.headingPath,
            ),
          ),
        );
      }
      if (options.blocks !== undefined) {
        // Replaced as a set; the triggers on `document_blocks` keep the
        // source's counts (`source_blocks`) in step in the same batch.
        stmts.push(
          prepare(
            db,
            `DELETE FROM document_blocks
             WHERE org_id = ?1 AND document_id = ?2
               AND EXISTS (SELECT 1 FROM documents WHERE org_id = ?1 AND id = ?2 AND ${guard(6)})`,
          ).bind(orgId, documentId, expectedContentHash, ingestVersion, key, ...keptParam),
          prepareInsert(
            db,
            `INSERT INTO document_blocks (org_id, source_id, document_id, block_hash)
             SELECT ?1, ?6, ?2, value FROM json_each(?7)
             WHERE EXISTS (SELECT 1 FROM documents WHERE org_id = ?1 AND id = ?2 AND source_id = ?6 AND ${guard(8)})`,
          ).bind(
            orgId,
            documentId,
            expectedContentHash,
            ingestVersion,
            key,
            options.blocks.sourceId,
            JSON.stringify([...new Set(options.blocks.hashes)]),
            ...keptParam,
          ),
        );
      }
      stmts.push(
        prepare(
          db,
          `UPDATE documents
           SET indexed_hash = ?3, ingest_version = ?4, repeated_key = ?5
           WHERE org_id = ?1 AND id = ?2 AND ${guard(6)}`,
        ).bind(orgId, documentId, expectedContentHash, ingestVersion, key, ...keptParam),
      );
      const results = await db.batch(stmts);
      return (results[results.length - 1]?.meta.changes ?? 0) > 0;
    },
  };
}
