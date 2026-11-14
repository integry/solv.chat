import { prepare, prepareInsert } from "./sql.js";

export type FeedbackValue = "up" | "down";

interface Row {
  id: string;
  org_id: string;
  message_id: string;
  visitor_id: string;
  value: FeedbackValue;
  note: string;
  created_at: number;
}

export interface FeedbackRow {
  id: string;
  orgId: string;
  messageId: string;
  visitorId: string;
  value: FeedbackValue;
  note: string;
  createdAt: number;
}

export interface UpsertFeedbackInput {
  id: string;
  messageId: string;
  visitorId: string;
  value: FeedbackValue;
  note: string;
  createdAt: number;
}

const COLUMNS = "id, org_id, message_id, visitor_id, value, note, created_at";

const map = (row: Row): FeedbackRow => ({
  id: row.id,
  orgId: row.org_id,
  messageId: row.message_id,
  visitorId: row.visitor_id,
  value: row.value,
  note: row.note,
  createdAt: row.created_at,
});

/** Tenant-scoped data access for `feedback`. */
export function feedbackFor(db: D1Database, orgId: string) {
  return {
    async listForMessage(messageId: string): Promise<FeedbackRow[]> {
      const res = await prepare(
        db,
        `SELECT ${COLUMNS} FROM feedback WHERE org_id = ?1 AND message_id = ?2 ORDER BY created_at DESC`,
      )
        .bind(orgId, messageId)
        .all<Row>();
      return res.results.map(map);
    },

    async listForConversation(conversationId: string): Promise<FeedbackRow[]> {
      const res = await prepare(
        db,
        `SELECT f.id, f.org_id, f.message_id, f.visitor_id, f.value, f.note, f.created_at
           FROM feedback f
           JOIN messages m ON m.id = f.message_id AND m.org_id = f.org_id
          WHERE f.org_id = ?1 AND m.conversation_id = ?2
          ORDER BY f.created_at DESC`,
      )
        .bind(orgId, conversationId)
        .all<Row>();
      return res.results.map(map);
    },

    async get(id: string): Promise<FeedbackRow | null> {
      const row = await prepare(db, `SELECT ${COLUMNS} FROM feedback WHERE org_id = ?1 AND id = ?2`)
        .bind(orgId, id)
        .first<Row>();
      return row ? map(row) : null;
    },

    async upsert(input: UpsertFeedbackInput): Promise<FeedbackRow> {
      await prepareInsert(
        db,
        `INSERT INTO feedback (id, org_id, message_id, visitor_id, value, note, created_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(org_id, message_id, visitor_id) DO UPDATE SET
           value = excluded.value,
           note = excluded.note`,
      )
        .bind(
          orgId,
          input.id,
          input.messageId,
          input.visitorId,
          input.value,
          input.note,
          input.createdAt,
        )
        .run();

      const saved = await prepare(
        db,
        `SELECT ${COLUMNS} FROM feedback WHERE org_id = ?1 AND message_id = ?2 AND visitor_id = ?3`,
      )
        .bind(orgId, input.messageId, input.visitorId)
        .first<Row>();

      if (saved) return map(saved);

      return {
        id: input.id,
        orgId,
        messageId: input.messageId,
        visitorId: input.visitorId,
        value: input.value,
        note: input.note,
        createdAt: input.createdAt,
      };
    },

    async updateNote(id: string, note: string): Promise<boolean> {
      const res = await prepare(db, "UPDATE feedback SET note = ?3 WHERE org_id = ?1 AND id = ?2")
        .bind(orgId, id, note)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async remove(id: string): Promise<boolean> {
      const res = await prepare(db, "DELETE FROM feedback WHERE org_id = ?1 AND id = ?2")
        .bind(orgId, id)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },
  };
}
