import { prepare, prepareInsert, safeJsonArray } from "./sql.js";

interface Row {
  id: string;
  org_id: string;
  name: string;
  public_key: string;
  allowed_origins: string;
  ingest_key_hash: string | null;
  created_at: number;
}

export interface AssistantRow {
  id: string;
  orgId: string;
  name: string;
  publicKey: string;
  allowedOrigins: string[];
  hasIngestKey: boolean;
  createdAt: number;
}

export interface CreateAssistantInput {
  id: string;
  name: string;
  publicKey: string;
  allowedOrigins: string[];
  createdAt: number;
  ingestKeyHash?: string | null;
}

export interface UpdateAssistantInput {
  name: string;
  allowedOrigins: string[];
}

const COLUMNS = "id, org_id, name, public_key, allowed_origins, ingest_key_hash, created_at";

const map = (row: Row): AssistantRow => ({
  id: row.id,
  orgId: row.org_id,
  name: row.name,
  publicKey: row.public_key,
  allowedOrigins: safeJsonArray<string>(row.allowed_origins),
  hasIngestKey: row.ingest_key_hash !== null,
  createdAt: row.created_at,
});

/** Tenant-scoped data access for `assistants`. */
export function assistantsFor(db: D1Database, orgId: string) {
  return {
    async list(): Promise<AssistantRow[]> {
      const res = await prepare(
        db,
        `SELECT ${COLUMNS} FROM assistants WHERE org_id = ?1 ORDER BY created_at ASC`,
      )
        .bind(orgId)
        .all<Row>();
      return res.results.map(map);
    },

    async get(id: string): Promise<AssistantRow | null> {
      const row = await prepare(
        db,
        `SELECT ${COLUMNS} FROM assistants WHERE org_id = ?1 AND id = ?2`,
      )
        .bind(orgId, id)
        .first<Row>();
      return row ? map(row) : null;
    },

    async getByPublicKey(publicKey: string): Promise<AssistantRow | null> {
      const row = await prepare(
        db,
        `SELECT ${COLUMNS} FROM assistants WHERE org_id = ?1 AND public_key = ?2`,
      )
        .bind(orgId, publicKey)
        .first<Row>();
      return row ? map(row) : null;
    },

    async create(input: CreateAssistantInput): Promise<AssistantRow> {
      const ingestKeyHash = input.ingestKeyHash ?? null;
      await prepareInsert(
        db,
        `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, ingest_key_hash, created_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)`,
      )
        .bind(
          orgId,
          input.id,
          input.name,
          input.publicKey,
          JSON.stringify(input.allowedOrigins),
          ingestKeyHash,
          input.createdAt,
        )
        .run();

      return {
        id: input.id,
        orgId,
        name: input.name,
        publicKey: input.publicKey,
        allowedOrigins: [...input.allowedOrigins],
        hasIngestKey: ingestKeyHash !== null,
        createdAt: input.createdAt,
      };
    },

    statements: {
      insert: (input: CreateAssistantInput): D1PreparedStatement =>
        prepareInsert(
          db,
          `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, ingest_key_hash, created_at)
           VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)`,
        ).bind(
          orgId,
          input.id,
          input.name,
          input.publicKey,
          JSON.stringify(input.allowedOrigins),
          input.ingestKeyHash ?? null,
          input.createdAt,
        ),
    },

    async update(id: string, input: UpdateAssistantInput): Promise<boolean> {
      const res = await prepare(
        db,
        "UPDATE assistants SET name = ?3, allowed_origins = ?4 WHERE org_id = ?1 AND id = ?2",
      )
        .bind(orgId, id, input.name, JSON.stringify(input.allowedOrigins))
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async setIngestKeyHash(id: string, hash: string | null): Promise<boolean> {
      const res = await prepare(
        db,
        "UPDATE assistants SET ingest_key_hash = ?3 WHERE org_id = ?1 AND id = ?2",
      )
        .bind(orgId, id, hash)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    /**
     * When the owner first tried a question in "Try it", and when the widget
     * first loaded on an allowed origin. Null until it happens.
     */
    async milestones(
      id: string,
    ): Promise<{ triedAt: number | null; widgetSeenAt: number | null } | null> {
      const row = await prepare(
        db,
        "SELECT tried_at, widget_seen_at FROM assistants WHERE org_id = ?1 AND id = ?2",
      )
        .bind(orgId, id)
        .first<{ tried_at: number | null; widget_seen_at: number | null }>();
      return row ? { triedAt: row.tried_at, widgetSeenAt: row.widget_seen_at } : null;
    },

    /** Records the first "Try it" question. Later calls change nothing. */
    async markTried(id: string, at: number): Promise<void> {
      await prepare(
        db,
        "UPDATE assistants SET tried_at = ?3 WHERE org_id = ?1 AND id = ?2 AND tried_at IS NULL",
      )
        .bind(orgId, id, at)
        .run();
    },

    /** Records the first widget load on the owner's site. Later calls change nothing. */
    async markWidgetSeen(id: string, at: number): Promise<void> {
      await prepare(
        db,
        "UPDATE assistants SET widget_seen_at = ?3 WHERE org_id = ?1 AND id = ?2 AND widget_seen_at IS NULL",
      )
        .bind(orgId, id, at)
        .run();
    },

    async remove(id: string): Promise<boolean> {
      const res = await prepare(db, "DELETE FROM assistants WHERE org_id = ?1 AND id = ?2")
        .bind(orgId, id)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },
  };
}
