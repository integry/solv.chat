import { prepare, prepareInsert } from "./sql.js";

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
}

export interface ExistingDocumentState {
  id: string;
  url: string;
  contentHash: string;
  bodyKey: string | null;
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

export interface ChunkInput {
  id: string;
  ordinal: number;
  text: string;
  headingPath: string;
}

const DOC_COLUMNS =
  "id, org_id, source_id, external_id, url, title, content_hash, indexed_hash, body_key, updated_at";
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

    async existingFor(
      sourceId: string,
      externalIds: string[],
    ): Promise<Map<string, ExistingDocumentState>> {
      const result = new Map<string, ExistingDocumentState>();
      if (externalIds.length === 0) return result;
      const wanted = new Set(externalIds);
      const rows = await prepare(
        db,
        "SELECT id, external_id, url, content_hash, body_key FROM documents WHERE org_id = ?1 AND source_id = ?2",
      )
        .bind(orgId, sourceId)
        .all<{
          id: string;
          external_id: string;
          url: string;
          content_hash: string;
          body_key: string | null;
        }>();
      for (const row of rows.results) {
        if (wanted.has(row.external_id)) {
          result.set(row.external_id, {
            id: row.id,
            url: row.url,
            contentHash: row.content_hash,
            bodyKey: row.body_key,
          });
        }
      }
      return result;
    },

    async upsert(input: UpsertDocumentInput): Promise<DocumentRow> {
      const saved = await prepareInsert(
        db,
        `INSERT INTO documents (
           id, org_id, source_id, external_id, url, title, content_hash, body_key, updated_at
         )
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(org_id, source_id, external_id) DO UPDATE SET
           url = excluded.url,
           title = excluded.title,
           content_hash = excluded.content_hash,
           body_key = excluded.body_key,
           updated_at = excluded.updated_at
         RETURNING ${DOC_COLUMNS}`,
      )
        .bind(
          orgId,
          input.id,
          input.sourceId,
          input.externalId,
          input.url,
          input.title,
          input.contentHash,
          input.bodyKey ?? null,
          input.updatedAt,
        )
        .first<DocumentDbRow>();

      if (!saved) {
        throw new Error(`failed to upsert document ${input.externalId}`);
      }
      return mapDocument(saved);
    },

    async updateMetadata(
      id: string,
      title: string,
      url: string,
      updatedAt?: number,
    ): Promise<boolean> {
      const res =
        updatedAt === undefined
          ? await prepare(
              db,
              "UPDATE documents SET title = ?3, url = ?4 WHERE org_id = ?1 AND id = ?2",
            )
              .bind(orgId, id, title, url)
              .run()
          : await prepare(
              db,
              "UPDATE documents SET title = ?3, url = ?4, updated_at = ?5 WHERE org_id = ?1 AND id = ?2",
            )
              .bind(orgId, id, title, url, updatedAt)
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

    async chunksByIds(assistantId: string, chunkIds: string[]): Promise<ResolvedChunkRow[]> {
      if (chunkIds.length === 0) return [];
      const placeholders = chunkIds.map((_, index) => `?${index + 3}`).join(", ");
      const res = await prepare(
        db,
        `SELECT c.id, c.document_id, c.text, c.heading_path, d.url, d.title
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
        }>();
      return res.results.map((row) => ({
        id: row.id,
        documentId: row.document_id,
        text: row.text,
        headingPath: row.heading_path,
        url: row.url,
        title: row.title,
      }));
    },

    async replaceChunks(
      documentId: string,
      chunks: ChunkInput[],
      expectedContentHash?: string,
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

      const stmts: D1PreparedStatement[] = [
        prepare(
          db,
          `DELETE FROM chunks
           WHERE org_id = ?1 AND document_id = ?2
             AND EXISTS (
               SELECT 1 FROM documents
               WHERE org_id = ?1 AND id = ?2 AND content_hash = ?3
                 AND (indexed_hash IS NULL OR indexed_hash != ?3)
             )`,
        ).bind(orgId, documentId, expectedContentHash),
        ...chunks.map((chunk) =>
          prepareInsert(
            db,
            `INSERT INTO chunks (id, org_id, document_id, ordinal, text, heading_path)
             SELECT ?2, ?1, ?3, ?4, ?5, ?6
             WHERE EXISTS (
               SELECT 1 FROM documents
               WHERE org_id = ?1 AND id = ?3 AND content_hash = ?7
                 AND (indexed_hash IS NULL OR indexed_hash != ?7)
             )`,
          ).bind(
            orgId,
            chunk.id,
            documentId,
            chunk.ordinal,
            chunk.text,
            chunk.headingPath,
            expectedContentHash,
          ),
        ),
        prepare(
          db,
          `UPDATE documents
           SET indexed_hash = ?3
           WHERE org_id = ?1 AND id = ?2 AND content_hash = ?3
             AND (indexed_hash IS NULL OR indexed_hash != ?3)`,
        ).bind(orgId, documentId, expectedContentHash),
      ];
      const results = await db.batch(stmts);
      return (results[results.length - 1]?.meta.changes ?? 0) > 0;
    },
  };
}
