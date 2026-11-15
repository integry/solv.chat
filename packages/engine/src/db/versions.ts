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

export interface CreatePublishedInput {
  id: string;
  assistantId: string;
  config: VersionConfig;
  createdAt: number;
  publishedAt: number;
}

const COLUMNS = "id, org_id, assistant_id, state, config, created_at, published_at";

/**
 * The config text each row was read with, kept off the row itself so it never
 * reaches an API response. `updateDraft` compares against these exact bytes:
 * re-serialising the parsed config would never match a row that does not
 * round-trip (a hand edit, or a schema that fell back to defaults), and every
 * save of that draft would then fail as a conflict.
 */
const storedConfig = new WeakMap<VersionRow, string>();

/** Returns the exact stored config JSON bytes for optimistic concurrency checks. */
export function expectedVersionConfig(row: VersionRow): string {
  return storedConfig.get(row) ?? JSON.stringify(row.config);
}

const map = (row: Row): VersionRow => {
  const parsed = parseVersionConfig(safeJson(row.config));
  const mapped: VersionRow = {
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
  storedConfig.set(mapped, row.config);
  return mapped;
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

    byId: (assistantId: string, id: string) =>
      one(
        `SELECT ${COLUMNS} FROM assistant_versions WHERE org_id = ?1 AND assistant_id = ?2 AND id = ?3`,
        assistantId,
        id,
      ),

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
        `SELECT ${COLUMNS} FROM assistant_versions WHERE org_id = ?1 AND assistant_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT 100`,
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

    async updateDraft(
      assistantId: string,
      config: VersionConfig,
      /** The draft row as read; the write applies only if its stored config is unchanged. */
      expected?: VersionRow,
    ): Promise<boolean> {
      const sql = expected
        ? "UPDATE assistant_versions SET config = ?3 WHERE org_id = ?1 AND assistant_id = ?2 AND state = 'draft' AND id = ?4 AND config = ?5"
        : "UPDATE assistant_versions SET config = ?3 WHERE org_id = ?1 AND assistant_id = ?2 AND state = 'draft'";
      const args: unknown[] = expected
        ? [
            orgId,
            assistantId,
            JSON.stringify(config),
            expected.id,
            storedConfig.get(expected) ?? JSON.stringify(expected.config),
          ]
        : [orgId, assistantId, JSON.stringify(config)];
      const res = await prepare(db, sql)
        .bind(...args)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async publishDraft(
      assistantId: string,
      draftId: string,
      nextDraftId: string,
      publishedAt: number,
      expectedConfig?: string,
    ): Promise<VersionRow | null> {
      const configClause = expectedConfig === undefined ? "" : " AND config = ?4";
      const promoteConfigClause = expectedConfig === undefined ? "" : " AND config = ?5";
      const archiveArgs: unknown[] =
        expectedConfig === undefined
          ? [orgId, assistantId, draftId]
          : [orgId, assistantId, draftId, expectedConfig];
      const promoteArgs: unknown[] =
        expectedConfig === undefined
          ? [orgId, draftId, publishedAt, assistantId]
          : [orgId, draftId, publishedAt, assistantId, expectedConfig];

      const results = await db.batch([
        // Archive first: the partial unique index allows one published row, so
        // promoting the draft would fail with the old one still published.
        // Guarded on `draftId` still being the current draft (and unchanged
        // config when bound to a test run) so a stale batch never archives the
        // active published version.
        prepare(
          db,
          `UPDATE assistant_versions SET state = 'archived'
           WHERE org_id = ?1 AND assistant_id = ?2 AND state = 'published'
             AND EXISTS (
               SELECT 1 FROM assistant_versions
               WHERE org_id = ?1 AND assistant_id = ?2 AND id = ?3 AND state = 'draft'${configClause}
             )`,
        ).bind(...archiveArgs),
        // The draft becomes the published version and keeps its id, so a "Try it"
        // conversation started against the draft still resolves afterwards.
        prepare(
          db,
          `UPDATE assistant_versions SET state = 'published', published_at = ?3 WHERE org_id = ?1 AND assistant_id = ?4 AND id = ?2 AND state = 'draft'${promoteConfigClause}`,
        ).bind(...promoteArgs),
        // Derive the fresh draft from the promoted row inside the same batch
        // so a completed draft update between the initial read and this batch
        // is neither lost nor overwritten. Guarded on no draft existing so a
        // stale concurrent publish performs no insert instead of hitting
        // `versions_one_draft`.
        prepareInsert(
          db,
          `INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at)
           SELECT ?2, org_id, assistant_id, 'draft', config, ?4, NULL
           FROM assistant_versions
           WHERE org_id = ?1 AND assistant_id = ?5 AND id = ?3 AND state = 'published'
             AND NOT EXISTS (
               SELECT 1 FROM assistant_versions
               WHERE org_id = ?1 AND assistant_id = ?5 AND state = 'draft'
             )`,
        ).bind(orgId, nextDraftId, draftId, publishedAt, assistantId),
        prepare(db, `SELECT ${COLUMNS} FROM assistant_versions WHERE org_id = ?1 AND id = ?2`).bind(
          orgId,
          draftId,
        ),
      ]);
      if ((results[1]?.meta.changes ?? 0) === 0) return null;
      const promoted = results[3]?.results?.[0] as Row | undefined;
      return promoted ? map(promoted) : null;
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

      insertPublished: (input: CreatePublishedInput): D1PreparedStatement =>
        prepareInsert(
          db,
          `INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at)
           VALUES (?2, ?1, ?3, 'published', ?4, ?5, ?6)`,
        ).bind(
          orgId,
          input.id,
          input.assistantId,
          JSON.stringify(input.config),
          input.createdAt,
          input.publishedAt,
        ),
    },

    async batch(stmts: D1PreparedStatement[]): Promise<void> {
      if (stmts.length === 0) return;
      await db.batch(stmts);
    },
  };
}

/**
 * Reads the daily spend cap from the assistant's published version, falling
 * back to the default when nothing is published yet. A published cap of 0
 * means "no cap" and passes through unchanged.
 */
export async function publishedCapMicros(
  db: D1Database,
  orgId: string,
  assistantId: string,
): Promise<number> {
  const published = await versionsFor(db, orgId).published(assistantId);
  return published
    ? published.config.limits.dailyCostCapMicros
    : defaultVersionConfig().limits.dailyCostCapMicros;
}
