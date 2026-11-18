import { messagesFor, searchableText } from "./messages.js";
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
  /** A visitor gave at least one reply a thumbs down. */
  hasNotHelpful: boolean;
  /** At least one reply called an MCP tool or a page action. */
  usedTool: boolean;
  /** When the newest message was written; `startedAt` for an empty conversation. */
  lastMessageAt: number;
}

/** Which conversations a list shows. Every set field narrows it further. */
export interface ConversationFilter {
  unanswered?: boolean;
  notHelpful?: boolean;
  usedTool?: boolean;
  /** Started at or after this millisecond. */
  since?: number;
  /** Text a visitor question or a reply contains, case-insensitive. */
  search?: string;
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
  has_not_helpful: number;
  used_tool: number;
  last_message_at: number | null;
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

// Per-conversation flags, each a correlated subquery on `c`. SQLite does not
// promise the order it evaluates `AND` terms in, so a guard that must run first
// (json_valid before json_array_length) is a CASE.
const UNANSWERED = `SELECT 1 FROM messages u
   WHERE u.org_id = c.org_id AND u.conversation_id = c.id
     AND u.role = 'assistant' AND u.answered = 0`;
const NOT_HELPFUL = `SELECT 1 FROM messages fm
    JOIN feedback f ON f.org_id = fm.org_id AND f.message_id = fm.id
   WHERE fm.org_id = c.org_id AND fm.conversation_id = c.id AND f.value = 'down'`;
const USED_TOOL = `SELECT 1 FROM messages tm
   WHERE tm.org_id = c.org_id AND tm.conversation_id = c.id AND tm.role = 'assistant'
     AND CASE WHEN tm.tool_calls IS NOT NULL AND json_valid(tm.tool_calls)
              THEN json_array_length(tm.tool_calls) ELSE 0 END > 0`;

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

