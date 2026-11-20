import { type AnswerOutcome, isAnswerOutcome } from "@solvchat/core";
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
  cost_micros: number | null;
  answered: number;
  created_at: number;
  reply_to: string | null;
  first_token_ms: number | null;
  total_ms: number | null;
  outcome: string | null;
  outcome_confidence: number | null;
  citations_shown: number;
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
  costMicros: number | null;
  answered: boolean;
  createdAt: number;
  /** For an assistant reply, the visitor message it answers. */
  replyTo: string | null;
  /** For an assistant reply, milliseconds until its first token reached the visitor; null before 0026 or with no text. */
  firstTokenMs: number | null;
  /** For an assistant reply, milliseconds from the request to the complete reply; null before 0026. */
  totalMs: number | null;
  /** For an assistant reply, what the answer review decided; null when it was not reviewed. */
  outcome: AnswerOutcome | null;
  /** The reviewer's confidence, 0 to 1, when its backend gives one. Nothing reads it yet. */
  outcomeConfidence: number | null;
  /**
   * Whether the visitor was shown `citations` (the version's "Show sources in
   * answers"). Off, `citations` is still kept: it is the owner's record of
   * the pages the answer used. True for rows written before migration 0034.
   */
  citationsShown: boolean;
}

export interface PendingReplyRow extends MessageRow {
  resumeContext: unknown | null;
  resumeRevision: number;
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
  /** Micro-dollars for this message, `0` when known free, or `null` when unknown / not applicable. */
  costMicros?: number | null | undefined;
  answered: boolean;
  createdAt: number;
  /**
   * Required for an assistant reply: the visitor message it answers. Two
   * requests in one conversation can interleave, so the link is recorded
   * rather than inferred from timestamps.
   */
  replyTo?: string | null | undefined;
  /** Transient model continuation state for paused page-action replies. */
  resumeContext?: unknown | null | undefined;
  /** Assistant replies only: when the first token reached the visitor, from the request's start. */
  firstTokenMs?: number | null | undefined;
  /** Assistant replies only: how long the request took until the reply was complete. */
  totalMs?: number | null | undefined;
  /**
   * Assistant replies only: the documents the reply was given to answer from
   * (every kind, written answers included), for the Reports usage lists.
   * Stored in `message_documents`, never in `citations`: see migration 0029.
   */
  documentIds?: readonly string[] | undefined;
  /** Assistant replies only: whether the visitor saw the citations. Left out means yes. */
  citationsShown?: boolean | undefined;
}

/**
 * Records the documents a reply was given (`?1` org, `?2` message, `?3` a
 * JSON array of document ids), ignoring ones already recorded: a resume adds
 * to what its pause stored. `when` is an extra condition, checked in the same
 * statement; it is a literal from this module, never input.
 */
function recordDocuments(db: D1Database, when = ""): D1PreparedStatement {
  return prepareInsert(
    db,
    `INSERT OR IGNORE INTO message_documents (org_id, message_id, document_id)
     SELECT DISTINCT ?1, ?2, value FROM json_each(?3)
      WHERE typeof(value) = 'text' ${when}`,
  );
}

/** One group of unanswered questions sharing a normalised text. */
export interface GapGroupRow {
  question: string;
  /** The newest question in the group, as the visitor typed it. */
  displayQuestion: string;
  times: number;
  /**
   * Of `times`: asks where retrieval found nothing above the floor ("no
   * content found"), and asks where it found content but the reviewed reply
   * still declined ("had content, still could not answer"). They add up to
   * `times`.
   */
  noContentTimes: number;
  declinedTimes: number;
  lastAsked: number;
  exampleMessageId: string;
  documentId: string | null;
}

export interface TopQuestionRow {
  question: string;
  count: number;
}

/**
 * Turns each run of whitespace into one space. Same result as
 * `replace(/\s+/g, " ")`, without rewriting every single space between words.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s{2,}|[^\S ]/g, " ");
}

/** Normalises a visitor question for grouping (trimmed, lowercased, collapsed whitespace). */
export function normalizeQuestionText(text: string): string {
  return collapseWhitespace(text.trim().toLowerCase());
}

