import { MAX_TOPICS_PER_ASSISTANT, type TopicReportRow } from "@solvchat/core";
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

/** A gap group with the topic of its latest tagged ask in the range, for "Most often unanswered". */
export interface GapQuestionCount extends QuestionCount {
  topic: { id: string; name: string } | null;
}

/**
 * Response-time aggregates for one range, straight from SQL. Percentiles are
 * whole milliseconds, NULL (here `null`) when no reply in the range was timed.
 */
export interface ReplyTimingRow {
  /** Assistant replies in the range, timed or not, not counting page-action replies. */
  replies: number;
  /** Replies in the range that used a page action, counted in nothing else here. */
  pageActionReplies: number;
  /** Of those, replies with a time to first token (written after migration 0022). */
  timed: number;
  firstTokenMedianMs: number | null;
  firstTokenP90Ms: number | null;
  totalMedianMs: number | null;
}

/**
 * A percentile of the `v` column of a ranked CTE (`i` the 0-based rank, `n`
 * the row count), computed in SQL by linear interpolation between the two
 * closest ranks: the same definition as a spreadsheet's PERCENTILE.INC (and
 * the median of an even count is the mean of the middle two). The position
 * `(n - 1) * p / 100` is split into its whole and hundredths parts in integer
 * arithmetic, so 0.9 is never a binary fraction. `percent` is a literal from
 * this module, never input.
 */
