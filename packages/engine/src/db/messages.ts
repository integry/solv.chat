import { prepare, prepareInsert, safeJsonArray } from "./sql.js";

export type MessageRole = "user" | "assistant";

export interface Citation {
  url: string;
  title: string;
}

interface Row {
  id: string;
  org_id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  citations: string;
  tool_calls: string | null;
  tokens_in: number;
  tokens_out: number;
  answered: number;
  created_at: number;
}

export interface MessageRow {
  id: string;
  orgId: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  citations: Citation[];
  toolCalls: unknown[] | null;
  tokensIn: number;
  tokensOut: number;
  answered: boolean;
  createdAt: number;
}

export interface CreateMessageInput {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  citations: Citation[];
  toolCalls: unknown[] | null;
  tokensIn: number;
  tokensOut: number;
  answered: boolean;
  createdAt: number;
}

const COLUMNS =
  "id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at";

const QUALIFIED_COLUMNS =
  "m.id, m.org_id, m.conversation_id, m.role, m.content, m.citations, m.tool_calls, m.tokens_in, m.tokens_out, m.answered, m.created_at";

const map = (row: Row): MessageRow => ({
  id: row.id,
  orgId: row.org_id,
  conversationId: row.conversation_id,
  role: row.role,
  content: row.content,
  citations: safeJsonArray<Citation>(row.citations),
  toolCalls: row.tool_calls === null ? null : safeJsonArray<unknown>(row.tool_calls),
  tokensIn: row.tokens_in,
  tokensOut: row.tokens_out,
  answered: row.answered === 1,
  createdAt: row.created_at,
});

/** Tenant-scoped data access for `messages`. */
export function messagesFor(db: D1Database, orgId: string) {
  return {
    async list(conversationId: string): Promise<MessageRow[]> {
      const res = await prepare(
        db,
        `SELECT ${COLUMNS} FROM messages WHERE org_id = ?1 AND conversation_id = ?2 ORDER BY created_at ASC`,
      )
        .bind(orgId, conversationId)
        .all<Row>();
      return res.results.map(map);
    },

    async get(id: string): Promise<MessageRow | null> {
      const row = await prepare(db, `SELECT ${COLUMNS} FROM messages WHERE org_id = ?1 AND id = ?2`)
        .bind(orgId, id)
        .first<Row>();
      return row ? map(row) : null;
    },

    async unanswered(assistantId: string, limit = 50): Promise<MessageRow[]> {
      const res = await prepare(
        db,
        `SELECT ${QUALIFIED_COLUMNS}
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id AND c.org_id = ?1
         WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.answered = 0
         ORDER BY m.created_at DESC
         LIMIT ?3`,
      )
        .bind(orgId, assistantId, limit)
        .all<Row>();
      return res.results.map(map);
    },

    async create(input: CreateMessageInput): Promise<MessageRow> {
      await prepareInsert(
        db,
        `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
        .bind(
          orgId,
          input.id,
          input.conversationId,
          input.role,
          input.content,
          JSON.stringify(input.citations),
          input.toolCalls === null ? null : JSON.stringify(input.toolCalls),
          input.tokensIn,
          input.tokensOut,
          input.answered ? 1 : 0,
          input.createdAt,
        )
        .run();

      return {
        id: input.id,
        orgId,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        citations: [...input.citations],
        toolCalls: input.toolCalls === null ? null : [...input.toolCalls],
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        answered: input.answered,
        createdAt: input.createdAt,
      };
    },

    async markAnswered(id: string, answered: boolean): Promise<boolean> {
      const res = await prepare(
        db,
        "UPDATE messages SET answered = ?3 WHERE org_id = ?1 AND id = ?2",
      )
        .bind(orgId, id, answered ? 1 : 0)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async remove(id: string): Promise<boolean> {
      const res = await prepare(db, "DELETE FROM messages WHERE org_id = ?1 AND id = ?2")
        .bind(orgId, id)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },
  };
}
