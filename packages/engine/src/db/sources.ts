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

export interface SourceWithStatsRow extends SourceRow {
  documentCount: number;
  lastUpdatedAt: number | null;
}

interface StatsRow extends Row {
  document_count: number;
  last_updated_at: number | null;
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
  async function getDefaultByKind(
    assistantId: string,
    kind: "push" | "entry",
  ): Promise<SourceRow | null> {
    const row = await prepare(
      db,
      `SELECT ${COLUMNS} FROM sources WHERE org_id = ?1 AND assistant_id = ?2 AND kind = ?3 AND is_default = 1`,
    )
      .bind(orgId, assistantId, kind)
      .first<Row>();
    return row ? map(row) : null;
  }

  async function getOrCreateDefaultByKind(
    kind: "push" | "entry",
    label: string,
    input: { id: string; assistantId: string; createdAt: number },
  ): Promise<SourceRow> {
    const conflictTarget =
      kind === "push"
        ? "ON CONFLICT(org_id, assistant_id) WHERE kind = 'push' AND is_default = 1 DO NOTHING"
        : "ON CONFLICT(org_id, assistant_id) WHERE kind = 'entry' AND is_default = 1 DO NOTHING";
    await prepareInsert(
      db,
      `INSERT INTO sources (id, org_id, assistant_id, kind, label, settings, is_default, created_at)
       VALUES (?2, ?1, ?3, ?4, ?5, '{}', 1, ?6)
       ${conflictTarget}`,
    )
      .bind(orgId, input.id, input.assistantId, kind, label, input.createdAt)
      .run();

    const resolved = await getDefaultByKind(input.assistantId, kind);
    if (!resolved) {
      throw new Error(`failed to resolve default ${kind} source for ${input.assistantId}`);
    }
    return resolved;
  }

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

    async listWithStats(assistantId: string): Promise<SourceWithStatsRow[]> {
      const res = await prepare(
        db,
        `SELECT s.id, s.org_id, s.assistant_id, s.kind, s.label, s.settings, s.created_at,
                COUNT(d.id) AS document_count,
                MAX(d.updated_at) AS last_updated_at
         FROM sources s
         LEFT JOIN documents d ON d.org_id = s.org_id AND d.source_id = s.id
         WHERE s.org_id = ?1 AND s.assistant_id = ?2
         GROUP BY s.id
         ORDER BY s.created_at ASC`,
      )
        .bind(orgId, assistantId)
        .all<StatsRow>();
      return res.results.map((row) => ({
        ...map(row),
        documentCount: Number(row.document_count ?? 0),
        lastUpdatedAt: row.last_updated_at ?? null,
      }));
    },

    async getFirstByKind(assistantId: string, kind: SourceKind): Promise<SourceRow | null> {
      const row = await prepare(
        db,
        `SELECT ${COLUMNS} FROM sources WHERE org_id = ?1 AND assistant_id = ?2 AND kind = ?3 ORDER BY created_at ASC LIMIT 1`,
      )
        .bind(orgId, assistantId, kind)
        .first<Row>();
      return row ? map(row) : null;
    },

    async get(id: string): Promise<SourceRow | null> {
      const row = await prepare(db, `SELECT ${COLUMNS} FROM sources WHERE org_id = ?1 AND id = ?2`)
        .bind(orgId, id)
        .first<Row>();
      return row ? map(row) : null;
    },

    async getDefaultPush(assistantId: string): Promise<SourceRow | null> {
      return getDefaultByKind(assistantId, "push");
    },

    async getOrCreateDefaultPush(input: {
      id: string;
      assistantId: string;
      createdAt: number;
    }): Promise<SourceRow> {
      return getOrCreateDefaultByKind("push", "Push", input);
    },

    async getDefaultEntry(assistantId: string): Promise<SourceRow | null> {
      return getDefaultByKind(assistantId, "entry");
    },

    async getOrCreateDefaultEntry(input: {
      id: string;
      assistantId: string;
      createdAt: number;
    }): Promise<SourceRow> {
      return getOrCreateDefaultByKind("entry", "Answers you wrote", input);
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
