import { prepare, prepareInsert } from "./sql.js";

interface DocumentDbRow {
  id: string;
  org_id: string;
  source_id: string;
  external_id: string;
  url: string;
  title: string;
  content_hash: string;
  updated_at: number;
  revision: number;
  stored_revision: number;
  enqueued_revision: number;
  indexed_revision: number;
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
  updatedAt: number;
  revision: number;
  storedRevision: number;
  enqueuedRevision: number;
  indexedRevision: number;
}

export interface PushState {
  contentHash: string;
  complete: boolean;
}

export interface ChunkRow {
  id: string;
  orgId: string;
  documentId: string;
  ordinal: number;
  text: string;
  headingPath: string;
}

export interface UpsertDocumentInput {
  id: string;
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  contentHash: string;
  updatedAt: number;
}

export interface ChunkInput {
  id: string;
  ordinal: number;
  text: string;
  headingPath: string;
}

const DOC_COLUMNS =
  "id, org_id, source_id, external_id, url, title, content_hash, updated_at, revision, stored_revision, enqueued_revision, indexed_revision";
const CHUNK_COLUMNS = "id, org_id, document_id, ordinal, text, heading_path";

const mapDocument = (row: DocumentDbRow): DocumentRow => ({
  id: row.id,
  orgId: row.org_id,
  sourceId: row.source_id,
  externalId: row.external_id,
  url: row.url,
  title: row.title,
  contentHash: row.content_hash,
  updatedAt: row.updated_at,
  revision: row.revision,
  storedRevision: row.stored_revision,
  enqueuedRevision: row.enqueued_revision,
  indexedRevision: row.indexed_revision,
});

const mapChunk = (row: ChunkDbRow): ChunkRow => ({
  id: row.id,
  orgId: row.org_id,
  documentId: row.document_id,
  ordinal: row.ordinal,
  text: row.text,
  headingPath: row.heading_path,
});