function percentileOf(ranked: string, percent: 50 | 90): string {
  const at = (rank: string) => `MAX(CASE WHEN i = ${rank} THEN v END)`;
  return `(SELECT CAST(ROUND(${at("lo")}
              + (COALESCE(${at("lo + 1")}, ${at("lo")}) - ${at("lo")}) * MAX(frac) / 100.0) AS INTEGER)
             FROM (SELECT v, i, ((n - 1) * ${percent}) / 100 AS lo,
                          ((n - 1) * ${percent}) % 100 AS frac
                     FROM ${ranked}))`;
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
  const reports = {
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
     * `declined` and `wants_human` 0. An `off_topic` reply is left out of
     * the share altogether (`answerable`, its denominator): an assistant that
     * rightly refuses a question about something else has not failed. A
     * reply with no outcome (before review existed, review switched off, or a
     * review that failed) counts as before: 1 when retrieval found content.
     * So old data reads exactly as it did. `replies` still counts every reply
     * (it is the thumbs-down share's denominator and the count shown).
     *
     * The thumbs-down count is `EXISTS`, not a join: a reply with three `down`
     * rows is one unhappy visitor's answer, not three.
     */
    async replyShares(
      assistantId: string,
      range: ReportRange,
    ): Promise<{ replies: number; answerable: number; answered: number; thumbsDown: number }> {
      const row = await prepare(
        db,
        `SELECT COUNT(*) AS replies,
                COALESCE(SUM(CASE WHEN m.outcome = 'off_topic' THEN 0 ELSE 1 END), 0) AS answerable,
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
        .first<{ replies: number; answerable: number; answered: number; thumbs_down: number }>();
      return {
        replies: row?.replies ?? 0,
        answerable: row?.answerable ?? 0,
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

    /**
     * How fast replies came, for the Response time figures: median and 90th
     * percentile of the time to first token, and the median total time.
     *
     * One statement, bounded like every other report query: the replies are
     * found through `messages_role_created (org_id, role, created_at)` and
     * the conversation's primary key (for the assistant), and only that
     * range's rows are sorted, so the cost follows the period's traffic, not
     * the assistant's history. Only stored replies are read, and only visitor
     * answers are stored: "Try it" previews and test runs write no message.
     * Replies written before the timings existed have NULL timings; they are
     * counted in `replies` but not in `timed` or any percentile.
     *
     * A reply that used a page action is left out of all of it and counted
     * on its own: it was stored when it paused for the action, with that
     * first request's times, and a continuation keeps them, so its total is
     * not the time to the complete answer, and an action-only first request
     * has no first token at all (which would read as a reply from before
     * timings). Such a reply is known by a `kind: "action"` entry in its
     * stored tool calls, kept once the call is resolved, or by a resume
     * having completed on it (`resume_revision`, raised only by a resume).
     */
    async replyTiming(assistantId: string, range: ReportRange): Promise<ReplyTimingRow> {
      const row = await prepare(
        db,
        `WITH replies AS MATERIALIZED (
           SELECT m.first_token_ms AS first_ms, m.total_ms AS total_ms,
                  -- A ladder, not OR: the tenancy guard refuses an OR beside the org filter.
                  CASE WHEN m.resume_revision > 0 THEN 1
                       WHEN m.tool_calls IS NULL THEN 0
                       WHEN json_valid(m.tool_calls) = 0 THEN 0
                       WHEN EXISTS (SELECT 1 FROM json_each(m.tool_calls)
                                     WHERE json_extract(value, '$.kind') = 'action') THEN 1
                       ELSE 0 END AS page_action
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
            WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.role = 'assistant'
              AND m.created_at >= ?3 AND m.created_at <= ?4
         ),
         first_ranked AS MATERIALIZED (
           SELECT first_ms AS v, ROW_NUMBER() OVER (ORDER BY first_ms) - 1 AS i, COUNT(*) OVER () AS n
             FROM replies WHERE page_action = 0 AND first_ms IS NOT NULL
         ),
         total_ranked AS MATERIALIZED (
           SELECT total_ms AS v, ROW_NUMBER() OVER (ORDER BY total_ms) - 1 AS i, COUNT(*) OVER () AS n
             FROM replies WHERE page_action = 0 AND total_ms IS NOT NULL
         )
         SELECT (SELECT COUNT(*) FROM replies WHERE page_action = 0) AS replies,
                (SELECT COUNT(*) FROM replies WHERE page_action = 1) AS page_action_replies,
                (SELECT COUNT(*) FROM first_ranked) AS timed,
                ${percentileOf("first_ranked", 50)} AS first_p50,
                ${percentileOf("first_ranked", 90)} AS first_p90,
                ${percentileOf("total_ranked", 50)} AS total_p50`,
      )
        .bind(orgId, assistantId, range.fromMs, range.toMs)
        .first<{
          replies: number;
          page_action_replies: number;
          timed: number;
          first_p50: number | null;
          first_p90: number | null;
          total_p50: number | null;
        }>();
      return {
        replies: row?.replies ?? 0,
        pageActionReplies: row?.page_action_replies ?? 0,
        timed: row?.timed ?? 0,
        firstTokenMedianMs: row?.first_p50 ?? null,
        firstTokenP90Ms: row?.first_p90 ?? null,
        totalMedianMs: row?.total_p50 ?? null,
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
     * stores. `unansweredOnly: true` gives the gaps list: questions with an
     * unanswered reply (reviewed as declined, or unreviewed with no content
     * found; not off topic or asking for a person), left out as the Gaps
     * screen leaves them out (asked
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
     * "Most often unanswered" with each group's topic: the topic of the
     * group's latest tagged ask in the range (asks of one question are
     * normally tagged alike; after a merge or a delete they may differ), or
     * null when none of them has one.
     */
    async topGaps(
      assistantId: string,
      range: ReportRange,
      limit: number = REPORT_TOP_LIMIT,
    ): Promise<GapQuestionCount[]> {
      const gaps = await reports.topQuestions(assistantId, range, { unansweredOnly: true, limit });
      if (gaps.length === 0) return [];
      // One lookup for every listed group, bounded by the list's length.
      const res = await prepare(
        db,
        `SELECT key, topic_id, name FROM (
           SELECT m.question_key AS key, t.id AS topic_id, t.name AS name,
                  ROW_NUMBER() OVER (PARTITION BY m.question_key
                                     ORDER BY m.created_at DESC, m.rowid DESC) AS n
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
             JOIN topics t ON t.id = m.topic_id AND t.org_id = m.org_id
                          AND t.assistant_id = c.assistant_id
            WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.role = 'user'
              AND m.created_at >= ?3 AND m.created_at <= ?4
              AND m.topic_id IS NOT NULL
              AND m.question_key IN (SELECT value FROM json_each(?5))
         ) WHERE n = 1`,
      )
        .bind(
          orgId,
          assistantId,
          range.fromMs,
          range.toMs,
          JSON.stringify(gaps.map((g) => g.question)),
        )
        .all<{ key: string; topic_id: string; name: string }>();
      const byKey = new Map(res.results.map((r) => [r.key, { id: r.topic_id, name: r.name }]));
      return gaps.map((g) => ({ ...g, topic: byKey.get(g.question) ?? null }));
    },

    /**
     * The Topics list: per topic, the period's visitor questions with it and
     * how many of those could not be answered (the reply reviewed as
     * `declined`, or unreviewed with no content found, as Gaps counts one),
     * most asked first. Read through `messages_org_topic`; at most every
     * topic of the assistant (`MAX_TOPICS_PER_ASSISTANT` and "Other").
     */
    async topicCounts(assistantId: string, range: ReportRange): Promise<TopicReportRow[]> {
      const res = await prepare(
        db,
        `SELECT t.id AS id, t.name AS name, COUNT(*) AS questions,
                COALESCE(SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM messages a
                   WHERE a.org_id = m.org_id AND a.reply_to = m.id AND a.role = 'assistant'
                     AND ${GAP_REPLY}
                ) THEN 1 ELSE 0 END), 0) AS unanswered
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
           JOIN topics t ON t.id = m.topic_id AND t.org_id = m.org_id
                        AND t.assistant_id = c.assistant_id
          WHERE m.org_id = ?1 AND c.assistant_id = ?2 AND m.role = 'user'
            AND m.topic_id IS NOT NULL
            AND m.created_at >= ?3 AND m.created_at <= ?4
          GROUP BY t.id, t.name
          ORDER BY questions DESC, t.name COLLATE NOCASE ASC, t.id ASC
          LIMIT ?5`,
      )
        .bind(orgId, assistantId, range.fromMs, range.toMs, MAX_TOPICS_PER_ASSISTANT + 1)
        .all<{ id: string; name: string; questions: number; unanswered: number }>();
      return res.results.map((row) => ({
        id: row.id,
        name: row.name,
        questions: row.questions,
        unanswered: row.unanswered,
        unansweredShare: row.questions === 0 ? 0 : row.unanswered / row.questions,
      }));
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
  return reports;
}
