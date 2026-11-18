import { GAP_GROUP_CTES, GAP_REPLY } from "./messages.js";
import { prepare } from "./sql.js";

/** Row caps. A report is a screen, not an export of everything. */
export const REPORT_TOP_LIMIT = 20;

export interface ReportRange {
  /** Inclusive UTC day, YYYY-MM-DD, for usage_daily. */
  fromDay: string;
  toDay: string;
  /** Inclusive millisecond bound for message and feedback rows. */
  fromMs: number;
  toMs: number;
}

export interface QuestionCount {
  question: string;
  count: number;
}

export interface SourceCitationCount {
  url: string;
  title: string;
  count: number;
}

/**
 * Tenant-scoped aggregates for the Reports screen.
 *
 * Every method is a single aggregate query bounded by the range and the caps:
 * a report must cost the same for an assistant with a year of traffic as for
 * one with a week, so no method returns unbounded rows and none counts in the
 * Worker.
 */
export function reportsFor(db: D1Database, orgId: string) {
  return {
    /** Visitor messages in the range. */
    async questionCount(assistantId: string, range: ReportRange): Promise<number> {
      const row = await prepare(
        db,
        `SELECT COUNT(*) AS total
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
          WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.role = 'user'
            AND m.created_at >= ?3 AND m.created_at <= ?4`,
      )
        .bind(orgId, assistantId, range.fromMs, range.toMs)
        .first<{ total: number }>();
      return row?.total ?? 0;
    },

    /**
     * Replies in the range, how many were answered, and how many got a thumbs
     * down — one query, so the three shares cannot be read from three
     * different instants.
     *
     * `answered` is a weighted count. A reviewed reply counts by its outcome:
     * `answered` 1, `partial` one half (it gave something, so counting it as
     * a miss would undersell it, and as a full answer would hide the hedge),
     * every other outcome 0. A reply with no outcome (before review existed,
     * review switched off, or a review that failed) counts as before: 1 when
     * retrieval found content. So old data reads exactly as it did.
     *
     * The thumbs-down count is `EXISTS`, not a join: a reply with three `down`
     * rows is one unhappy visitor's answer, not three.
     */
    async replyShares(
      assistantId: string,
      range: ReportRange,
    ): Promise<{ replies: number; answered: number; thumbsDown: number }> {
      const row = await prepare(
        db,
        `SELECT COUNT(*) AS replies,
                COALESCE(SUM(CASE
                  WHEN m.outcome IS NULL THEN CASE WHEN m.answered = 1 THEN 1.0 ELSE 0.0 END
                  WHEN m.outcome = 'answered' THEN 1.0
                  WHEN m.outcome = 'partial' THEN 0.5
                  ELSE 0.0 END), 0) AS answered,
                COALESCE(SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM feedback f
                   WHERE f.org_id = m.org_id AND f.message_id = m.id AND f.value = 'down'
                ) THEN 1 ELSE 0 END), 0) AS thumbs_down
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
          WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.role = 'assistant'
            AND m.created_at >= ?3 AND m.created_at <= ?4`,
      )
        .bind(orgId, assistantId, range.fromMs, range.toMs)
        .first<{ replies: number; answered: number; thumbs_down: number }>();
      return {
        replies: row?.replies ?? 0,
        answered: row?.answered ?? 0,
        thumbsDown: row?.thumbs_down ?? 0,
      };
    },

    /**
     * Visitor messages per UTC day in the range. Days with none are absent;
     * the caller fills them in, since it knows the range it asked for.
     */
    async questionsPerDay(
      assistantId: string,
      range: ReportRange,
    ): Promise<Array<{ day: string; questions: number }>> {
      const res = await prepare(
        db,
        `SELECT strftime('%Y-%m-%d', m.created_at / 1000, 'unixepoch') AS day, COUNT(*) AS questions
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
          WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.role = 'user'
            AND m.created_at >= ?3 AND m.created_at <= ?4
          GROUP BY day
          ORDER BY day ASC`,
      )
        .bind(orgId, assistantId, range.fromMs, range.toMs)
        .all<{ day: string; questions: number }>();
      return res.results.map((row) => ({ day: row.day, questions: row.questions }));
    },

    /** Cost over the range's days, from what the UsageSink recorded. */
    async costMicros(assistantId: string, range: ReportRange): Promise<number> {
      const row = await prepare(
        db,
        `SELECT COALESCE(SUM(cost_micros), 0) AS total
           FROM usage_daily
          WHERE org_id = ?1 AND assistant_id = ?2 AND day >= ?3 AND day <= ?4`,
      )
        .bind(orgId, assistantId, range.fromDay, range.toDay)
        .first<{ total: number }>();
      return row?.total ?? 0;
    },

    /**
     * Most asked questions, grouped by the normalised key the chat pipeline
     * stores. `unansweredOnly: true` gives the gaps list: questions with an
     * unanswered reply (no content found, or reviewed as declined), left out as the Gaps screen leaves them out (asked
     * before the group was dismissed, or a group with a written answer newer
     * than its latest ask), so each row is one the Gaps screen lists.
     */
    async topQuestions(
      assistantId: string,
      range: ReportRange,
      options: { unansweredOnly: boolean; limit?: number },
    ): Promise<QuestionCount[]> {
      const asked = `
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
          WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.role = 'user'
            AND m.created_at >= ?3 AND m.created_at <= ?4
            AND m.question_key IS NOT NULL AND m.question_key <> ''`;
      const grouped = `
          GROUP BY m.question_key
          ORDER BY count DESC, last_asked DESC
          LIMIT ?5`;
      const select =
        "SELECT m.question_key AS question, COUNT(*) AS count, MAX(m.created_at) AS last_asked";
      const sql = options.unansweredOnly
        ? `WITH ${GAP_GROUP_CTES}
           ${select} ${asked}
            AND EXISTS (
              SELECT 1 FROM messages a
               WHERE a.org_id = m.org_id AND a.reply_to = m.id AND a.role = 'assistant'
                 AND ${GAP_REPLY}
            )
            AND NOT EXISTS (
              SELECT 1 FROM gap_dismissals gd
               WHERE gd.org_id = m.org_id AND gd.assistant_id = c.assistant_id
                 AND gd.question_key = m.question_key AND gd.dismissed_at >= m.created_at
            )
            AND m.question_key IN (
              SELECT question_key FROM gap_group WHERE group_document_id IS NULL
            ) ${grouped}`
        : `${select} ${asked} ${grouped}`;
      const res = await prepare(db, sql)
        .bind(orgId, assistantId, range.fromMs, range.toMs, options.limit ?? REPORT_TOP_LIMIT)
        .all<{ question: string; count: number }>();
      return res.results.map((row) => ({ question: row.question, count: row.count }));
    },

    /**
     * Most cited pages. `citations` is a JSON array on each reply, so the count
     * comes from `json_each`; grouping by `(message_id, url)` means a reply
     * that cited one page twice counts once, whatever the pipeline does in
     * future.
     */
    async topSources(
      assistantId: string,
      range: ReportRange,
      limit = REPORT_TOP_LIMIT,
    ): Promise<SourceCitationCount[]> {
      const res = await prepare(
        db,
        `SELECT url, MAX(title) AS title, COUNT(*) AS count FROM (
           SELECT m.id AS message_id,
                  json_extract(citation.value, '$.url') AS url,
                  MAX(json_extract(citation.value, '$.title')) AS title
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id,
                  json_each(m.citations) AS citation
            WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.role = 'assistant'
              AND m.created_at >= ?3 AND m.created_at <= ?4
              AND json_valid(m.citations)
              AND json_extract(citation.value, '$.url') IS NOT NULL
            GROUP BY m.id, url
         )
         GROUP BY url
         ORDER BY count DESC, url ASC
         LIMIT ?5`,
      )
        .bind(orgId, assistantId, range.fromMs, range.toMs, limit)
        .all<{ url: string; title: string | null; count: number }>();
      return res.results.map((row) => ({
        url: row.url,
        title: row.title ?? row.url,
        count: row.count,
      }));
    },

    /**
     * Pages that were never cited in the range, with the total so the screen
     * can say how many more there are. "Your content is being used" and "847
     * pages have never been used" are different answers, and the second is the
     * one an owner can act on.
     */
    async uncitedSources(
      assistantId: string,
      range: ReportRange,
      limit = REPORT_TOP_LIMIT,
    ): Promise<{ documents: Array<{ url: string; title: string }>; total: number }> {
      const where = `
        FROM documents d
        JOIN sources s ON s.id = d.source_id AND s.org_id = d.org_id
       WHERE d.org_id = ?1 AND s.assistant_id = ?2
         AND d.url NOT IN (
           SELECT json_extract(citation.value, '$.url')
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id,
                  json_each(m.citations) AS citation
            WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.role = 'assistant'
              AND m.created_at >= ?3 AND m.created_at <= ?4
              AND json_valid(m.citations)
              AND json_extract(citation.value, '$.url') IS NOT NULL
         )`;
      const [rows, count] = await db.batch([
        prepare(db, `SELECT d.url, d.title ${where} ORDER BY d.updated_at DESC LIMIT ?5`).bind(
          orgId,
          assistantId,
          range.fromMs,
          range.toMs,
          limit,
        ),
        prepare(db, `SELECT COUNT(*) AS total ${where}`).bind(
          orgId,
          assistantId,
          range.fromMs,
          range.toMs,
        ),
      ]);
      return {
        documents: ((rows?.results ?? []) as Array<{ url: string; title: string }>).map((row) => ({
          url: row.url,
          title: row.title,
        })),
        total: ((count?.results ?? []) as Array<{ total: number }>)[0]?.total ?? 0,
      };
    },
  };
}
