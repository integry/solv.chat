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

export interface GapMessageRow {
  questionId: string;
  questionContent: string;
  askedAt: number;
  answerDocumentId: string | null;
}

export interface TopQuestionRow {
  question: string;
  count: number;
}

/** Normalises a visitor question for grouping (trimmed, lowercased, collapsed whitespace). */
export function normalizeQuestionText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
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

    async listGapRows(assistantId: string): Promise<GapMessageRow[]> {
      const res = await prepare(
        db,
        `SELECT q.id AS question_id,
                q.content AS question_content,
                q.created_at AS asked_at,
                ga.document_id AS answer_document_id
           FROM messages a
           JOIN conversations c ON c.id = a.conversation_id AND c.org_id = a.org_id
           JOIN messages q ON q.conversation_id = a.conversation_id
                          AND q.org_id = a.org_id
                          AND q.role = 'user'
                          AND q.id = (
                            SELECT q2.id
                              FROM messages q2
                             WHERE q2.org_id = a.org_id
                               AND q2.conversation_id = a.conversation_id
                               AND q2.role = 'user'
                               AND q2.created_at <= a.created_at
                             ORDER BY q2.created_at DESC, q2.id DESC
                             LIMIT 1
                          )
           LEFT JOIN gap_answers ga ON ga.org_id = a.org_id
                                   AND (ga.message_id = q.id OR ga.message_id = a.id)
          WHERE a.org_id = ?1
            AND c.assistant_id = ?2
            AND a.role = 'assistant'
            AND a.answered = 0
          ORDER BY q.created_at DESC, q.id DESC`,
      )
        .bind(orgId, assistantId)
        .all<{
          question_id: string;
          question_content: string;
          asked_at: number;
          answer_document_id: string | null;
        }>();

      return res.results.map((r) => ({
        questionId: r.question_id,
        questionContent: r.question_content,
        askedAt: r.asked_at,
        answerDocumentId: r.answer_document_id,
      }));
    },

    async linkGapAnswer(messageId: string, documentId: string, createdAt: number): Promise<void> {
      await prepareInsert(
        db,
        `INSERT INTO gap_answers (org_id, message_id, document_id, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(org_id, message_id) DO UPDATE SET
           document_id = excluded.document_id`,
      )
        .bind(orgId, messageId, documentId, createdAt)
        .run();
    },

    async listGapAnswersForConversation(conversationId: string): Promise<Map<string, string>> {
      const res = await prepare(
        db,
        `SELECT ga.message_id, ga.document_id
           FROM gap_answers ga
           JOIN messages m ON m.id = ga.message_id AND m.org_id = ga.org_id
          WHERE ga.org_id = ?1 AND m.conversation_id = ?2`,
      )
        .bind(orgId, conversationId)
        .all<{ message_id: string; document_id: string }>();

      const mapByMsg = new Map<string, string>();
      for (const r of res.results) {
        mapByMsg.set(r.message_id, r.document_id);
      }
      return mapByMsg;
    },

    async countFor(assistantId: string): Promise<number> {
      const row = await prepare(
        db,
        `SELECT COUNT(*) AS total
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
          WHERE m.org_id = ?1 AND c.assistant_id = ?2`,
      )
        .bind(orgId, assistantId)
        .first<{ total: number }>();
      return row?.total ?? 0;
    },

    async answeredShareFor(assistantId: string): Promise<number> {
      const row = await prepare(
        db,
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN m.answered = 1 THEN 1 ELSE 0 END), 0) AS answered_count
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
          WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.role = 'assistant'`,
      )
        .bind(orgId, assistantId)
        .first<{ total: number; answered_count: number }>();
      if (!row || row.total === 0) return 0;
      return row.answered_count / row.total;
    },

    async topQuestionsFor(assistantId: string, limit = 5): Promise<TopQuestionRow[]> {
      const res = await prepare(
        db,
        `SELECT lower(trim(m.content)) AS question,
                COUNT(*) AS count,
                MAX(m.created_at) AS last_asked
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
          WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.role = 'user'
          GROUP BY question
          ORDER BY count DESC, last_asked DESC`,
      )
        .bind(orgId, assistantId)
        .all<{ question: string; count: number; last_asked: number }>();

      const merged = new Map<string, { count: number; lastAsked: number }>();
      for (const row of res.results) {
        const key = normalizeQuestionText(row.question);
        if (!key) continue;
        const existing = merged.get(key);
        if (existing) {
          existing.count += row.count;
          existing.lastAsked = Math.max(existing.lastAsked, row.last_asked);
        } else {
          merged.set(key, { count: row.count, lastAsked: row.last_asked });
        }
      }

      return Array.from(merged.entries())
        .sort((a, b) => b[1].count - a[1].count || b[1].lastAsked - a[1].lastAsked)
        .slice(0, limit)
        .map(([question, info]) => ({ question, count: info.count }));
    },
  };
}
