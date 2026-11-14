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

const DOC_COLUMNS = "id, org_id, source_id, external_id, url, title, content_hash, updated_at";
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

    async hashesFor(sourceId: string, externalIds: string[]): Promise<Map<string, string>> {
      const result = new Map<string, string>();
      if (externalIds.length === 0) return result;
      const wanted = new Set(externalIds);
      const rows = await prepare(
        db,
        "SELECT external_id, content_hash FROM documents WHERE org_id = ?1 AND source_id = ?2",
      )
        .bind(orgId, sourceId)
        .all<{ external_id: string; content_hash: string }>();
      for (const row of rows.results) {
        if (wanted.has(row.external_id)) {
          result.set(row.external_id, row.content_hash);
        }
      }
      return result;
    },

    async upsert(input: UpsertDocumentInput): Promise<DocumentRow> {
      await prepareInsert(
        db,
        `INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(org_id, source_id, external_id) DO UPDATE SET
           url = excluded.url,
           title = excluded.title,
           content_hash = excluded.content_hash,
           updated_at = excluded.updated_at`,
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
      };
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

    async replaceChunks(documentId: string, chunks: ChunkInput[]): Promise<void> {
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
    },
  };
}
