import { defaultVersionConfig, parseVersionConfig, type VersionConfig } from "@solvchat/core";
import { prepare, prepareInsert, safeJson } from "./sql.js";

export type VersionState = "draft" | "published" | "archived";

interface Row {
  id: string;
  org_id: string;
  assistant_id: string;
  state: VersionState;
  config: string;
  created_at: number;
  published_at: number | null;
}

export interface VersionRow {
  id: string;
  orgId: string;
  assistantId: string;
  state: VersionState;
  config: VersionConfig;
  createdAt: number;
  publishedAt: number | null;
}

export interface CreateDraftInput {
  id: string;
  assistantId: string;
  config: VersionConfig;
  createdAt: number;
}

const COLUMNS = "id, org_id, assistant_id, state, config, created_at, published_at";

const map = (row: Row): VersionRow => {
  const parsed = parseVersionConfig(safeJson(row.config));
  return {
    id: row.id,
    orgId: row.org_id,
    assistantId: row.assistant_id,
    state: row.state,
    // A stored config that no longer parses (a later schema tightened a
    // field) falls back to defaults rather than taking the admin down.
    config: parsed.ok ? parsed.value : defaultVersionConfig(),
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
};

/** Tenant-scoped data access for `assistant_versions`. */
export function versionsFor(db: D1Database, orgId: string) {
  const one = async (sql: string, ...args: unknown[]): Promise<VersionRow | null> => {
    const row = await prepare(db, sql)
      .bind(orgId, ...args)
      .first<Row>();
    return row ? map(row) : null;
  };

  const many = async (sql: string, ...args: unknown[]): Promise<VersionRow[]> => {
    const res = await prepare(db, sql)
      .bind(orgId, ...args)
      .all<Row>();
    return res.results.map(map);
  };

  return {
    get: (id: string) =>
      one(`SELECT ${COLUMNS} FROM assistant_versions WHERE org_id = ?1 AND id = ?2`, id),

    draft: (assistantId: string) =>
      one(
        `SELECT ${COLUMNS} FROM assistant_versions WHERE org_id = ?1 AND assistant_id = ?2 AND state = 'draft'`,
        assistantId,
      ),

    published: (assistantId: string) =>
      one(
        `SELECT ${COLUMNS} FROM assistant_versions WHERE org_id = ?1 AND assistant_id = ?2 AND state = 'published'`,
        assistantId,
      ),

    history: (assistantId: string) =>
      many(
        `SELECT ${COLUMNS} FROM assistant_versions WHERE org_id = ?1 AND assistant_id = ?2 ORDER BY created_at DESC LIMIT 100`,
        assistantId,
      ),

    async createDraft(input: CreateDraftInput): Promise<VersionRow> {
      await prepareInsert(
        db,
        `INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at)
         VALUES (?2, ?1, ?3, 'draft', ?4, ?5, NULL)`,
      )
        .bind(orgId, input.id, input.assistantId, JSON.stringify(input.config), input.createdAt)
        .run();

      return {
        id: input.id,
        orgId,
        assistantId: input.assistantId,
        state: "draft",
        config: input.config,
        createdAt: input.createdAt,
        publishedAt: null,
      };
    },

    async updateDraft(assistantId: string, config: VersionConfig): Promise<boolean> {
      const res = await prepare(
        db,
        "UPDATE assistant_versions SET config = ?3 WHERE org_id = ?1 AND assistant_id = ?2 AND state = 'draft'",
      )
        .bind(orgId, assistantId, JSON.stringify(config))
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async remove(id: string): Promise<boolean> {
      const res = await prepare(db, "DELETE FROM assistant_versions WHERE org_id = ?1 AND id = ?2")
        .bind(orgId, id)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    /**
     * Statements bound to `orgId` so callers can execute publish/rollback in one
     * `batch()` call without holding a `D1Database`.
     */
    statements: {
      archivePublished: (assistantId: string): D1PreparedStatement =>
        prepare(
          db,
          "UPDATE assistant_versions SET state = 'archived' WHERE org_id = ?1 AND assistant_id = ?2 AND state = 'published'",
        ).bind(orgId, assistantId),

      markPublished: (versionId: string, publishedAt: number): D1PreparedStatement =>
        prepare(
          db,
          "UPDATE assistant_versions SET state = 'published', published_at = ?3 WHERE org_id = ?1 AND id = ?2",
        ).bind(orgId, versionId, publishedAt),

      insertDraft: (input: CreateDraftInput): D1PreparedStatement =>
        prepareInsert(
          db,
          `INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at)
           VALUES (?2, ?1, ?3, 'draft', ?4, ?5, NULL)`,
        ).bind(orgId, input.id, input.assistantId, JSON.stringify(input.config), input.createdAt),
    },

    async batch(stmts: D1PreparedStatement[]): Promise<void> {
      if (stmts.length === 0) return;
      await db.batch(stmts);
    },
  };
}