    /**
     * One page of an assistant's conversations, latest message first (the
     * time each row shows; a conversation with none yet goes by when it
     * started), so a long-running one moves up as it continues. A search reads
     * `search_text`, so rows written before it existed are folded first, a
     * bounded share per call (this assistant's messages only, as the search
     * reads no others). While some are left the search is not run (a
     * row still to fold could match, so any answer could leave it out):
     * the result is empty with `searchPending`, and asking again folds more.
     */
    async listPaged(
      assistantId: string,
      options: { limit: number; offset: number; filter?: ConversationFilter },
    ): Promise<{
      conversations: ConversationSummaryRow[];
      total: number;
      searchPending: boolean;
      /** While `searchPending`: this assistant's messages still to prepare. */
      searchRemaining?: number;
    }> {
      const filter = options.filter ?? {};
      const search = (filter.search ?? "").trim();
      if (search !== "") {
        const messages = messagesFor(db, orgId);
        if (!(await messages.fillSearchText({ assistantId }))) {
          const searchRemaining = await messages.searchTextPending(assistantId);
          return { conversations: [], total: 0, searchPending: true, searchRemaining };
        }
      }
      // Each condition is switched on by its own parameter, so one statement
      // serves every combination and nothing is spliced into the SQL.
      // The search compares `search_text` with the search folded the same way
      // in JavaScript (SQLite's `lower()` only folds ASCII). Every write of
      // `content` here also writes `search_text`; a row still NULL now came
      // from a writer that does not (an older Worker still running during a
      // deploy), so `lower(content)` covers its ASCII text until the next
      // search folds it. The exact text (`?8`) always matches.
      const where = `
        FROM conversations c
       WHERE c.org_id = ?1 AND c.assistant_id = ?2
         AND (?3 = 0 OR EXISTS (${UNANSWERED}))
         AND (?4 = 0 OR EXISTS (${NOT_HELPFUL}))
         AND (?5 = 0 OR EXISTS (${USED_TOOL}))
         AND c.started_at >= ?6
         AND (?7 = '' OR EXISTS (
           SELECT 1 FROM messages s
            WHERE s.org_id = c.org_id AND s.conversation_id = c.id
              AND (instr(COALESCE(s.search_text, lower(s.content)), ?7) > 0
                   OR instr(s.content, ?8) > 0)
         ))`;
      const params = [
        orgId,
        assistantId,
        filter.unanswered ? 1 : 0,
        filter.notHelpful ? 1 : 0,
        filter.usedTool ? 1 : 0,
        filter.since ?? 0,
        searchableText(search),
        search,
      ];
      const [rowsRes, countRow] = await Promise.all([
        prepare(
          db,
          `SELECT c.id, c.assistant_id, c.visitor_id, c.started_at, c.page_url,
                  (SELECT q.content
                     FROM messages q
                    WHERE q.org_id = ?1 AND q.conversation_id = c.id AND q.role = 'user'
                    ORDER BY q.created_at ASC, q.rowid ASC
                    LIMIT 1) AS first_question,
                  (SELECT COUNT(*)
                     FROM messages m
                    WHERE m.org_id = ?1 AND m.conversation_id = c.id) AS turn_count,
                  (SELECT MAX(l.created_at)
                     FROM messages l
                    WHERE l.org_id = ?1 AND l.conversation_id = c.id) AS last_message_at,
                  EXISTS(${UNANSWERED}) AS has_unanswered,
                  EXISTS(${NOT_HELPFUL}) AS has_not_helpful,
                  EXISTS(${USED_TOOL}) AS used_tool
             ${where}
            ORDER BY COALESCE(last_message_at, c.started_at) DESC, c.id DESC
            LIMIT ?9 OFFSET ?10`,
        )
          .bind(...params, options.limit, options.offset)
          .all<SummaryRow>(),
        prepare(db, `SELECT COUNT(*) AS total ${where}`)
          .bind(...params)
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
          hasNotHelpful: r.has_not_helpful === 1,
          usedTool: r.used_tool === 1,
          lastMessageAt: r.last_message_at ?? r.started_at,
        })),
        total: countRow?.total ?? 0,
        searchPending: false,
      };
    },

    /** Whether any visitor has asked this assistant a question (the checklist's last step). */
    async hasVisitorQuestion(assistantId: string): Promise<boolean> {
      const row = await prepare(
        db,
        `SELECT EXISTS(
           SELECT 1 FROM messages m
             JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
            WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.role = 'user'
         ) AS found`,
      )
        .bind(orgId, assistantId)
        .first<{ found: number }>();
      return row?.found === 1;
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

    /**
     * Atomically reserves `count` tool calls against `limit` for this
     * conversation. Returns true if the reservation succeeded, false if it
     * would exceed the cap (or the conversation does not exist in this org).
     * Counts the higher of `tool_calls_used` and stored `messages.tool_calls`
     * so pre-existing or seeded messages are never bypassed.
     */
    async reserveToolCalls(conversationId: string, count: number, limit: number): Promise<boolean> {
      if (count <= 0) return true;
      const priorSql = `COALESCE((
        SELECT SUM(CASE WHEN (tool_calls IS NULL OR json_valid(tool_calls) = 0)
                        THEN 0 ELSE json_array_length(tool_calls) END)
          FROM messages
         WHERE org_id = ?1 AND conversation_id = ?2
      ), 0)`;
      const res = await prepare(
        db,
        `UPDATE conversations
            SET tool_calls_used = MAX(tool_calls_used, ${priorSql}) + ?3
          WHERE org_id = ?1
            AND id = ?2
            AND MAX(tool_calls_used, ${priorSql}) + ?3 <= ?4`,
      )
        .bind(orgId, conversationId, count, limit)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    /**
     * The page and time of the newest conversation that recorded a page, or
     * null. A conversation only exists once a visitor sends a message, so
     * this proves the widget loaded there; it misses loads with no message.
     */
    async latestPageSeen(assistantId: string): Promise<{ pageUrl: string; at: number } | null> {
      const row = await prepare(
        db,
        `SELECT page_url, started_at FROM conversations
         WHERE org_id = ?1 AND assistant_id = ?2 AND page_url != ''
         ORDER BY started_at DESC LIMIT 1`,
      )
        .bind(orgId, assistantId)
        .first<{ page_url: string; started_at: number }>();
      return row ? { pageUrl: row.page_url, at: row.started_at } : null;
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