/**
 * Folds message text for the Conversations search: Unicode lowercase in NFC,
 * whitespace collapsed the way `normalizeQuestionText` collapses it, so a
 * grouped question still finds the messages it was grouped from. The same
 * function folds the stored text and the search, so both sides agree
 * (SQLite's `lower()` only folds ASCII).
 *
 * Final sigma "ς" becomes "σ". Lowercasing picks between the two from the
 * letters around a capital "Σ", so the same letter folds one way at the end
 * of a search ("ΚΌΣ" gives "κός") and the other inside a stored word
 * ("κόσμος"): with one form on both sides a prefix still matches. It is the
 * only lowercase mapping that depends on context. Migration 0020 applies the
 * same to text folded before this.
 */
export function searchableText(text: string): string {
  return collapseWhitespace(
    text.normalize("NFC").toLowerCase().normalize("NFC").replaceAll("ς", "σ"),
  );
}

// Older rows `fillSearchText` folds per call: at most 2 D1 queries a round,
// well inside the 50 a Workers Free invocation may make (a `db.batch()`
// counts as one). Source (checked 2026-11-17):
//   https://developers.cloudflare.com/d1/platform/limits/
const SEARCH_FILL_BATCH = 200;
const SEARCH_FILL_ROUNDS = 10;

const COLUMNS =
  "id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, cost_micros, answered, created_at, reply_to, first_token_ms, total_ms, outcome, outcome_confidence, citations_shown";

const QUALIFIED_COLUMNS =
  "m.id, m.org_id, m.conversation_id, m.role, m.content, m.citations, m.tool_calls, m.tokens_in, m.tokens_out, m.cost_micros, m.answered, m.created_at, m.reply_to, m.first_token_ms, m.total_ms, m.outcome, m.outcome_confidence, m.citations_shown";

/**
 * A reply Gaps lists, on alias `a`: the answer review stored `declined`
 * (a retrieval miss, or a reply that had content and still did not answer).
 * A miss reviewed as `off_topic` or `wants_human` is not a content gap and is
 * left out. Unreviewed replies (older rows, a review still to run) are read
 * as before: by `answered` alone.
 */
export const GAP_REPLY = "(a.outcome = 'declined' OR (a.outcome IS NULL AND a.answered = 0))";

/**
 * Unanswered replies joined to the question each one answers, through the
 * recorded `reply_to` link. `?1` org, `?2` assistant. Each row carries the
 * newest answer written from it, if any, and when, and whether it was asked
 * before the owner dismissed its group (`dismissed`). A dismissed ask is kept
 * here rather than left out: it is not counted, but an answer written from it
 * (its conversation still offers "Write an answer") still answers the group.
 */
const GAP_ROWS = `
  SELECT q.id AS question_id,
         q.content AS question_content,
         q.created_at AS asked_at,
         q.rowid AS question_rowid,
         q.question_key AS question_key,
         a.answered AS had_content,
         (SELECT ga.document_id
            FROM gap_answers ga
           WHERE ga.org_id = a.org_id AND ga.message_id IN (q.id, a.id)
           ORDER BY ga.created_at DESC
           LIMIT 1) AS document_id,
         (SELECT MAX(ga.created_at)
            FROM gap_answers ga
           WHERE ga.org_id = a.org_id AND ga.message_id IN (q.id, a.id)) AS answered_at,
         EXISTS (
           SELECT 1 FROM gap_dismissals gd
            WHERE gd.org_id = a.org_id
              AND gd.assistant_id = c.assistant_id
              AND gd.question_key = q.question_key
              AND gd.dismissed_at >= q.created_at
         ) AS dismissed
    FROM messages a
    JOIN conversations c ON c.id = a.conversation_id AND c.org_id = a.org_id
    JOIN messages q ON q.org_id = a.org_id
                   AND q.id = a.reply_to
                   AND q.conversation_id = a.conversation_id
                   AND q.role = 'user'
   WHERE a.org_id = ?1
     AND c.assistant_id = ?2
     AND a.role = 'assistant'
     AND ${GAP_REPLY}
     AND q.question_key IS NOT NULL
     AND q.question_key <> ''`;