/** Tenant-scoped data access for `documents` and `chunks`. */
export function documentsFor(db: D1Database, orgId: string) {
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

    async get(id: string): Promise<DocumentRow | null> {
      const row = await prepare(
        db,
        `SELECT ${DOC_COLUMNS} FROM documents WHERE org_id = ?1 AND id = ?2`,
      )
        .bind(orgId, id)
        .first<DocumentDbRow>();
      return row ? mapDocument(row) : null;
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

    async pushStatesFor(sourceId: string, externalIds: string[]): Promise<Map<string, PushState>> {
      const result = new Map<string, PushState>();
      if (externalIds.length === 0) return result;
      const wanted = new Set(externalIds);
      const rows = await prepare(
        db,
        "SELECT external_id, content_hash, revision, stored_revision, enqueued_revision FROM documents WHERE org_id = ?1 AND source_id = ?2",
      )
        .bind(orgId, sourceId)
        .all<{
          external_id: string;
          content_hash: string;
          revision: number;
          stored_revision: number;
          enqueued_revision: number;
        }>();
      for (const row of rows.results) {
        if (wanted.has(row.external_id)) {
          result.set(row.external_id, {
            contentHash: row.content_hash,
            complete: row.stored_revision >= row.revision && row.enqueued_revision >= row.revision,
          });
        }
      }
      return result;
    },

    async upsert(input: UpsertDocumentInput): Promise<DocumentRow> {
      await prepareInsert(
        db,
        `INSERT INTO documents (
           id, org_id, source_id, external_id, url, title, content_hash, updated_at,
           revision, stored_revision, enqueued_revision, indexed_revision
         )
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, 1, 0, 0, 0)
         ON CONFLICT(org_id, source_id, external_id) DO UPDATE SET
           url = excluded.url,
           title = excluded.title,
           content_hash = excluded.content_hash,
           updated_at = excluded.updated_at,
           revision = CASE
             WHEN documents.content_hash != excluded.content_hash THEN documents.revision + 1
             ELSE documents.revision
           END`,
      )
        .bind(
          orgId,
          input.id,
          input.sourceId,
          input.externalId,
          input.url,
          input.title,
          input.contentHash,
          input.updatedAt,
        )
        .run();

      const saved = await this.getByExternalId(input.sourceId, input.externalId);
      if (saved) return saved;

      return {
        id: input.id,
        orgId,
        sourceId: input.sourceId,
        externalId: input.externalId,
        url: input.url,
        title: input.title,
        contentHash: input.contentHash,
        updatedAt: input.updatedAt,
        revision: 1,
        storedRevision: 0,
        enqueuedRevision: 0,
        indexedRevision: 0,
      };
    },

    async markBodyStored(id: string, revision: number): Promise<void> {
      await prepare(
        db,
        "UPDATE documents SET stored_revision = MAX(stored_revision, ?3) WHERE org_id = ?1 AND id = ?2 AND revision = ?3",
      )
        .bind(orgId, id, revision)
        .run();
    },

    async markEnqueued(id: string, revision: number): Promise<void> {
      await prepare(
        db,
        "UPDATE documents SET enqueued_revision = MAX(enqueued_revision, ?3) WHERE org_id = ?1 AND id = ?2 AND revision = ?3",
      )
        .bind(orgId, id, revision)
        .run();
    },

    async updateMetadata(id: string, title: string, url: string): Promise<boolean> {
      const res = await prepare(
        db,
        "UPDATE documents SET title = ?3, url = ?4 WHERE org_id = ?1 AND id = ?2",
      )
        .bind(orgId, id, title, url)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async remove(id: string): Promise<boolean> {
      const res = await prepare(db, "DELETE FROM documents WHERE org_id = ?1 AND id = ?2")
        .bind(orgId, id)
        .run();
      return (res.meta.changes ?? 0) > 0;
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

    async listPendingVectors(documentId: string, revision: number): Promise<string[]> {
      const res = await prepare(
        db,
        "SELECT chunk_id FROM pending_vectors WHERE org_id = ?1 AND document_id = ?2 AND revision = ?3 ORDER BY ordinal ASC",
      )
        .bind(orgId, documentId, revision)
        .all<{ chunk_id: string }>();
      return res.results.map((row) => row.chunk_id);
    },

    async listAllPendingVectors(documentId: string): Promise<string[]> {
      const res = await prepare(
        db,
        "SELECT chunk_id FROM pending_vectors WHERE org_id = ?1 AND document_id = ?2",
      )
        .bind(orgId, documentId)
        .all<{ chunk_id: string }>();
      return res.results.map((row) => row.chunk_id);
    },

    async savePendingVectors(
      documentId: string,
      revision: number,
      chunkIds: string[],
    ): Promise<boolean> {
      const stmts: D1PreparedStatement[] = [
        prepare(
          db,
          "UPDATE documents SET updated_at = updated_at WHERE org_id = ?1 AND id = ?2 AND revision = ?3",
        ).bind(orgId, documentId, revision),
        ...chunkIds.map((chunkId, ordinal) =>
          prepareInsert(
            db,
            `INSERT OR IGNORE INTO pending_vectors (chunk_id, org_id, document_id, revision, ordinal)
             SELECT ?2, ?1, ?3, ?4, ?5
             WHERE EXISTS (SELECT 1 FROM documents WHERE org_id = ?1 AND id = ?3 AND revision = ?4)`,
          ).bind(orgId, chunkId, documentId, revision, ordinal),
        ),
      ];
      const results = await db.batch(stmts);
      return (results[0]?.meta.changes ?? 0) > 0;
    },

    async clearPendingVectors(documentId: string, revision: number): Promise<void> {
      await prepare(
        db,
        "DELETE FROM pending_vectors WHERE org_id = ?1 AND document_id = ?2 AND revision = ?3",
      )
        .bind(orgId, documentId, revision)
        .run();
    },

    async listStaleVectors(documentId: string): Promise<string[]> {
      const res = await prepare(
        db,
        "SELECT chunk_id FROM stale_vectors WHERE org_id = ?1 AND document_id = ?2",
      )
        .bind(orgId, documentId)
        .all<{ chunk_id: string }>();
      return res.results.map((row) => row.chunk_id);
    },

    async clearStaleVectors(documentId: string, chunkIds: string[]): Promise<void> {
      if (chunkIds.length === 0) return;
      const stmts = chunkIds.map((chunkId) =>
        prepare(
          db,
          "DELETE FROM stale_vectors WHERE org_id = ?1 AND document_id = ?2 AND chunk_id = ?3",
        ).bind(orgId, documentId, chunkId),
      );
      await db.batch(stmts);
    },

    async replaceChunks(
      documentId: string,
      chunks: ChunkInput[],
      expectedRevision?: number,
    ): Promise<boolean> {
      if (expectedRevision === undefined) {
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

      const stmts: D1PreparedStatement[] = [
        prepare(
          db,
          "UPDATE documents SET indexed_revision = ?3 WHERE org_id = ?1 AND id = ?2 AND revision = ?3",
        ).bind(orgId, documentId, expectedRevision),
        prepareInsert(
          db,
          `INSERT OR IGNORE INTO stale_vectors (chunk_id, org_id, document_id)
           SELECT id, org_id, document_id FROM chunks
           WHERE org_id = ?1 AND document_id = ?2
             AND EXISTS (SELECT 1 FROM documents WHERE org_id = ?1 AND id = ?2 AND revision = ?3)`,
        ).bind(orgId, documentId, expectedRevision),
        prepareInsert(
          db,
          `INSERT OR IGNORE INTO stale_vectors (chunk_id, org_id, document_id)
           SELECT chunk_id, org_id, document_id FROM pending_vectors
           WHERE org_id = ?1 AND document_id = ?2 AND revision != ?3
             AND EXISTS (SELECT 1 FROM documents WHERE org_id = ?1 AND id = ?2 AND revision = ?3)`,
        ).bind(orgId, documentId, expectedRevision),
        prepare(
          db,
          `DELETE FROM pending_vectors
           WHERE org_id = ?1 AND document_id = ?2 AND revision <= ?3
             AND EXISTS (SELECT 1 FROM documents WHERE org_id = ?1 AND id = ?2 AND revision = ?3)`,
        ).bind(orgId, documentId, expectedRevision),
        prepare(
          db,
          `DELETE FROM chunks
           WHERE org_id = ?1 AND document_id = ?2
             AND EXISTS (SELECT 1 FROM documents WHERE org_id = ?1 AND id = ?2 AND revision = ?3)`,
        ).bind(orgId, documentId, expectedRevision),
        ...chunks.map((chunk) =>
          prepareInsert(
            db,
            `INSERT INTO chunks (id, org_id, document_id, ordinal, text, heading_path)
             SELECT ?2, ?1, ?3, ?4, ?5, ?6
             WHERE EXISTS (SELECT 1 FROM documents WHERE org_id = ?1 AND id = ?3 AND revision = ?7)`,
          ).bind(
            orgId,
            chunk.id,
            documentId,
            chunk.ordinal,
            chunk.text,
            chunk.headingPath,
            expectedRevision,
          ),
        ),
      ];
      const results = await db.batch(stmts);
      return (results[0]?.meta.changes ?? 0) > 0;
    },
  };
}
