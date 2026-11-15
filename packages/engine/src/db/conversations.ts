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

export interface ConversationSummaryRow {
  id: string;
  assistantId: string;
  visitorId: string;
  startedAt: number;
  pageUrl: string;
  firstQuestion: string | null;
  turnCount: number;
  hasUnanswered: boolean;
}

interface SummaryRow {
  id: string;
  assistant_id: string;
  visitor_id: string;
  started_at: number;
  page_url: string;
  first_question: string | null;
  turn_count: number;
  has_unanswered: number;
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

    async listPaged(
      assistantId: string,
      options: { limit: number; offset: number },
    ): Promise<{ conversations: ConversationSummaryRow[]; total: number }> {
      const [rowsRes, countRow] = await Promise.all([
        prepare(
          db,
          `SELECT c.id, c.assistant_id, c.visitor_id, c.started_at, c.page_url,
                  (SELECT q.content
                     FROM messages q
                    WHERE q.org_id = ?1 AND q.conversation_id = c.id AND q.role = 'user'
                    ORDER BY q.created_at ASC, q.id ASC
                    LIMIT 1) AS first_question,
                  (SELECT COUNT(*)
                     FROM messages m
                    WHERE m.org_id = ?1 AND m.conversation_id = c.id) AS turn_count,
                  EXISTS(SELECT 1
                           FROM messages u
                          WHERE u.org_id = ?1 AND u.conversation_id = c.id
                            AND u.role = 'assistant' AND u.answered = 0) AS has_unanswered
             FROM conversations c
            WHERE c.org_id = ?1 AND c.assistant_id = ?2
            ORDER BY c.started_at DESC, c.id DESC
            LIMIT ?3 OFFSET ?4`,
        )
          .bind(orgId, assistantId, options.limit, options.offset)
          .all<SummaryRow>(),
        prepare(
          db,
          "SELECT COUNT(*) AS total FROM conversations WHERE org_id = ?1 AND assistant_id = ?2",
        )
          .bind(orgId, assistantId)
          .first<{ total: number }>(),
      ]);

      return {
        conversations: rowsRes.results.map((r) => ({
          id: r.id,
          assistantId: r.assistant_id,
          visitorId: r.visitor_id,
          startedAt: r.started_at,
          pageUrl: r.page_url,
          firstQuestion: r.first_question,
          turnCount: r.turn_count,
          hasUnanswered: r.has_unanswered === 1,
        })),
        total: countRow?.total ?? 0,
      };
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