/**
 * One row per gap group, from `gap` (`GAP_ROWS`): its key, how often and when
 * it was last asked, and the answer document. Only asks after the group's
 * dismissal are counted and give its latest ask; a group with none is not
 * listed. Answers are read from every ask, dismissed or not, as any of them
 * may be where the owner wrote it. Like a dismissal, a written answer only
 * covers the asks before it: a group asked again after its newest answer is
 * open again, with no document, and counts as open everywhere.
 */
const GAP_GROUPS = `
  SELECT question_key, question_content, asked_at, question_id, times,
         no_content_times, declined_times,
         CASE WHEN group_answered_at >= asked_at THEN group_document_id END AS group_document_id
    FROM (
      SELECT question_key, question_content, asked_at, question_id, dismissed,
             ROW_NUMBER() OVER (
               PARTITION BY question_key
               ORDER BY dismissed ASC, asked_at DESC, question_rowid DESC
             ) AS rn,
             SUM(CASE WHEN dismissed THEN 0 ELSE 1 END) OVER (PARTITION BY question_key) AS times,
             SUM(CASE WHEN dismissed OR had_content THEN 0 ELSE 1 END)
               OVER (PARTITION BY question_key) AS no_content_times,
             SUM(CASE WHEN dismissed OR NOT had_content THEN 0 ELSE 1 END)
               OVER (PARTITION BY question_key) AS declined_times,
             MAX(answered_at) OVER (PARTITION BY question_key) AS group_answered_at,
             FIRST_VALUE(document_id) OVER (
               PARTITION BY question_key
               ORDER BY answered_at IS NULL, answered_at DESC, asked_at DESC, question_rowid DESC
             ) AS group_document_id
        FROM gap
    )
   WHERE rn = 1 AND NOT dismissed`;

/** The gap groups CTEs: `gap` rows, then `gap_group` rows. `?1` org, `?2` assistant. */
export const GAP_GROUP_CTES = `gap AS (${GAP_ROWS}), gap_group AS (${GAP_GROUPS})`;

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
  costMicros: row.cost_micros,
  answered: row.answered === 1,
  createdAt: row.created_at,
  replyTo: row.reply_to,
  firstTokenMs: row.first_token_ms ?? null,
  totalMs: row.total_ms ?? null,
  outcome: isAnswerOutcome(row.outcome) ? row.outcome : null,
  outcomeConfidence: row.outcome_confidence ?? null,
  citationsShown: row.citations_shown !== 0,
});

interface PendingRow extends Row {
  resume_context: string | null;
  resume_revision: number;
}

