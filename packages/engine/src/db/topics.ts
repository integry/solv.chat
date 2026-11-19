import {
  MAX_TOPICS_PER_ASSISTANT,
  newId,
  OTHER_TOPIC,
  OTHER_TOPIC_KEY,
  type TopicItem,
  topicKey,
} from "@solvchat/core";
import { prepare, prepareInsert } from "./sql.js";

interface Row {
  id: string;
  name: string;
  created_at: number;
}

const map = (row: Row): TopicItem => ({ id: row.id, name: row.name, createdAt: row.created_at });

/** What a rename came to. */
export type RenameResult = "renamed" | "not_found" | "exists" | "full";

/**
 * Tenant-scoped data access for `topics` and the `topic_id` on visitor
 * questions. Every statement is bound to one org and names the assistant, so
 * a topic id from another assistant or org matches nothing.
 *
 * Names reaching here are already safe (`cleanTopicName` in
 * `@solvchat/core`); this module only stores, compares and counts them.
 */
export function topicsFor(db: D1Database, orgId: string) {
  async function byKey(assistantId: string, key: string): Promise<TopicItem | null> {
    const row = await prepare(
      db,
      `SELECT id, name, created_at FROM topics
        WHERE org_id = ?1 AND assistant_id = ?2 AND name_key = ?3`,
    )
      .bind(orgId, assistantId, key)
      .first<Row>();
    return row ? map(row) : null;
  }

  /**
   * One statement, so two reviews proposing the same new topic at once end
   * with one row: the second insert hits the unique key and does nothing, and
   * both read back the row that won. The cap is checked in the same
   * statement, so two new proposals at 39 topics cannot make 41. `Other`
   * (`exempt`) is outside the cap.
   */
  async function insert(
    assistantId: string,
    name: string,
    key: string,
    exempt: boolean,
    now: number,
  ): Promise<void> {
    await prepareInsert(
      db,
      `INSERT INTO topics (id, org_id, assistant_id, name, name_key, created_at)
       SELECT ?2, ?1, ?3, ?4, ?5, ?6
        WHERE ?7 = 1
           OR (SELECT COUNT(*) FROM topics
                WHERE org_id = ?1 AND assistant_id = ?3 AND name_key <> ?8) < ?9
       ON CONFLICT (org_id, assistant_id, name_key) DO NOTHING`,
    )
      .bind(
        orgId,
        newId("top"),
        assistantId,
        name,
        key,
        now,
        exempt ? 1 : 0,
        OTHER_TOPIC_KEY,
        MAX_TOPICS_PER_ASSISTANT,
      )
      .run();
  }

  return {
    /** Every topic of the assistant, by name. At most `MAX_TOPICS_PER_ASSISTANT` and "Other". */
    async list(assistantId: string): Promise<TopicItem[]> {
      const res = await prepare(
        db,
        `SELECT id, name, created_at FROM topics
          WHERE org_id = ?1 AND assistant_id = ?2
          ORDER BY name COLLATE NOCASE ASC, id ASC`,
      )
        .bind(orgId, assistantId)
        .all<Row>();
      return res.results.map(map);
    },

    async get(assistantId: string, id: string): Promise<TopicItem | null> {
      const row = await prepare(
        db,
        `SELECT id, name, created_at FROM topics
          WHERE org_id = ?1 AND assistant_id = ?2 AND id = ?3`,
      )
        .bind(orgId, assistantId, id)
        .first<Row>();
      return row ? map(row) : null;
    },

    /**
     * The topic a reviewed question gets for a safe `name`: the existing one
     * with that name, else a new one while the assistant has fewer than
     * `MAX_TOPICS_PER_ASSISTANT`, else "Other" (created on first use).
     */
    async resolve(assistantId: string, name: string, now: number = Date.now()): Promise<TopicItem> {
      const key = topicKey(name);
      const existing = await byKey(assistantId, key);
      if (existing) return existing;
      const other = key === OTHER_TOPIC_KEY;
      await insert(assistantId, other ? OTHER_TOPIC : name, key, other, now);
      const created = await byKey(assistantId, key);
      if (created) return created;
      // The list was full (or filled up meanwhile).
      await insert(assistantId, OTHER_TOPIC, OTHER_TOPIC_KEY, true, now);
      const fallback = await byKey(assistantId, OTHER_TOPIC_KEY);
      if (!fallback) throw new Error("topic could not be stored");
      return fallback;
    },

    /**
     * Tags one visitor question, once: a question that already has a topic
     * keeps it. The question must be in a conversation of the topic's
     * assistant, in this org.
     */
    async assignToQuestion(questionId: string, topicId: string): Promise<boolean> {
      const res = await prepare(
        db,
        `UPDATE messages SET topic_id = ?3
          WHERE org_id = ?1 AND id = ?2 AND role = 'user' AND topic_id IS NULL
            AND EXISTS (
              SELECT 1 FROM topics t
                JOIN conversations c ON c.org_id = t.org_id AND c.assistant_id = t.assistant_id
               WHERE t.org_id = ?1 AND t.id = ?3 AND c.id = messages.conversation_id
            )`,
      )
        .bind(orgId, questionId, topicId)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    /**
     * Takes the topic off a visitor question whose reply `replyId` was
     * reviewed as `off_topic`, or is being (no outcome yet). A reply with any
     * other outcome keeps its question's topic. In this org only.
     */
    async clearOffTopic(questionId: string, replyId: string): Promise<boolean> {
      const res = await prepare(
        db,
        `UPDATE messages SET topic_id = NULL
          WHERE org_id = ?1 AND id = ?2 AND role = 'user' AND topic_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM messages a
               WHERE a.org_id = ?1 AND a.id = ?3 AND a.reply_to = messages.id
                 AND a.role = 'assistant'
                 AND (a.outcome IS NULL OR a.outcome = 'off_topic')
            )`,
      )
        .bind(orgId, questionId, replyId)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    /**
     * Renames a topic. `exists` when another topic of the assistant already
     * has that name (merge it instead); a change of case or spacing only is a
     * rename of the same topic. `full` when the topic is "Other" and the new
     * name would make it an ordinary topic while the assistant already has
     * `MAX_TOPICS_PER_ASSISTANT`: "Other" is outside the cap, so renaming it
     * would otherwise grow the list past it. The count is checked in the same
     * statement as the write, like the insert's.
     */
    async rename(assistantId: string, id: string, name: string): Promise<RenameResult> {
      const key = topicKey(name);
      const clash = await byKey(assistantId, key);
      if (clash && clash.id !== id) return "exists";
      try {
        const res = await prepare(
          db,
          `UPDATE topics SET name = ?4, name_key = ?5
            WHERE org_id = ?1 AND assistant_id = ?2 AND id = ?3
              AND (name_key <> ?6 OR ?5 = ?6
                   OR (SELECT COUNT(*) FROM topics
                        WHERE org_id = ?1 AND assistant_id = ?2 AND name_key <> ?6) < ?7)`,
        )
          .bind(orgId, assistantId, id, name, key, OTHER_TOPIC_KEY, MAX_TOPICS_PER_ASSISTANT)
          .run();
        if ((res.meta.changes ?? 0) > 0) return "renamed";
        // Nothing changed: either the topic is gone, or it is "Other" and the
        // list is full.
        const current = await prepare(
          db,
          `SELECT name_key FROM topics WHERE org_id = ?1 AND assistant_id = ?2 AND id = ?3`,
        )
          .bind(orgId, assistantId, id)
          .first<{ name_key: string }>();
        return current?.name_key === OTHER_TOPIC_KEY ? "full" : "not_found";
      } catch (err) {
        // Another topic took the name between the check and the write.
        if (err instanceof Error && /UNIQUE/i.test(err.message)) return "exists";
        throw err;
      }
    },

    /**
     * Moves every question of `fromId` to `intoId` and deletes `fromId`, in
     * one batch (a D1 batch is one transaction). Both must be the assistant's.
     */
    async merge(assistantId: string, fromId: string, intoId: string): Promise<boolean> {
      const both = `EXISTS (SELECT 1 FROM topics f WHERE f.org_id = ?1 AND f.assistant_id = ?2 AND f.id = ?3)
        AND EXISTS (SELECT 1 FROM topics i WHERE i.org_id = ?1 AND i.assistant_id = ?2 AND i.id = ?4)`;
      const [, removed] = await db.batch([
        prepare(
          db,
          `UPDATE messages SET topic_id = ?4
            WHERE org_id = ?1 AND topic_id = ?3 AND ?3 <> ?4 AND ${both}`,
        ).bind(orgId, assistantId, fromId, intoId),
        prepare(
          db,
          `DELETE FROM topics
            WHERE org_id = ?1 AND assistant_id = ?2 AND id = ?3 AND ?3 <> ?4 AND ${both}`,
        ).bind(orgId, assistantId, fromId, intoId),
      ]);
      return (removed?.meta.changes ?? 0) > 0;
    },

    /** Deletes a topic; its questions become untagged. */
    async remove(assistantId: string, id: string): Promise<boolean> {
      const owned =
        "EXISTS (SELECT 1 FROM topics t WHERE t.org_id = ?1 AND t.assistant_id = ?2 AND t.id = ?3)";
      // Cleared explicitly as well as by the foreign key's ON DELETE SET NULL,
      // so the untagging is bound to this org like every other write.
      const [, removed] = await db.batch([
        prepare(
          db,
          `UPDATE messages SET topic_id = NULL WHERE org_id = ?1 AND topic_id = ?3 AND ${owned}`,
        ).bind(orgId, assistantId, id),
        prepare(db, "DELETE FROM topics WHERE org_id = ?1 AND assistant_id = ?2 AND id = ?3").bind(
          orgId,
          assistantId,
          id,
        ),
      ]);
      return (removed?.meta.changes ?? 0) > 0;
    },
  };
}
