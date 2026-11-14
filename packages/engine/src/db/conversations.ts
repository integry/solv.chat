import { prepare, prepareInsert } from "./sql.js";

interface Row {
  id: string;
  org_id: string;
  assistant_id: string;
  visitor_id: string;
  started_at: number;
  page_url: string;
}

export interface ConversationRow {
  id: string;
  orgId: string;
  assistantId: string;
  visitorId: string;
  startedAt: number;
  pageUrl: string;
}

export interface CreateConversationInput {
  id: string;
  assistantId: string;
  visitorId: string;
  startedAt: number;
  pageUrl: string;
}

const COLUMNS = "id, org_id, assistant_id, visitor_id, started_at, page_url";

const map = (row: Row): ConversationRow => ({
  id: row.id,
  orgId: row.org_id,
  assistantId: row.assistant_id,
  visitorId: row.visitor_id,
  startedAt: row.started_at,
  pageUrl: row.page_url,
});

/** Tenant-scoped data access for `conversations`. */
export function conversationsFor(db: D1Database, orgId: string) {
  return {
    async list(assistantId: string, limit = 50): Promise<ConversationRow[]> {
      const res = await prepare(
        db,
        `SELECT ${COLUMNS} FROM conversations WHERE org_id = ?1 AND assistant_id = ?2 ORDER BY started_at DESC LIMIT ?3`,
      )
        .bind(orgId, assistantId, limit)
        .all<Row>();
      return res.results.map(map);
    },

    async get(id: string): Promise<ConversationRow | null> {
      const row = await prepare(
        db,
        `SELECT ${COLUMNS} FROM conversations WHERE org_id = ?1 AND id = ?2`,
      )
        .bind(orgId, id)
        .first<Row>();
      return row ? map(row) : null;
    },

    async create(input: CreateConversationInput): Promise<ConversationRow> {
      await prepareInsert(
        db,
        `INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6)`,
      )
        .bind(orgId, input.id, input.assistantId, input.visitorId, input.startedAt, input.pageUrl)
        .run();

      return {
        id: input.id,
        orgId,
        assistantId: input.assistantId,
        visitorId: input.visitorId,
        startedAt: input.startedAt,
        pageUrl: input.pageUrl,
      };
    },

    async updatePageUrl(id: string, pageUrl: string): Promise<boolean> {
      const res = await prepare(
        db,
        "UPDATE conversations SET page_url = ?3 WHERE org_id = ?1 AND id = ?2",
      )
        .bind(orgId, id, pageUrl)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async remove(id: string): Promise<boolean> {
      const res = await prepare(db, "DELETE FROM conversations WHERE org_id = ?1 AND id = ?2")
        .bind(orgId, id)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },
  };
}