function parseResumeContextJson(raw: string | null): unknown | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function hasPendingCalls(toolCalls: unknown[] | null): boolean {
  if (!Array.isArray(toolCalls)) return false;
  return toolCalls.some(
    (call) =>
      typeof call === "object" && call !== null && (call as { pending?: unknown }).pending === true,
  );
}

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

    /**
     * The assistant reply a resume is continuing, scoped to one conversation.
     * Returns null unless it is in this org, in this conversation, and still has
     * pending calls — so a stale, foreign or already-finished id is indistinguishable
     * from an unknown one.
     */
    async getPendingReply(conversationId: string, id: string): Promise<PendingReplyRow | null> {
      const row = await prepare(
        db,
        `SELECT ${COLUMNS}, resume_context, resume_revision FROM messages
          WHERE org_id = ?1 AND id = ?2 AND conversation_id = ?3 AND role = 'assistant'`,
      )
        .bind(orgId, id, conversationId)
        .first<PendingRow>();
      if (!row) return null;
      const mapped = map(row);
      if (!hasPendingCalls(mapped.toolCalls)) return null;
      return {
        ...mapped,
        resumeContext: parseResumeContextJson(row.resume_context),
        resumeRevision: row.resume_revision,
      };
    },

    /**
     * Atomically claims a specific revision of a paused reply for one active
     * continuation. A stale lease older than `ttlMs` can be reclaimed so an
     * interrupted worker does not permanently strand the reply.
     */
    async claimPendingReply(params: {
      conversationId: string;
      id: string;
      claimToken: string;
      revision: number;
      now: number;
      ttlMs: number;
    }): Promise<boolean> {
      const res = await prepare(
        db,
        `UPDATE messages
            SET resume_claim = ?3,
                resume_claimed_at = ?4
          WHERE org_id = ?1
            AND id = ?2
            AND conversation_id = ?5
            AND role = 'assistant'
            AND resume_revision = ?6
            AND (resume_claim IS NULL OR resume_claimed_at <= ?7)`,
      )
        .bind(
          orgId,
          params.id,
          params.claimToken,
          params.now,
          params.conversationId,
          params.revision,
          params.now - params.ttlMs,
        )
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    /**
     * Extends an active, unexpired resume lease only if the caller still owns
     * the claimed revision. Returns false if the lease expired or was reclaimed.
     */
    async renewReplyClaim(params: {
      conversationId: string;
      id: string;
      claimToken: string;
      revision: number;
      now: number;
      ttlMs: number;
    }): Promise<boolean> {
      const res = await prepare(
        db,
        `UPDATE messages
            SET resume_claimed_at = ?3
          WHERE org_id = ?1
            AND id = ?2
            AND conversation_id = ?4
            AND role = 'assistant'
            AND resume_claim = ?5
            AND resume_revision = ?6
            AND resume_claimed_at > ?7`,
      )
        .bind(
          orgId,
          params.id,
          params.now,
          params.conversationId,
          params.claimToken,
          params.revision,
          params.now - params.ttlMs,
        )
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    /** Releases an active resume claim if the continuation fails before completing. */
    async releaseReplyClaim(id: string, claimToken: string): Promise<boolean> {
      const res = await prepare(
        db,
        `UPDATE messages
            SET resume_claim = NULL,
                resume_claimed_at = NULL
          WHERE org_id = ?1 AND id = ?2 AND resume_claim = ?3`,
      )
        .bind(orgId, id, claimToken)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    /**
     * Persists the next state of a resumed reply only if the caller still owns
     * the claimed revision, then releases the claim and advances the revision.
     */
    async completeReply(params: {
      id: string;
      claimToken: string;
      revision: number;
      content: string;
      citations: Citation[];
      toolCalls: unknown[];
      resumeContext: unknown | null;
      tokensIn: number;
      tokensOut: number;
      /** Added to the stored cost; null marks it unknown. Omitted leaves it as is. */
      costMicros?: number | null | undefined;
      /** Documents this continuation was given, added to those the pause recorded. */
      documentIds?: readonly string[] | undefined;
      /** Whether the visitor saw the citations of the completed reply. Left out means yes. */
      citationsShown?: boolean | undefined;
      /**
       * When this continuation saved the reply (`resumed_at`). The review
       * catch-up counts its wait from here, so it never takes a reply whose
       * live review this continuation is about to start.
       */
      now: number;
    }): Promise<boolean> {
      const update = prepare(
        db,
        `UPDATE messages
            SET content = ?3,
                citations = ?4,
                tool_calls = ?5,
                resume_context = ?6,
                search_text = ?12,
                tokens_in = tokens_in + ?7,
                tokens_out = tokens_out + ?8,
                cost_micros = cost_micros + ?11,
                resume_claim = NULL,
                resume_claimed_at = NULL,
                resume_revision = resume_revision + 1,
                resumed_at = ?13,
                citations_shown = ?14
          WHERE org_id = ?1
            AND id = ?2
            AND resume_claim = ?9
            AND resume_revision = ?10`,
      )
        // Token counts and cost accumulate: the pause and the resume are two model
        // calls on one message, and the owner's cost figure must include both.
        // SQL NULL arithmetic keeps an unknown cost unknown.
        .bind(
          orgId,
          params.id,
          params.content,
          JSON.stringify(params.citations),
          JSON.stringify(params.toolCalls),
          params.resumeContext == null ? null : JSON.stringify(params.resumeContext),
          params.tokensIn,
          params.tokensOut,
          params.claimToken,
          params.revision,
          params.costMicros === undefined ? 0 : params.costMicros,
          searchableText(params.content),
          params.now,
          params.citationsShown === false ? 0 : 1,
        );
      const documentIds = params.documentIds ?? [];
      if (documentIds.length === 0) {
        const res = await update.run();
        return (res.meta.changes ?? 0) > 0;
      }
      // Recorded first, in one transaction with the update and under the same
      // claim check, so a continuation that lost its claim records nothing.
      const [, res] = await db.batch([
        recordDocuments(
          db,
          `AND EXISTS (SELECT 1 FROM messages
                        WHERE org_id = ?1 AND id = ?2 AND role = 'assistant'
                          AND resume_claim = ?4 AND resume_revision = ?5)`,
        ).bind(
          orgId,
          params.id,
          JSON.stringify([...documentIds]),
          params.claimToken,
          params.revision,
        ),
        update,
      ]);
      return (res?.meta.changes ?? 0) > 0;
    },

    /**
     * Folds `search_text` for rows written before it existed. Migration 0019
     * folds plain ASCII text in SQL; the rest needs `searchableText`, which
     * SQL cannot reproduce. With `assistantId`, only that assistant's
     * messages are folded: its search needs no others, so it does not wait
     * for other assistants' history. A row a writer filled in the meantime is
     * left alone: every write of `content` also writes `search_text`, so a
     * non-NULL value is never older than the text (an older Worker's rewrite
     * of `content` alone is set back to NULL by migration 0019's trigger).
     * Each write also needs `content` to be what was read: an older Worker
     * can rewrite `content` alone between the read and the write, leaving
     * `search_text` NULL, and the fold of the old text must not land then.
     * Such a row stays NULL and is read again in the next round.
     * Each call folds a bounded number of rows: true means none are left,
     * false that some may be.
     */
    async fillSearchText(
      options: { assistantId?: string; batch?: number; rounds?: number } = {},
    ): Promise<boolean> {
      const batch = options.batch ?? SEARCH_FILL_BATCH;
      const rounds = options.rounds ?? SEARCH_FILL_ROUNDS;
      const update = prepare(
        db,
        `UPDATE messages SET search_text = ?3
          WHERE org_id = ?1 AND id = ?2 AND search_text IS NULL AND content = ?4`,
      );
      const assistantId = options.assistantId;
      const read = () =>
        assistantId === undefined
          ? prepare(
              db,
              "SELECT id, content FROM messages WHERE org_id = ?1 AND search_text IS NULL LIMIT ?2",
            ).bind(orgId, batch)
          : prepare(
              db,
              `SELECT m.id, m.content
                 FROM messages m
                 JOIN conversations c ON c.org_id = m.org_id AND c.id = m.conversation_id
                WHERE m.org_id = ?1 AND m.search_text IS NULL AND c.assistant_id = ?3
                LIMIT ?2`,
            ).bind(orgId, batch, assistantId);
      for (let round = 0; round < rounds; round++) {
        const pending = await read().all<{ id: string; content: string }>();
        if (pending.results.length === 0) return true;
        const written = await db.batch(
          pending.results.map((row) =>
            update.bind(orgId, row.id, searchableText(row.content), row.content),
          ),
        );
        // A row not written may still be NULL (its text changed since the
        // read), however short this round was: the next round reads again.
        const skipped = written.some((res) => (res.meta.changes ?? 0) === 0);
        if (pending.results.length < batch && !skipped) return true;
      }
      return false;
    },

    /** How many of an assistant's messages are still to be folded for search. */
    async searchTextPending(assistantId: string): Promise<number> {
      const row = await prepare(
        db,
        `SELECT COUNT(*) AS pending
           FROM messages m
           JOIN conversations c ON c.org_id = m.org_id AND c.id = m.conversation_id
          WHERE m.org_id = ?1 AND m.search_text IS NULL AND c.assistant_id = ?2`,
      )
        .bind(orgId, assistantId)
        .first<{ pending: number }>();
      return row?.pending ?? 0;
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
      const insert = prepareInsert(
        db,
        `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, cost_micros, answered, created_at, reply_to, question_key, resume_context, search_text, first_token_ms, total_ms, citations_shown)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
      ).bind(
        orgId,
        input.id,
        input.conversationId,
        input.role,
        input.content,
        JSON.stringify(input.citations),
        input.toolCalls === null ? null : JSON.stringify(input.toolCalls),
        input.tokensIn,
        input.tokensOut,
        input.costMicros ?? null,
        input.answered ? 1 : 0,
        input.createdAt,
        replyTo,
        questionKey,
        input.resumeContext == null ? null : JSON.stringify(input.resumeContext),
        searchableText(input.content),
        input.role === "assistant" ? (input.firstTokenMs ?? null) : null,
        input.role === "assistant" ? (input.totalMs ?? null) : null,
        input.role === "assistant" && input.citationsShown === false ? 0 : 1,
      );
      const documentIds = input.role === "assistant" ? (input.documentIds ?? []) : [];
      // One transaction: a reply is never stored without the record of what
      // it was given, which the Reports usage lists count.
      if (documentIds.length === 0) await insert.run();
      else {
        await db.batch([
          insert,
          recordDocuments(db).bind(orgId, input.id, JSON.stringify([...documentIds])),
        ]);
      }

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
        costMicros: input.costMicros ?? null,
        answered: input.answered,
        createdAt: input.createdAt,
        replyTo,
        firstTokenMs: input.role === "assistant" ? (input.firstTokenMs ?? null) : null,
        totalMs: input.role === "assistant" ? (input.totalMs ?? null) : null,
        outcome: null,
        outcomeConfidence: null,
        citationsShown: !(input.role === "assistant" && input.citationsShown === false),
      };
    },

    /**
     * Stores the answer review's decision on an assistant reply. Written once:
     * a reply that already has an outcome keeps it. False when nothing was
     * written (no such reply in this org, a visitor message, or already set).
     */
    async setOutcome(
      id: string,
      outcome: AnswerOutcome,
      confidence: number | null,
    ): Promise<boolean> {
      const res = await prepare(
        db,
        `UPDATE messages SET outcome = ?3, outcome_confidence = ?4
          WHERE org_id = ?1 AND id = ?2 AND role = 'assistant' AND outcome IS NULL`,
      )
        .bind(orgId, id, outcome, confidence)
        .run();
      return (res.meta.changes ?? 0) > 0;
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
      page: { limit: number; offset: number; openOnly?: boolean },
    ): Promise<{ groups: GapGroupRow[]; total: number }> {
      const openOnly = page.openOnly === true ? 1 : 0;
      const [rows, count] = await db.batch([
        prepare(
          db,
          `WITH ${GAP_GROUP_CTES}
           SELECT question_key, question_content, asked_at, question_id, times,
                  no_content_times, declined_times, group_document_id
             FROM gap_group
            WHERE (?5 = 0 OR group_document_id IS NULL)
            ORDER BY times DESC, asked_at DESC, question_id DESC
            LIMIT ?3 OFFSET ?4`,
        ).bind(orgId, assistantId, page.limit, page.offset, openOnly),
        prepare(
          db,
          `WITH ${GAP_GROUP_CTES}
           SELECT COUNT(*) AS total FROM gap_group WHERE (?3 = 0 OR group_document_id IS NULL)`,
        ).bind(orgId, assistantId, openOnly),
      ]);

      const groups = (
        (rows?.results ?? []) as Array<{
          question_key: string;
          question_content: string;
          asked_at: number;
          question_id: string;
          times: number;
          no_content_times: number;
          declined_times: number;
          group_document_id: string | null;
        }>
      ).map((r) => ({
        question: r.question_key,
        displayQuestion: r.question_content.trim(),
        times: r.times,
        noContentTimes: r.no_content_times,
        declinedTimes: r.declined_times,
        lastAsked: r.asked_at,
        exampleMessageId: r.question_id,
        documentId: r.group_document_id,
      }));
      const total = ((count?.results ?? []) as Array<{ total: number }>)[0]?.total ?? 0;
      return { groups, total };
    },

    /**
     * Hides a gap group until the question is asked again. `question` is the
     * normalised key the group is listed under.
     */
    async dismissGap(assistantId: string, question: string, at: number): Promise<void> {
      await prepareInsert(
        db,
        `INSERT INTO gap_dismissals (org_id, assistant_id, question_key, dismissed_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(org_id, assistant_id, question_key) DO UPDATE SET
           dismissed_at = excluded.dismissed_at`,
      )
        .bind(orgId, assistantId, question, at)
        .run();
    },

    /** Undoes `dismissGap`. True when there was a dismissal to remove. */
    async restoreGap(assistantId: string, question: string): Promise<boolean> {
      const res = await prepare(
        db,
        "DELETE FROM gap_dismissals WHERE org_id = ?1 AND assistant_id = ?2 AND question_key = ?3",
      )
        .bind(orgId, assistantId, question)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async linkGapAnswer(messageId: string, documentId: string, createdAt: number): Promise<void> {
      await prepareInsert(
        db,
        `INSERT INTO gap_answers (org_id, message_id, document_id, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(org_id, message_id) DO UPDATE SET
           document_id = excluded.document_id,
           created_at = excluded.created_at`,
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

/** An answer the review catch-up may take: its org as stored (to be vouched for) and its id. */
export interface ReviewCatchUpCandidate {
  claimedOrgId: string;
  messageId: string;
  /** When the reply was first written: the paging cursor. */
  createdAt: number;
}

/**
 * Visitor replies first written at or after `from`, and last written (by
 * the first request or by a page-action continuation, `resumed_at`) at or
 * before `to`, that still have no outcome and no review note on their trace
 * (no recorded failure, not taken by the catch-up), oldest first. Complete
 * replies only: a reply still waiting for page actions (`resume_context`
 * set) is not the answer yet. A continuation's completion is when the live
 * review starts, so a reply paused for long is judged by that, not by when
 * it was first written. "Try it" and test-run answers store no message, so
 * they are never here.
 *
 * Across orgs, like `dueSitemapSources`: this is the scheduler's own
 * discovery. Every row's org is checked with the auth seam before anything is
 * read or written for it, and that work goes through a `Tenant`. Each org is
 * read through its own `(org_id, role, created_at)` index range.
 *
 * `excludeOrgIds` leaves out orgs the seam refused earlier in the same tick,
 * and `after` starts past the last row already read, so one tick can page on
 * past an org whose replies would otherwise fill every page.
 */
export async function reviewCatchUpCandidates(
  db: D1Database,
  options: {
    from: number;
    to: number;
    limit: number;
    excludeOrgIds?: readonly string[] | undefined;
    after?: { createdAt: number; messageId: string } | undefined;
  },
): Promise<ReviewCatchUpCandidate[]> {
  const res = await db
    .prepare(
      `SELECT m.org_id AS org_id, m.id AS id, m.created_at AS created_at
         FROM orgs o
         JOIN messages m ON m.org_id = o.id AND m.role = 'assistant'
                        AND m.created_at >= ?1 AND m.created_at <= ?2
         LEFT JOIN message_traces t ON t.org_id = m.org_id AND t.message_id = m.id
        WHERE m.outcome IS NULL
          AND m.reply_to IS NOT NULL
          AND m.resume_context IS NULL
          AND (m.resumed_at IS NULL OR m.resumed_at <= ?2)
          AND (t.detail IS NULL
               OR CASE WHEN json_valid(t.detail)
                       THEN json_extract(t.detail, '$.review') IS NULL
                       ELSE 0 END)
          AND o.id NOT IN (SELECT value FROM json_each(?4))
          AND (?5 IS NULL OR m.created_at > ?5 OR (m.created_at = ?5 AND m.id > ?6))
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ?3`,
    )
    .bind(
      options.from,
      options.to,
      options.limit,
      JSON.stringify(options.excludeOrgIds ?? []),
      options.after?.createdAt ?? null,
      options.after?.messageId ?? "",
    )
    .all<{ org_id: string; id: string; created_at: number }>();
  return res.results.map((row) => ({
    claimedOrgId: row.org_id,
    messageId: row.id,
    createdAt: row.created_at,
  }));
}
