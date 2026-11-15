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
  reply_to: string | null;
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
  /** For an assistant reply, the visitor message it answers. */
  replyTo: string | null;
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
  /**
   * Required for an assistant reply: the visitor message it answers. Two
   * requests in one conversation can interleave, so the link is recorded
   * rather than inferred from timestamps.
   */
  replyTo?: string | null | undefined;
}

/** One group of unanswered questions sharing a normalised text. */
export interface GapGroupRow {
  question: string;
  /** The newest question in the group, as the visitor typed it. */
  displayQuestion: string;
  times: number;
  lastAsked: number;
  exampleMessageId: string;
  documentId: string | null;
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
  "id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at, reply_to";

const QUALIFIED_COLUMNS =
  "m.id, m.org_id, m.conversation_id, m.role, m.content, m.citations, m.tool_calls, m.tokens_in, m.tokens_out, m.answered, m.created_at, m.reply_to";

/**
 * Unanswered replies joined to the question each one answers, through the
 * recorded `reply_to` link. `?1` org, `?2` assistant.
 */
const GAP_ROWS = `
  SELECT q.id AS question_id,
         q.content AS question_content,
         q.created_at AS asked_at,
         q.rowid AS question_rowid,
         q.question_key AS question_key,
         (SELECT ga.document_id
            FROM gap_answers ga
           WHERE ga.org_id = a.org_id AND ga.message_id IN (q.id, a.id)
           ORDER BY ga.created_at DESC
           LIMIT 1) AS document_id
    FROM messages a
    JOIN conversations c ON c.id = a.conversation_id AND c.org_id = a.org_id
    JOIN messages q ON q.org_id = a.org_id
                   AND q.id = a.reply_to
                   AND q.conversation_id = a.conversation_id
                   AND q.role = 'user'
   WHERE a.org_id = ?1
     AND c.assistant_id = ?2
     AND a.role = 'assistant'
     AND a.answered = 0
     AND q.question_key IS NOT NULL
     AND q.question_key <> ''`;

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
  replyTo: row.reply_to,
});

/** Tenant-scoped data access for `messages`. */
export function messagesFor(db: D1Database, orgId: string) {
  return {
    async list(conversationId: string): Promise<MessageRow[]> {
      const res = await prepare(
        db,
        // rowid breaks ties: a question and its fallback answer can share a
        // millisecond, and the order must still be the order they were written.
        `SELECT ${COLUMNS} FROM messages WHERE org_id = ?1 AND conversation_id = ?2 ORDER BY created_at ASC, rowid ASC`,
      )
        .bind(orgId, conversationId)
        .all<Row>();
      return res.results.map(map);
    },

    /** The last `limit` messages of a conversation, oldest first. */
    async recent(conversationId: string, limit: number): Promise<MessageRow[]> {
      const res = await prepare(
        db,
        `SELECT ${COLUMNS} FROM messages WHERE org_id = ?1 AND conversation_id = ?2
         ORDER BY created_at DESC, rowid DESC LIMIT ?3`,
      )
        .bind(orgId, conversationId, limit)
        .all<Row>();
      return res.results.map(map).reverse();
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
      const replyTo = input.role === "assistant" ? (input.replyTo ?? null) : null;
      const questionKey = input.role === "user" ? normalizeQuestionText(input.content) : null;
      await prepareInsert(
        db,
        `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at, reply_to, question_key)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
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
          replyTo,
          questionKey,
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
        replyTo,
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

    /**
     * One page of unanswered questions grouped by normalised text, most
     * asked first, with the total number of groups. Grouping, counting and
     * paging all happen in D1, so the Worker reads one page however many
     * conversations there are.
     */
    async gapGroups(
      assistantId: string,
      page: { limit: number; offset: number },
    ): Promise<{ groups: GapGroupRow[]; total: number }> {
      const [rows, count] = await db.batch([
        prepare(
          db,
          `WITH gap AS (${GAP_ROWS}),
           ranked AS (
             SELECT question_key, question_content, asked_at, question_id,
                    ROW_NUMBER() OVER (
                      PARTITION BY question_key ORDER BY asked_at DESC, question_rowid DESC
                    ) AS rn,
                    COUNT(*) OVER (PARTITION BY question_key) AS times,
                    FIRST_VALUE(document_id) OVER (
                      PARTITION BY question_key
                      ORDER BY document_id IS NULL, asked_at DESC, question_rowid DESC
                    ) AS group_document_id
               FROM gap
           )
           SELECT question_key, question_content, asked_at, question_id, times, group_document_id
             FROM ranked
            WHERE rn = 1
            ORDER BY times DESC, asked_at DESC, question_id DESC
            LIMIT ?3 OFFSET ?4`,
        ).bind(orgId, assistantId, page.limit, page.offset),
        prepare(
          db,
          `WITH gap AS (${GAP_ROWS}) SELECT COUNT(DISTINCT question_key) AS total FROM gap`,
        ).bind(orgId, assistantId),
      ]);

      const groups = (
        (rows?.results ?? []) as Array<{
          question_key: string;
          question_content: string;
          asked_at: number;
          question_id: string;
          times: number;
          group_document_id: string | null;
        }>
      ).map((r) => ({
        question: r.question_key,
        displayQuestion: r.question_content.trim(),
        times: r.times,
        lastAsked: r.asked_at,
        exampleMessageId: r.question_id,
        documentId: r.group_document_id,
      }));
      const total = ((count?.results ?? []) as Array<{ total: number }>)[0]?.total ?? 0;
      return { groups, total };
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

    /**
     * Tool calls already stored in this conversation. `json_array_length` reads the
     * column the loop writes, so the cap counts exactly what was spent and needs
     * no second counter to keep in step.
     */
    async countToolCalls(conversationId: string): Promise<number> {
      const row = await prepare(
        db,
        `SELECT COALESCE(SUM(
                  CASE WHEN tool_calls IS NULL OR json_valid(tool_calls) = 0
                       THEN 0 ELSE json_array_length(tool_calls) END), 0) AS total
           FROM messages
          WHERE org_id = ?1 AND conversation_id = ?2`,
      )
        .bind(orgId, conversationId)
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
        `SELECT m.question_key AS question,
                COUNT(*) AS count,
                MAX(m.created_at) AS last_asked
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
          WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.role = 'user'
            AND m.question_key IS NOT NULL AND m.question_key <> ''
          GROUP BY m.question_key
          ORDER BY count DESC, last_asked DESC
          LIMIT ?3`,
      )
        .bind(orgId, assistantId, limit)
        .all<{ question: string; count: number; last_asked: number }>();
      return res.results.map((row) => ({ question: row.question, count: row.count }));
    },
  };
}
