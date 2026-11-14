import type { SourceKind } from "@solvchat/core";
import { prepare, prepareInsert, safeJsonObject } from "./sql.js";

interface Row {
  id: string;
  org_id: string;
  assistant_id: string;
  kind: SourceKind;
  label: string;
  settings: string;
  created_at: number;
}

export interface SourceRow {
  id: string;
  orgId: string;
  assistantId: string;
  kind: SourceKind;
  label: string;
  settings: Record<string, unknown>;
  createdAt: number;
}

export interface CreateSourceInput {
  id: string;
  assistantId: string;
  kind: SourceKind;
  label: string;
  settings: Record<string, unknown>;
  createdAt: number;
}

export interface UpdateSourceInput {
  label: string;
  settings: Record<string, unknown>;
}

const COLUMNS = "id, org_id, assistant_id, kind, label, settings, created_at";

const map = (row: Row): SourceRow => ({
  id: row.id,
  orgId: row.org_id,
  assistantId: row.assistant_id,
  kind: row.kind,
  label: row.label,
  settings: safeJsonObject(row.settings),
  createdAt: row.created_at,
});

/** Tenant-scoped data access for `sources`. */
export function sourcesFor(db: D1Database, orgId: string) {
  return {
    async list(assistantId: string): Promise<SourceRow[]> {
      const res = await prepare(
        db,
        `SELECT ${COLUMNS} FROM sources WHERE org_id = ?1 AND assistant_id = ?2 ORDER BY created_at ASC`,
      )
        .bind(orgId, assistantId)
        .all<Row>();
      return res.results.map(map);
    },

    async get(id: string): Promise<SourceRow | null> {
      const row = await prepare(db, `SELECT ${COLUMNS} FROM sources WHERE org_id = ?1 AND id = ?2`)
        .bind(orgId, id)
        .first<Row>();
      return row ? map(row) : null;
    },

    async getDefaultPush(assistantId: string): Promise<SourceRow | null> {
      const row = await prepare(
        db,
        `SELECT ${COLUMNS} FROM sources WHERE org_id = ?1 AND assistant_id = ?2 AND kind = 'push' AND is_default = 1`,
      )
        .bind(orgId, assistantId)
        .first<Row>();
      return row ? map(row) : null;
    },

    async getOrCreateDefaultPush(input: {
      id: string;
      assistantId: string;
      createdAt: number;
    }): Promise<SourceRow> {
      await prepareInsert(
        db,
        `INSERT INTO sources (id, org_id, assistant_id, kind, label, settings, is_default, created_at)
         VALUES (?2, ?1, ?3, 'push', 'Push', '{}', 1, ?4)
         ON CONFLICT(org_id, assistant_id) WHERE kind = 'push' AND is_default = 1 DO NOTHING`,
      )
        .bind(orgId, input.id, input.assistantId, input.createdAt)
        .run();

      const resolved = await this.getDefaultPush(input.assistantId);
      if (!resolved) {
        throw new Error(`failed to resolve default push source for ${input.assistantId}`);
      }
      return resolved;
    },

    async create(input: CreateSourceInput): Promise<SourceRow> {
      await prepareInsert(
        db,
        `INSERT INTO sources (id, org_id, assistant_id, kind, label, settings, created_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)`,
      )
        .bind(
          orgId,
          input.id,
          input.assistantId,
          input.kind,
          input.label,
          JSON.stringify(input.settings),
          input.createdAt,
        )
        .run();

      return {
        id: input.id,
        orgId,
        assistantId: input.assistantId,
        kind: input.kind,
        label: input.label,
        settings: input.settings,
        createdAt: input.createdAt,
      };
    },

    async update(id: string, input: UpdateSourceInput): Promise<boolean> {
      const res = await prepare(
        db,
        "UPDATE sources SET label = ?3, settings = ?4 WHERE org_id = ?1 AND id = ?2",
      )
        .bind(orgId, id, input.label, JSON.stringify(input.settings))
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async remove(id: string): Promise<boolean> {
      const res = await prepare(db, "DELETE FROM sources WHERE org_id = ?1 AND id = ?2")
        .bind(orgId, id)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },
  };
}
