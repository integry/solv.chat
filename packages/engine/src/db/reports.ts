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
                COALESCE(SUM(CASE WHEN m.answered = 1 THEN 1 ELSE 0 END), 0) AS answered,
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
     * stores. `unansweredOnly: true` gives the gaps list, so the two share one
     * statement and cannot drift.
     */
    async topQuestions(
      assistantId: string,
      range: ReportRange,
      options: { unansweredOnly: boolean; limit?: number },
    ): Promise<QuestionCount[]> {
      const res = await prepare(
        db,
        `SELECT m.question_key AS question, COUNT(*) AS count, MAX(m.created_at) AS last_asked
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
          WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.role = 'user'
            AND m.created_at >= ?3 AND m.created_at <= ?4
            AND m.question_key IS NOT NULL AND m.question_key <> ''
            AND (?5 = 0 OR EXISTS (
              SELECT 1 FROM messages r
               WHERE r.org_id = m.org_id AND r.reply_to = m.id AND r.answered = 0
            ))
          GROUP BY m.question_key
          ORDER BY count DESC, last_asked DESC
          LIMIT ?6`,
      )
        .bind(
          orgId,
          assistantId,
          range.fromMs,
          range.toMs,
          options.unansweredOnly ? 1 : 0,
          options.limit ?? REPORT_TOP_LIMIT,
        )
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
