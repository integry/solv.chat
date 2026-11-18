import { boundTrace, parseStoredTrace, type StoredTrace, type TracePart } from "../chat/trace.js";
import { prepare, prepareInsert } from "./sql.js";

/** Tenant-scoped data access for `message_traces`. */
export function tracesFor(db: D1Database, orgId: string) {
  const write = async (messageId: string, trace: StoredTrace, now: number): Promise<void> => {
    await prepareInsert(
      db,
      `INSERT INTO message_traces (org_id, message_id, detail, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(org_id, message_id) DO UPDATE SET
           detail = excluded.detail,
           updated_at = excluded.updated_at`,
    )
      .bind(orgId, messageId, JSON.stringify(trace), now)
      .run();
  };
  const get = async (messageId: string): Promise<StoredTrace | null> => {
    const row = await prepare(
      db,
      "SELECT detail FROM message_traces WHERE org_id = ?1 AND message_id = ?2",
    )
      .bind(orgId, messageId)
      .first<{ detail: string }>();
    return row ? parseStoredTrace(row.detail) : null;
  };
  return {
    get,

    /**
     * Writes the trace for a message's first request, replacing any there
     * was. The message must exist in this org: the foreign key refuses a
     * trace for anything else.
     */
    async put(messageId: string, part: TracePart, now: number): Promise<void> {
      await write(messageId, boundTrace({ v: 1, parts: [part] }), now);
    },

    /**
     * Adds a later request (a page-action resume) to a message's trace. A
     * message whose first trace write failed gets one with this part alone.
     */
    async append(messageId: string, part: TracePart, now: number): Promise<void> {
      const existing = await get(messageId);
      const trace = boundTrace(
        existing === null
          ? { v: 1, parts: [part], truncated: true }
          : { ...existing, parts: [...existing.parts, part] },
      );
      await write(messageId, trace, now);
    },
  };
}
